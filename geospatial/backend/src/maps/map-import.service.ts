import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createReadStream } from 'fs';
import { access, copyFile, mkdir, rename, stat, unlink } from 'fs/promises';
import { basename, extname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import sax from 'sax';
import unzipper from 'unzipper';
import { DatabaseService } from '../database/database.service';
import { mapFeatures, mapFolders, maps, nodes } from '../database/schemas';
import { GraphHopperRoutingService } from './graphhopper-routing.service';

const FOLDER_BATCH_SIZE = 500;
const FEATURE_BATCH_SIZE = 500;
const IMPORTED_SOURCE_STORAGE_DIRECTORY = resolve(
  process.cwd(),
  '.data',
  'imported-map-sources',
);

type SourceKind = 'kmz_archive' | 'kml_file' | 'extracted_kmz_directory';
type GeometryKind =
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPoint'
  | 'MultiLineString'
  | 'MultiPolygon'
  | 'GeometryCollection';

type ImportSource = {
  originalPath: string;
  originalFilename: string;
  storedFilename: string;
  sourceKind: SourceKind;
  mimeType: string;
  fileSizeBytes: number;
  sourceDocumentPath: string;
  openStream: () => Readable;
};

type ImportOptions = {
  autoRoute: boolean;
};

export type Coordinate = [number, number];

export type OriginalLineGeometry =
  | {
      type: 'LineString';
      coordinates: Coordinate[];
    }
  | {
      type: 'MultiLineString';
      coordinates: Coordinate[][];
    };

export type UploadedMapFile = {
  path: string;
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

function isCrossDeviceRenameError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EXDEV'
  );
}

export async function moveUploadedFile(
  sourcePath: string,
  destinationPath: string,
) {
  try {
    await rename(sourcePath, destinationPath);
    return;
  } catch (error) {
    if (!isCrossDeviceRenameError(error)) {
      throw error;
    }
  }

  await copyFile(sourcePath, destinationPath);
  await unlink(sourcePath);
}

type FolderState = {
  id: string;
  mapId: string;
  parentId: string | null;
  name: string;
  sourcePath: string;
  displayPath: string;
  depth: number;
  sortOrder: number;
  isOpenByDefault: boolean;
  childFolderCount: number;
  descendantFolderCount: number;
  directFeatureCount: number;
  descendantFeatureCount: number;
  nextChildFolderSort: number;
  nextFeatureSort: number;
};

type GeometryAccumulator =
  | { kind: 'Point'; coordinatesText: string }
  | { kind: 'LineString'; coordinatesText: string }
  | {
      kind: 'Polygon';
      outerCoordinatesText: string;
      innerCoordinatesTexts: string[];
      activeBoundary: 'outer' | 'inner' | null;
    };

type PlacemarkState = {
  id: string;
  sourceFeatureId: string | null;
  name: string;
  description: string | null;
  visibility: boolean;
  styleUrl: string | null;
  sourcePath: string;
  sortOrder: number;
  folderId: string;
  folderLineage: FolderState[];
  extendedData: Record<string, unknown>;
  lookAt: Record<string, string>;
  geometries: GeometryAccumulator[];
  currentDataName: string | null;
  currentSimpleDataName: string | null;
};

export type FinalGeometry = {
  geometryType: GeometryKind;
  ewkt: string;
  originalLineGeometry?: OriginalLineGeometry;
};

type ImportedFeatureGeometry = {
  geometry: FinalGeometry | null;
  nameSuffix?: string;
  rawProperties: Record<string, unknown>;
};

type ImportStats = {
  folderCount: number;
  featureCount: number;
  pointCount: number;
  lineStringCount: number;
  polygonCount: number;
  nodeCount: number;
};

function normalizeTagName(name: string) {
  return name.split(':').at(-1)?.toLowerCase() ?? name.toLowerCase();
}

function parseCoordinateList(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [lngText, latText, altitudeText] = item.split(',');
      const lng = Number(lngText);
      const lat = Number(latText);
      const altitude =
        altitudeText === undefined || altitudeText === ''
          ? undefined
          : Number(altitudeText);

      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        throw new BadRequestException(`Invalid KML coordinate tuple: ${item}`);
      }

      return {
        lng,
        lat,
        altitude: Number.isFinite(altitude) ? altitude : undefined,
      };
    });
}

function closeRingIfNeeded(points: ReturnType<typeof parseCoordinateList>) {
  if (points.length === 0) {
    return points;
  }

  const first = points[0];
  const last = points[points.length - 1];

  if (first.lng === last.lng && first.lat === last.lat) {
    return points;
  }

  return [...points, first];
}

function coordinatesToWkt(points: ReturnType<typeof parseCoordinateList>) {
  return points.map((point) => `${point.lng} ${point.lat}`).join(', ');
}

function coordinatesToGeoJson(points: ReturnType<typeof parseCoordinateList>) {
  return points.map((point) => [point.lng, point.lat] satisfies Coordinate);
}

function coordinateTuplesToWkt(points: Coordinate[]) {
  return points.map(([lng, lat]) => `${lng} ${lat}`).join(', ');
}

function lineStringEwkt(points: Coordinate[]) {
  return `SRID=4326;LINESTRING(${coordinateTuplesToWkt(points)})`;
}

function finalizeGeometry(
  geometries: GeometryAccumulator[],
): FinalGeometry | null {
  if (geometries.length === 0) {
    return null;
  }

  const pointGeometries = geometries.filter(
    (geometry): geometry is Extract<GeometryAccumulator, { kind: 'Point' }> =>
      geometry.kind === 'Point',
  );
  const lineGeometries = geometries.filter(
    (
      geometry,
    ): geometry is Extract<GeometryAccumulator, { kind: 'LineString' }> =>
      geometry.kind === 'LineString',
  );
  const polygonGeometries = geometries.filter(
    (geometry): geometry is Extract<GeometryAccumulator, { kind: 'Polygon' }> =>
      geometry.kind === 'Polygon',
  );

  if (pointGeometries.length === geometries.length) {
    const points = pointGeometries.map((geometry) =>
      parseCoordinateList(geometry.coordinatesText),
    );
    if (points.some((group) => group.length === 0)) {
      return null;
    }

    if (points.length === 1) {
      return {
        geometryType: 'Point',
        ewkt: `SRID=4326;POINT(${coordinatesToWkt(points[0].slice(0, 1))})`,
      };
    }

    return {
      geometryType: 'MultiPoint',
      ewkt: `SRID=4326;MULTIPOINT(${points
        .map((group) => `(${coordinatesToWkt(group.slice(0, 1))})`)
        .join(', ')})`,
    };
  }

  if (lineGeometries.length === geometries.length) {
    const lines = lineGeometries.map((geometry) =>
      parseCoordinateList(geometry.coordinatesText),
    );
    if (lines.some((group) => group.length < 2)) {
      return null;
    }

    if (lines.length === 1) {
      return {
        geometryType: 'LineString',
        ewkt: `SRID=4326;LINESTRING(${coordinatesToWkt(lines[0])})`,
        originalLineGeometry: {
          type: 'LineString',
          coordinates: coordinatesToGeoJson(lines[0]),
        },
      };
    }

    return {
      geometryType: 'MultiLineString',
      ewkt: `SRID=4326;MULTILINESTRING(${lines
        .map((group) => `(${coordinatesToWkt(group)})`)
        .join(', ')})`,
      originalLineGeometry: {
        type: 'MultiLineString',
        coordinates: lines.map((line) => coordinatesToGeoJson(line)),
      },
    };
  }

  if (polygonGeometries.length === geometries.length) {
    const polygons = polygonGeometries.map((geometry) => {
      const outerRing = closeRingIfNeeded(
        parseCoordinateList(geometry.outerCoordinatesText),
      );
      const innerRings = geometry.innerCoordinatesTexts.map((ring) =>
        closeRingIfNeeded(parseCoordinateList(ring)),
      );

      if (outerRing.length < 4) {
        return null;
      }

      return [outerRing, ...innerRings]
        .map((ring) => `(${coordinatesToWkt(ring)})`)
        .join(', ');
    });

    if (polygons.some((polygon) => polygon === null)) {
      return null;
    }

    if (polygons.length === 1) {
      return {
        geometryType: 'Polygon',
        ewkt: `SRID=4326;POLYGON(${polygons[0]})`,
      };
    }

    return {
      geometryType: 'MultiPolygon',
      ewkt: `SRID=4326;MULTIPOLYGON(${polygons.map((polygon) => `(${polygon})`).join(', ')})`,
    };
  }

  const collection = geometries
    .map((geometry) =>
      finalizeGeometry([geometry])?.ewkt.replace(/^SRID=4326;/, ''),
    )
    .filter((geometry): geometry is string => Boolean(geometry));

  if (collection.length === 0) {
    return null;
  }

  return {
    geometryType: 'GeometryCollection',
    ewkt: `SRID=4326;GEOMETRYCOLLECTION(${collection.join(', ')})`,
  };
}

function inferCounts(stats: ImportStats, geometryType: GeometryKind | null) {
  if (!geometryType) {
    return;
  }

  if (geometryType === 'Point' || geometryType === 'MultiPoint') {
    stats.pointCount += 1;
    return;
  }

  if (geometryType === 'LineString' || geometryType === 'MultiLineString') {
    stats.lineStringCount += 1;
    return;
  }

  if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
    stats.polygonCount += 1;
  }
}

function validLineCoordinates(coordinates: Coordinate[]) {
  return (
    coordinates.length >= 2 &&
    coordinates.every(
      ([lng, lat]) =>
        Number.isFinite(lng) &&
        lng >= -180 &&
        lng <= 180 &&
        Number.isFinite(lat) &&
        lat >= -90 &&
        lat <= 90,
    )
  );
}

function routeErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Imported line auto-routing failed.';
}

function routeBaseProperties(originalGeometry: OriginalLineGeometry) {
  return {
    routeMode: 'import-auto-routed',
    originalGeometry,
    originalGeometryPreserved: true,
  } satisfies Record<string, unknown>;
}

function sourceDefinedBaseProperties() {
  return {
    routeMode: 'import-source-defined',
    routeStatus: 'source',
  } satisfies Record<string, unknown>;
}

function importedFeatureSlotCount(geometry: FinalGeometry | null) {
  const originalGeometry = geometry?.originalLineGeometry;

  if (!originalGeometry) {
    return 1;
  }

  if (originalGeometry.type === 'LineString') {
    return Math.max(1, originalGeometry.coordinates.length - 1);
  }

  return Math.max(
    1,
    originalGeometry.coordinates.reduce(
      (total, coordinates) => total + Math.max(0, coordinates.length - 1),
      0,
    ),
  );
}

function sourceDefinedRouteSegmentFeatures(
  geometry: FinalGeometry,
): ImportedFeatureGeometry[] {
  const originalGeometry = geometry.originalLineGeometry;

  if (!originalGeometry) {
    return [{ geometry, rawProperties: {} }];
  }

  const rawProperties = sourceDefinedBaseProperties();

  if (originalGeometry.type === 'LineString') {
    const segments = originalGeometry.coordinates.slice(0, -1).map(
      (from, segmentIndex) =>
        ({
          geometry: {
            geometryType: 'LineString',
            ewkt: lineStringEwkt([
              from,
              originalGeometry.coordinates[segmentIndex + 1],
            ]),
            originalLineGeometry: {
              type: 'LineString',
              coordinates: [
                from,
                originalGeometry.coordinates[segmentIndex + 1],
              ],
            },
          },
          nameSuffix:
            originalGeometry.coordinates.length > 2
              ? `Segment ${segmentIndex + 1}`
              : undefined,
          rawProperties,
        }) satisfies ImportedFeatureGeometry,
    );

    return segments.length > 0 ? segments : [{ geometry, rawProperties }];
  }

  const segments: ImportedFeatureGeometry[] = [];
  const segmentCount = originalGeometry.coordinates.reduce(
    (total, coordinates) => total + Math.max(0, coordinates.length - 1),
    0,
  );

  for (const coordinates of originalGeometry.coordinates) {
    for (const [segmentIndex, from] of coordinates.slice(0, -1).entries()) {
      const to = coordinates[segmentIndex + 1];
      segments.push({
        geometry: {
          geometryType: 'LineString',
          ewkt: lineStringEwkt([from, to]),
          originalLineGeometry: {
            type: 'LineString',
            coordinates: [from, to],
          },
        },
        nameSuffix:
          segmentCount > 1 ? `Segment ${segments.length + 1}` : undefined,
        rawProperties,
      });
    }
  }

  return segments.length > 0 ? segments : [{ geometry, rawProperties }];
}

export async function routeImportedLineFeatures(
  geometry: FinalGeometry | null,
  router: GraphHopperRoutingService,
  autoRoute = true,
): Promise<ImportedFeatureGeometry[]> {
  if (!geometry?.originalLineGeometry) {
    return [{ geometry, rawProperties: {} }];
  }

  if (!autoRoute) {
    return sourceDefinedRouteSegmentFeatures(geometry);
  }

  const originalGeometry = geometry.originalLineGeometry;
  const baseProperties = routeBaseProperties(originalGeometry);

  try {
    if (originalGeometry.type === 'LineString') {
      const route = await router.routeLineSegments(
        originalGeometry.coordinates,
      );

      return route.segments.map((segment) => {
        if (!validLineCoordinates(segment.geometry.coordinates)) {
          throw new Error(
            `Imported line auto-routing returned invalid geometry for segment ${segment.segmentIndex + 1}.`,
          );
        }

        return {
          geometry: {
            geometryType: 'LineString',
            ewkt: lineStringEwkt(segment.geometry.coordinates),
            originalLineGeometry: {
              type: 'LineString',
              coordinates: [segment.from, segment.to],
            },
          },
          nameSuffix:
            route.segments.length > 1
              ? `Segment ${segment.segmentIndex + 1}`
              : undefined,
          rawProperties: {
            ...baseProperties,
            routeProvider: segment.provider ?? 'graphhopper',
            routeCosting: segment.costing,
            routeStatus: segment.routeStatus,
            routeFallbackUsed: segment.fallbackUsed,
            routeWarnings: segment.warnings ?? [],
            routeSegmentCount: route.segments.length,
            routeSegmentIndex: segment.segmentIndex,
            routeSegmentFrom: segment.from,
            routeSegmentTo: segment.to,
            ...(segment.routeError ? { routeError: segment.routeError } : {}),
            ...(Number.isFinite(segment.distanceMeters)
              ? { routeDistanceMeters: Math.round(segment.distanceMeters ?? 0) }
              : {}),
            ...(Number.isFinite(segment.durationSeconds)
              ? {
                  routeDurationSeconds: Math.round(
                    segment.durationSeconds ?? 0,
                  ),
                }
              : {}),
          },
        } satisfies ImportedFeatureGeometry;
      });
    }

    const routedFeatures: ImportedFeatureGeometry[] = [];
    const segmentCount = originalGeometry.coordinates.reduce(
      (total, coordinates) => total + Math.max(0, coordinates.length - 1),
      0,
    );
    let segmentOffset = 0;

    for (const [
      lineIndex,
      coordinates,
    ] of originalGeometry.coordinates.entries()) {
      const route = await router.routeLineSegments(coordinates);

      for (const segment of route.segments) {
        if (!validLineCoordinates(segment.geometry.coordinates)) {
          throw new Error(
            `Imported line auto-routing returned invalid geometry for line ${lineIndex + 1}, segment ${segment.segmentIndex + 1}.`,
          );
        }

        const segmentIndex = segmentOffset + segment.segmentIndex;
        routedFeatures.push({
          geometry: {
            geometryType: 'LineString',
            ewkt: lineStringEwkt(segment.geometry.coordinates),
            originalLineGeometry: {
              type: 'LineString',
              coordinates: [segment.from, segment.to],
            },
          },
          nameSuffix:
            segmentCount > 1 ? `Segment ${segmentIndex + 1}` : undefined,
          rawProperties: {
            ...baseProperties,
            routeProvider: segment.provider ?? 'graphhopper',
            routeCosting: segment.costing,
            routeStatus: segment.routeStatus,
            routeFallbackUsed: segment.fallbackUsed,
            routeWarnings: segment.warnings ?? [],
            routeLineIndex: lineIndex,
            routeSegmentCount: segmentCount,
            routeSegmentIndex: segmentIndex,
            routeSegmentFrom: segment.from,
            routeSegmentTo: segment.to,
            ...(segment.routeError ? { routeError: segment.routeError } : {}),
            ...(Number.isFinite(segment.distanceMeters)
              ? { routeDistanceMeters: Math.round(segment.distanceMeters ?? 0) }
              : {}),
            ...(Number.isFinite(segment.durationSeconds)
              ? {
                  routeDurationSeconds: Math.round(
                    segment.durationSeconds ?? 0,
                  ),
                }
              : {}),
          },
        });
      }

      segmentOffset += Math.max(0, coordinates.length - 1);
    }

    return routedFeatures;
  } catch (error) {
    const routeError = routeErrorMessage(error);
    return [
      {
        geometry,
        rawProperties: {
          ...baseProperties,
          routeProvider: 'graphhopper',
          routeStatus: 'failed',
          routeError,
          routeWarnings: ['Auto route failed; original geometry was kept.'],
        },
      },
    ];
  }
}

export async function routeImportedLineGeometry(
  geometry: FinalGeometry | null,
  router: GraphHopperRoutingService,
  autoRoute = true,
): Promise<{
  geometry: FinalGeometry | null;
  rawProperties: Record<string, unknown>;
}> {
  const [feature] = await routeImportedLineFeatures(
    geometry,
    router,
    autoRoute,
  );

  return feature ?? { geometry, rawProperties: {} };
}

@Injectable()
export class MapImportService {
  private readonly logger = new Logger(MapImportService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly graphHopperRoutingService: GraphHopperRoutingService,
  ) {}

  async importBootstrapSource(
    filePath: string,
    name?: string,
    uploadedByUserId?: string | null,
    options: ImportOptions = { autoRoute: true },
  ) {
    const source = await this.resolveSource(filePath);
    const mapName =
      name?.trim() ||
      basename(
        source.originalFilename,
        extname(source.originalFilename),
      ).replace(/[-_]+/g, ' ');

    const [mapRecord] = await this.databaseService.db
      .insert(maps)
      .values({
        name: mapName,
        originalFilename: source.originalFilename,
        storedFilename: source.storedFilename,
        storagePath: source.originalPath.replace(/\\/g, '/'),
        mimeType: source.mimeType,
        sourceKind: source.sourceKind,
        sourceDocumentPath: source.sourceDocumentPath.replace(/\\/g, '/'),
        fileSizeBytes: source.fileSizeBytes,
        uploadedByUserId: uploadedByUserId ?? null,
        importStatus: 'queued',
      })
      .returning();

    try {
      await this.databaseService.db
        .update(maps)
        .set({
          importStatus: 'parsing',
          importError: null,
        })
        .where(eq(maps.id, mapRecord.id));

      const importSummary = await this.parseIntoDatabase(
        mapRecord.id,
        mapName,
        source,
        options,
      );

      await this.databaseService.client`
        UPDATE maps
        SET
          import_status = 'imported',
          import_error = NULL,
          catalog_root_name = ${importSummary.catalogRootName},
          folder_count = ${importSummary.stats.folderCount},
          feature_count = ${importSummary.stats.featureCount},
          point_count = ${importSummary.stats.pointCount},
          line_string_count = ${importSummary.stats.lineStringCount},
          polygon_count = ${importSummary.stats.polygonCount},
          node_count = ${importSummary.stats.nodeCount},
          footprint = (
            SELECT CASE
              WHEN ST_Extent(geom) IS NULL THEN NULL
              ELSE ST_Multi(ST_Envelope(ST_Extent(geom)::geometry))
            END
            FROM map_features
            WHERE map_id = ${mapRecord.id} AND geom IS NOT NULL
          ),
          updated_at = NOW()
        WHERE id = ${mapRecord.id}
      `;

      const [importedMap] = await this.databaseService.db
        .select()
        .from(maps)
        .where(eq(maps.id, mapRecord.id))
        .limit(1);

      return {
        message: 'Bootstrap KML source imported.',
        map: importedMap,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown KML import failure.';

      this.logger.error(
        `KML import failed for ${source.originalPath}`,
        errorMessage,
      );

      await this.databaseService.db
        .update(maps)
        .set({
          importStatus: 'failed',
          importError: errorMessage,
        })
        .where(eq(maps.id, mapRecord.id));

      throw error;
    }
  }

  async importUploadedSource(
    file: UploadedMapFile,
    name?: string,
    uploadedByUserId?: string | null,
    autoRoute = true,
  ) {
    if (!file?.path || !file.originalname) {
      throw new BadRequestException('A KML file upload is required.');
    }

    const originalFilename = basename(file.originalname).trim();
    if (!originalFilename) {
      throw new BadRequestException('Uploaded file name is invalid.');
    }

    const extension = extname(originalFilename).toLowerCase();
    if (extension !== '.kml') {
      throw new BadRequestException('Only a .kml file can be uploaded.');
    }

    const uploadedPath = resolve(file.path);
    const importDirectory = join(
      IMPORTED_SOURCE_STORAGE_DIRECTORY,
      randomUUID(),
    );
    const preservedUploadPath = join(importDirectory, originalFilename);

    await mkdir(importDirectory, { recursive: true });
    await moveUploadedFile(uploadedPath, preservedUploadPath);
    return this.importBootstrapSource(
      preservedUploadPath,
      name,
      uploadedByUserId,
      { autoRoute },
    );
  }

  private async resolveSource(filePath: string): Promise<ImportSource> {
    const resolvedPath = resolve(process.cwd(), filePath);
    await access(resolvedPath);
    const sourceStats = await stat(resolvedPath);

    if (sourceStats.isDirectory()) {
      const documentPath = join(resolvedPath, 'doc.kml');
      const documentStats = await stat(documentPath);

      return {
        originalPath: resolvedPath,
        originalFilename: basename(resolvedPath),
        storedFilename: basename(resolvedPath),
        sourceKind: 'extracted_kmz_directory',
        mimeType: 'application/vnd.google-earth.kml+xml',
        fileSizeBytes: Number(documentStats.size),
        sourceDocumentPath: documentPath,
        openStream: () => createReadStream(documentPath),
      };
    }

    const extension = extname(resolvedPath).toLowerCase();
    if (extension === '.kml') {
      return {
        originalPath: resolvedPath,
        originalFilename: basename(resolvedPath),
        storedFilename: basename(resolvedPath),
        sourceKind: 'kml_file',
        mimeType: 'application/vnd.google-earth.kml+xml',
        fileSizeBytes: Number(sourceStats.size),
        sourceDocumentPath: resolvedPath,
        openStream: () => createReadStream(resolvedPath),
      };
    }

    if (extension === '.kmz') {
      return {
        originalPath: resolvedPath,
        originalFilename: basename(resolvedPath),
        storedFilename: basename(resolvedPath),
        sourceKind: 'kmz_archive',
        mimeType: 'application/vnd.google-earth.kmz',
        fileSizeBytes: Number(sourceStats.size),
        sourceDocumentPath: `${resolvedPath}::doc.kml`,
        openStream: () =>
          createReadStream(resolvedPath).pipe(
            unzipper.ParseOne(/doc\.kml$/i),
          ) as Readable,
      };
    }

    throw new BadRequestException(
      'Only a .kmz archive, .kml file, or extracted KMZ directory is supported.',
    );
  }

  private async parseIntoDatabase(
    mapId: string,
    mapName: string,
    source: ImportSource,
    options: ImportOptions,
  ) {
    const parser = sax.parser(true, {
      trim: false,
      normalize: false,
      lowercase: false,
      xmlns: false,
    });
    const stream = source.openStream();
    stream.setEncoding('utf8');

    const stats: ImportStats = {
      folderCount: 0,
      featureCount: 0,
      pointCount: 0,
      lineStringCount: 0,
      polygonCount: 0,
      nodeCount: 0,
    };

    let rootFolder: FolderState | null = null;
    const folderStack: FolderState[] = [];
    const folderBatch: FolderState[] = [];
    const featureBatch: Array<typeof mapFeatures.$inferInsert> = [];
    const nodeBatch: Array<typeof nodes.$inferInsert> = [];

    let activePlacemark: PlacemarkState | null = null;
    let captureTag: string | null = null;
    let captureText = '';
    const elementStack: string[] = [];
    let catalogRootName = mapName;
    let catalogRootLocked = false;
    const placemarkFinalizations: Promise<void>[] = [];

    const queueFolder = (folder: FolderState) => {
      folderBatch.push(folder);
      stats.folderCount += 1;
    };

    const activeLineage = () => {
      if (rootFolder) {
        return [rootFolder, ...folderStack];
      }

      return [...folderStack];
    };

    const ensureRootFolder = () => {
      if (rootFolder) {
        return rootFolder;
      }

      rootFolder = {
        id: randomUUID(),
        mapId,
        parentId: null,
        name: catalogRootName,
        sourcePath: 'root',
        displayPath: catalogRootName,
        depth: 0,
        sortOrder: 0,
        isOpenByDefault: false,
        childFolderCount: 0,
        descendantFolderCount: 0,
        directFeatureCount: 0,
        descendantFeatureCount: 0,
        nextChildFolderSort: 0,
        nextFeatureSort: 0,
      };
      queueFolder(rootFolder);
      return rootFolder;
    };

    const flushFolders = async () => {
      if (folderBatch.length === 0) {
        return;
      }

      const batch = folderBatch.splice(0, folderBatch.length).map((folder) => ({
        id: folder.id,
        mapId: folder.mapId,
        parentId: folder.parentId,
        name: folder.name,
        sourcePath: folder.sourcePath,
        displayPath: folder.displayPath,
        depth: folder.depth,
        sortOrder: folder.sortOrder,
        isOpenByDefault: folder.isOpenByDefault,
        childFolderCount: folder.childFolderCount,
        descendantFolderCount: folder.descendantFolderCount,
        directFeatureCount: folder.directFeatureCount,
        descendantFeatureCount: folder.descendantFeatureCount,
      }));

      await this.databaseService.db.insert(mapFolders).values(batch);
    };

    const awaitPlacemarkFinalizations = async () => {
      if (placemarkFinalizations.length > 0) {
        await Promise.all(
          placemarkFinalizations.splice(0, placemarkFinalizations.length),
        );
      }
    };

    const flushFeatures = async () => {
      await awaitPlacemarkFinalizations();
      if (featureBatch.length === 0) {
        return;
      }

      await flushFolders();

      const featureInsertBatch = featureBatch
        .splice(0, featureBatch.length)
        .map((feature) => ({
          ...feature,
        }));
      await this.databaseService.db
        .insert(mapFeatures)
        .values(featureInsertBatch);

      if (nodeBatch.length > 0) {
        const nodeInsertBatch = nodeBatch
          .splice(0, nodeBatch.length)
          .map((node) => ({
            ...node,
          }));
        await this.databaseService.db.insert(nodes).values(nodeInsertBatch);
      }
    };

    const updateFolderCounters = (
      lineage = activeLineage(),
      featureCount = 1,
    ) => {
      const currentFolder = lineage.at(-1);

      if (!currentFolder) {
        throw new BadRequestException(
          'Placemark encountered before folder context was created.',
        );
      }

      currentFolder.directFeatureCount += featureCount;
      for (const folder of lineage) {
        folder.descendantFeatureCount += featureCount;
      }
    };

    const beginFolder = () => {
      const parent = folderStack.at(-1) ?? ensureRootFolder();
      const sortOrder = ++parent.nextChildFolderSort;
      const folder: FolderState = {
        id: randomUUID(),
        mapId,
        parentId: parent.id,
        name: `Folder ${sortOrder}`,
        sourcePath: `${parent.sourcePath}/f-${String(sortOrder).padStart(6, '0')}`,
        displayPath: `${parent.displayPath}/Folder ${sortOrder}`,
        depth: parent.depth + 1,
        sortOrder,
        isOpenByDefault: false,
        childFolderCount: 0,
        descendantFolderCount: 0,
        directFeatureCount: 0,
        descendantFeatureCount: 0,
        nextChildFolderSort: 0,
        nextFeatureSort: 0,
      };

      parent.childFolderCount += 1;
      for (const ancestor of activeLineage()) {
        ancestor.descendantFolderCount += 1;
      }

      folderStack.push(folder);
      queueFolder(folder);
    };

    const beginPlacemark = (attributes: Record<string, string>) => {
      const folder = folderStack.at(-1) ?? ensureRootFolder();
      const sortOrder = ++folder.nextFeatureSort;
      const folderLineage = activeLineage();
      updateFolderCounters(folderLineage);

      activePlacemark = {
        id: randomUUID(),
        sourceFeatureId: attributes.id ?? null,
        name: `Placemark ${sortOrder}`,
        description: null,
        visibility: true,
        styleUrl: null,
        sourcePath: `${folder.sourcePath}/p-${String(sortOrder).padStart(6, '0')}`,
        sortOrder,
        folderId: folder.id,
        folderLineage,
        extendedData: {},
        lookAt: {},
        geometries: [],
        currentDataName: null,
        currentSimpleDataName: null,
      };
    };

    const finalizePlacemark = async (placemark: PlacemarkState | null) => {
      if (!placemark) {
        return;
      }

      const geometry = finalizeGeometry(placemark.geometries);
      const featureSlotCount = importedFeatureSlotCount(geometry);
      if (featureSlotCount > 1) {
        const currentFolder = placemark.folderLineage.at(-1);
        if (currentFolder) {
          currentFolder.nextFeatureSort += featureSlotCount - 1;
        }
      }

      const routedFeatures = await routeImportedLineFeatures(
        geometry,
        this.graphHopperRoutingService,
        options.autoRoute,
      );
      const placemarkProperties: Record<string, unknown> = {};

      if (Object.keys(placemark.extendedData).length > 0) {
        placemarkProperties.extendedData = placemark.extendedData;
      }

      if (Object.keys(placemark.lookAt).length > 0) {
        placemarkProperties.lookAt = placemark.lookAt;
      }

      if (routedFeatures.length > 1) {
        updateFolderCounters(
          placemark.folderLineage,
          routedFeatures.length - 1,
        );
      }

      for (const [featureIndex, routedFeature] of routedFeatures.entries()) {
        const featureId = featureIndex === 0 ? placemark.id : randomUUID();
        const rawProperties: Record<string, unknown> = {
          ...placemarkProperties,
          ...routedFeature.rawProperties,
        };
        const name = routedFeature.nameSuffix
          ? `${placemark.name} - ${routedFeature.nameSuffix}`
          : placemark.name;
        const sourcePath =
          routedFeatures.length > 1
            ? `${placemark.sourcePath}/segment-${String(featureIndex + 1).padStart(4, '0')}`
            : placemark.sourcePath;

        if (routedFeatures.length > 1) {
          rawProperties.routeGroupId = placemark.id;
          rawProperties.routeName = placemark.name;
          rawProperties.routeSegmentName = name;
        }

        featureBatch.push({
          id: featureId,
          mapId,
          folderId: placemark.folderId,
          sourceFeatureId: placemark.sourceFeatureId,
          sourcePath,
          name,
          description: placemark.description,
          visibility: placemark.visibility,
          geometryType: routedFeature.geometry?.geometryType ?? null,
          geom: routedFeature.geometry?.ewkt,
          styleUrl: placemark.styleUrl,
          rawProperties:
            Object.keys(rawProperties).length > 0 ? rawProperties : null,
          sortOrder: placemark.sortOrder + featureIndex,
        });
        stats.featureCount += 1;
        inferCounts(stats, routedFeature.geometry?.geometryType ?? null);

        if (routedFeature.geometry?.geometryType === 'Point') {
          nodeBatch.push({
            id: randomUUID(),
            mapId,
            importedFeatureId: featureId,
            name,
            geom: routedFeature.geometry.ewkt,
            sourceProperties:
              Object.keys(rawProperties).length > 0 ? rawProperties : null,
          });
          stats.nodeCount += 1;
        }
      }
    };

    parser.onopentag = (tag) => {
      const tagName = normalizeTagName(tag.name);
      elementStack.push(tagName);

      if (
        tagName === 'name' ||
        tagName === 'description' ||
        tagName === 'styleurl' ||
        tagName === 'visibility' ||
        tagName === 'coordinates' ||
        tagName === 'value' ||
        tagName === 'simpledata' ||
        tagName === 'longitude' ||
        tagName === 'latitude' ||
        tagName === 'altitude' ||
        tagName === 'heading' ||
        tagName === 'tilt' ||
        tagName === 'range'
      ) {
        captureTag = tagName;
        captureText = '';
      }

      if (tagName === 'folder') {
        beginFolder();
      } else if (tagName === 'placemark') {
        beginPlacemark(tag.attributes as Record<string, string>);
      } else if (tagName === 'point' && activePlacemark) {
        activePlacemark.geometries.push({
          kind: 'Point',
          coordinatesText: '',
        });
      } else if (tagName === 'linestring' && activePlacemark) {
        activePlacemark.geometries.push({
          kind: 'LineString',
          coordinatesText: '',
        });
      } else if (tagName === 'polygon' && activePlacemark) {
        activePlacemark.geometries.push({
          kind: 'Polygon',
          outerCoordinatesText: '',
          innerCoordinatesTexts: [],
          activeBoundary: null,
        });
      } else if (tagName === 'outerboundaryis' && activePlacemark) {
        const currentGeometry = activePlacemark.geometries.at(-1);
        if (currentGeometry?.kind === 'Polygon') {
          currentGeometry.activeBoundary = 'outer';
        }
      } else if (tagName === 'innerboundaryis' && activePlacemark) {
        const currentGeometry = activePlacemark.geometries.at(-1);
        if (currentGeometry?.kind === 'Polygon') {
          currentGeometry.activeBoundary = 'inner';
        }
      } else if (tagName === 'data' && activePlacemark) {
        activePlacemark.currentDataName =
          (tag.attributes.name as string | undefined) ?? null;
      } else if (tagName === 'simpledata' && activePlacemark) {
        activePlacemark.currentSimpleDataName =
          (tag.attributes.name as string | undefined) ?? null;
      }
    };

    parser.ontext = (text) => {
      if (captureTag && elementStack.at(-1) === captureTag) {
        captureText += text;
      }
    };
    parser.oncdata = (text) => {
      if (captureTag && elementStack.at(-1) === captureTag) {
        captureText += text;
      }
    };

    parser.onclosetag = (name) => {
      const tagName = normalizeTagName(name);
      const parentTag = elementStack.at(-2);
      const value = captureTag === tagName ? captureText.trim() : '';

      if (captureTag === tagName) {
        if (tagName === 'name') {
          if (parentTag === 'document') {
            if (!catalogRootLocked && value) {
              catalogRootName = value;
              const root = ensureRootFolder();
              root.name = catalogRootName;
              root.displayPath = catalogRootName;
              catalogRootLocked = true;
            }
          } else if (parentTag === 'folder') {
            const currentFolder = folderStack.at(-1);
            if (currentFolder) {
              currentFolder.name = value || currentFolder.name;
              const parentDisplayPath =
                currentFolder.parentId === rootFolder?.id
                  ? rootFolder.displayPath
                  : (folderStack.at(-2)?.displayPath ??
                    rootFolder?.displayPath ??
                    '');
              currentFolder.displayPath = parentDisplayPath
                ? `${parentDisplayPath}/${currentFolder.name}`
                : currentFolder.name;
            }
          } else if (parentTag === 'placemark' && activePlacemark) {
            activePlacemark.name = value || activePlacemark.name;
          }
        } else if (
          tagName === 'description' &&
          parentTag === 'placemark' &&
          activePlacemark
        ) {
          activePlacemark.description = value || null;
        } else if (
          tagName === 'styleurl' &&
          parentTag === 'placemark' &&
          activePlacemark
        ) {
          activePlacemark.styleUrl = value || null;
        } else if (
          tagName === 'visibility' &&
          parentTag === 'placemark' &&
          activePlacemark
        ) {
          activePlacemark.visibility = value !== '0';
        } else if (tagName === 'coordinates' && activePlacemark) {
          const currentGeometry = activePlacemark.geometries.at(-1);
          if (
            currentGeometry?.kind === 'Point' ||
            currentGeometry?.kind === 'LineString'
          ) {
            currentGeometry.coordinatesText += ` ${value}`;
          } else if (currentGeometry?.kind === 'Polygon') {
            if (currentGeometry.activeBoundary === 'inner') {
              currentGeometry.innerCoordinatesTexts.push(value);
            } else {
              currentGeometry.outerCoordinatesText = value;
            }
          }
        } else if (
          tagName === 'value' &&
          activePlacemark &&
          activePlacemark.currentDataName
        ) {
          activePlacemark.extendedData[activePlacemark.currentDataName] = value;
        } else if (
          tagName === 'simpledata' &&
          activePlacemark &&
          activePlacemark.currentSimpleDataName
        ) {
          activePlacemark.extendedData[activePlacemark.currentSimpleDataName] =
            value;
        } else if (
          activePlacemark &&
          parentTag === 'lookat' &&
          [
            'longitude',
            'latitude',
            'altitude',
            'heading',
            'tilt',
            'range',
          ].includes(tagName)
        ) {
          activePlacemark.lookAt[tagName] = value;
        }

        captureTag = null;
        captureText = '';
      }

      if (tagName === 'outerboundaryis' || tagName === 'innerboundaryis') {
        const currentGeometry = activePlacemark?.geometries.at(-1);
        if (currentGeometry?.kind === 'Polygon') {
          currentGeometry.activeBoundary = null;
        }
      }

      if (tagName === 'data' && activePlacemark) {
        activePlacemark.currentDataName = null;
      } else if (tagName === 'simpledata' && activePlacemark) {
        activePlacemark.currentSimpleDataName = null;
      } else if (tagName === 'placemark') {
        const placemark = activePlacemark;
        activePlacemark = null;
        placemarkFinalizations.push(finalizePlacemark(placemark));
      } else if (tagName === 'folder') {
        folderStack.pop();
      }

      elementStack.pop();
    };

    parser.onerror = (error) => {
      throw error;
    };

    for await (const chunk of stream as AsyncIterable<string>) {
      parser.write(chunk);
      await awaitPlacemarkFinalizations();

      if (featureBatch.length >= FEATURE_BATCH_SIZE) {
        await flushFeatures();
      }

      if (
        folderBatch.length >= FOLDER_BATCH_SIZE &&
        featureBatch.length === 0
      ) {
        await flushFolders();
      }
    }

    parser.close();
    await awaitPlacemarkFinalizations();
    await flushFeatures();
    await flushFolders();

    const finalCatalogRootName =
      (rootFolder as FolderState | null)?.name ?? catalogRootName;

    return {
      catalogRootName: finalCatalogRootName,
      stats,
    };
  }
}
