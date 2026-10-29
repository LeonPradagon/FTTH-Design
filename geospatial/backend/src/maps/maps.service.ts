import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { rm } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'path';
import {
  type MapRecord,
  mapFeatures,
  mapFolders,
  maps,
  nodes,
  provinces,
  users,
} from '../database/schemas';
import { DatabaseService } from '../database/database.service';
import { FolderFilterQueryDto } from './dto/folder-filter.query.dto';
import { ExportKmlDto } from './dto/export-kml.dto';
import { FolderFilterBodyDto } from './dto/folder-filter.body.dto';
import { ListMapFeaturesQueryDto } from './dto/list-map-features.query.dto';
import { createCsvFilename, serializeCsvExport } from './csv-export.serializer';
import {
  createKmlFilename,
  type KmlExportFeature,
  type KmlExportFolder,
  serializeKmlExport,
} from './kml-export.serializer';
import { MapImportService } from './map-import.service';
import {
  MapStyleResolverService,
  type ResolvedFeatureStyle,
} from './map-style-resolver.service';

const TILE_CLUSTER_GRID_SIZE = 4;
const MIN_TILE_ZOOM = 0;
const MAX_TILE_ZOOM = 18;
const ROUTE_SEGMENT_ENDPOINT_MATCH_METERS = 150;
const ROUTE_SEGMENT_ENDPOINT_MATCH_DEGREES = 0.002;
const IMPORTED_SOURCE_STORAGE_DIRECTORY = resolve(
  process.cwd(),
  '.data',
  'imported-map-sources',
);

type TreeNode = {
  id: string;
  parentId: string | null;
  name: string;
  depth: number;
  sourcePath: string;
  isOpenByDefault: boolean;
  symbols: TreeSymbol[];
  features: TreeFeature[];
  counts: {
    childFolders: number;
    descendantFolders: number;
    directFeatures: number;
    descendantFeatures: number;
  };
  children: TreeNode[];
};

type TreeFeature = {
  displayName: string | null;
  id: string;
  name: string;
  geometryType: string | null;
  style: ResolvedFeatureStyle | null;
  styleUrl: string | null;
};

type TreeSymbol = {
  geometryType: string | null;
  styleUrl: string | null;
  count: number;
  style: ResolvedFeatureStyle | null;
};

type FolderSymbolRow = {
  folder_id: string;
  geometry_type: string | null;
  style_url: string | null;
  feature_count: number;
};

type TreeFeatureRow = {
  display_name: string | null;
  folder_id: string;
  geometry_type: string | null;
  id: string;
  name: string;
  style_url: string | null;
};

type SuggestedProvinceRow = {
  id: string;
  name: string;
  feature_count: number;
  point_count: number;
};

type ProvinceRecord = {
  id: string;
  name: string;
};

type PointTileRow = {
  id: string;
  imported_feature_id: string | null;
  name: string;
  longitude: number;
  latitude: number;
  source_path: string | null;
  raw_properties: Record<string, unknown> | null;
  style: ResolvedFeatureStyle | null;
  style_url: string | null;
};

function isPathInside(parentPath: string, candidatePath: string) {
  const relativePath = relative(parentPath, candidatePath);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith('..') &&
    !isAbsolute(relativePath)
  );
}

type PointClusterRow = {
  cell_x: number;
  cell_y: number;
  count: number;
  longitude: number;
  latitude: number;
};

type DrawnFeatureRow = {
  id: string;
  name: string;
  description: string | null;
  geometry_type: 'LineString' | 'Polygon';
  geometry_json: string;
  raw_properties: Record<string, unknown> | null;
  style: ResolvedFeatureStyle | null;
};

type DrawnPointFeatureRow = {
  id: string;
  name: string;
  description: string | null;
  geometry_type: 'Point';
  geometry_json: string;
  raw_properties: Record<string, unknown> | null;
  style: ResolvedFeatureStyle | null;
};

type ImportedAreaFeatureRow = {
  id: string;
  name: string;
  description: string | null;
  geometryType: string | null;
  sourcePath: string | null;
  styleUrl: string | null;
  rawProperties: Record<string, unknown> | null;
  geometryJson: string;
};

type ExportFeatureRow = {
  id: string;
  folderId: string | null;
  name: string;
  description: string | null;
  geometryType: string | null;
  sourcePath: string | null;
  styleUrl: string | null;
  rawProperties: Record<string, unknown> | null;
  geometryJson: string;
};

type ExportPayload = {
  mapName: string;
  provinceName: string;
  folders: KmlExportFolder[];
  importedFeatures: KmlExportFeature[];
  drawnFeatures: KmlExportFeature[];
};

function treeSymbolKey(symbol: TreeSymbol) {
  return `${symbol.geometryType ?? ''}:${symbol.styleUrl ?? ''}`;
}

function summarizeTreeSymbols(symbols: TreeSymbol[]) {
  const merged = new Map<string, TreeSymbol>();

  for (const symbol of symbols) {
    const key = treeSymbolKey(symbol);
    const existing = merged.get(key);

    if (existing) {
      existing.count += symbol.count;
      continue;
    }

    merged.set(key, { ...symbol });
  }

  return [...merged.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 4);
}

function featureStyle(
  row: ImportedAreaFeatureRow,
  styleLookup: Map<string, ResolvedFeatureStyle | null>,
) {
  return row.styleUrl ? (styleLookup.get(row.styleUrl) ?? null) : null;
}

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private readonly mapRecordCache = new Map<string, Promise<MapRecord>>();
  private readonly provinceRecordCache = new Map<
    string,
    Promise<ProvinceRecord | null>
  >();

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly mapImportService: MapImportService,
    private readonly mapStyleResolverService: MapStyleResolverService,
  ) {}

  async findAll() {
    return this.databaseService.db
      .select()
      .from(maps)
      .orderBy(desc(maps.createdAt));
  }

  async listUploadHistory() {
    return this.databaseService.db
      .select({
        id: maps.id,
        name: maps.name,
        originalFilename: maps.originalFilename,
        fileSizeBytes: maps.fileSizeBytes,
        importStatus: maps.importStatus,
        importError: maps.importError,
        folderCount: maps.folderCount,
        featureCount: maps.featureCount,
        pointCount: maps.pointCount,
        lineStringCount: maps.lineStringCount,
        polygonCount: maps.polygonCount,
        nodeCount: maps.nodeCount,
        createdAt: maps.createdAt,
        updatedAt: maps.updatedAt,
        uploadedByUserId: maps.uploadedByUserId,
        uploadedByName: users.name,
        uploadedByEmail: users.email,
      })
      .from(maps)
      .leftJoin(users, eq(maps.uploadedByUserId, users.id))
      .where(isNotNull(maps.uploadedByUserId))
      .orderBy(desc(maps.createdAt));
  }

  async deleteMapPackage(mapId: string) {
    const [deletedMap] = await this.databaseService.db
      .delete(maps)
      .where(eq(maps.id, mapId))
      .returning({
        id: maps.id,
        name: maps.name,
        storagePath: maps.storagePath,
      });

    if (!deletedMap) {
      throw new NotFoundException(`Map package ${mapId} was not found.`);
    }

    this.mapRecordCache.delete(mapId);

    await this.removePreservedImportedSource(
      deletedMap.id,
      deletedMap.storagePath,
    );

    return {
      success: true,
      deletedMapId: deletedMap.id,
      deletedName: deletedMap.name,
    };
  }

  async getTree(mapId: string) {
    const mapRecord = await this.getMapRecord(mapId);

    const [folderRows, directFeatureCounts, folderSymbolRows, featureRows] =
      await Promise.all([
        this.databaseService.db
          .select()
          .from(mapFolders)
          .where(eq(mapFolders.mapId, mapId))
          .orderBy(mapFolders.depth, mapFolders.sortOrder),
        this.databaseService.db
          .select({
            folderId: mapFeatures.folderId,
            count: sql<number>`count(*)::int`,
          })
          .from(mapFeatures)
          .where(eq(mapFeatures.mapId, mapId))
          .groupBy(mapFeatures.folderId),
        this.getFolderSymbolRows(mapId),
        this.listTreeLineFeatures(mapId),
      ]);

    const styleLookup = await this.resolveStyleLookup(
      mapRecord,
      [
        ...folderSymbolRows.map((row) => row.style_url),
        ...featureRows.map((row) => row.style_url),
      ],
    );
    const directCountMap = new Map(
      directFeatureCounts.map((row) => [row.folderId, Number(row.count)]),
    );
    const directSymbolMap = new Map<string, TreeSymbol[]>();
    const directFeatureMap = new Map<string, TreeFeature[]>();

    for (const row of folderSymbolRows) {
      const symbol: TreeSymbol = {
        geometryType: row.geometry_type,
        styleUrl: row.style_url,
        count: Number(row.feature_count),
        style: row.style_url ? (styleLookup.get(row.style_url) ?? null) : null,
      };

      const existing = directSymbolMap.get(row.folder_id) ?? [];
      existing.push(symbol);
      directSymbolMap.set(row.folder_id, existing);
    }

    for (const row of featureRows as TreeFeatureRow[]) {
      const feature: TreeFeature = {
        displayName: row.display_name,
        id: row.id,
        name: row.name,
        geometryType: row.geometry_type,
        styleUrl: row.style_url,
        style: row.style_url ? (styleLookup.get(row.style_url) ?? null) : null,
      };
      const existing = directFeatureMap.get(row.folder_id) ?? [];
      existing.push(feature);
      directFeatureMap.set(row.folder_id, existing);
    }

    const nodeMap = new Map<string, TreeNode>();
    const roots: TreeNode[] = [];

    for (const folder of folderRows) {
      const directFeatureCount = Number(directCountMap.get(folder.id) ?? 0);

      const treeNode: TreeNode = {
        id: folder.id,
        parentId: folder.parentId,
        name: folder.name,
        depth: folder.depth,
        sourcePath: folder.sourcePath,
        isOpenByDefault: folder.isOpenByDefault,
        symbols: summarizeTreeSymbols(directSymbolMap.get(folder.id) ?? []),
        features: directFeatureMap.get(folder.id) ?? [],
        counts: {
          childFolders: 0,
          descendantFolders: 0,
          directFeatures: directFeatureCount,
          descendantFeatures: 0,
        },
        children: [],
      };

      nodeMap.set(folder.id, treeNode);

      if (!folder.parentId) {
        roots.push(treeNode);
        continue;
      }

      const parent = nodeMap.get(folder.parentId);
      if (parent) {
        parent.children.push(treeNode);
      }
    }

    const enrichCounts = (node: TreeNode) => {
      let descendantFolders = 0;
      let descendantFeatures = node.counts.directFeatures;

      for (const child of node.children) {
        const childCounts = enrichCounts(child);
        descendantFolders += childCounts.totalFolders;
        descendantFeatures += childCounts.totalFeatures;
        node.symbols = summarizeTreeSymbols([
          ...node.symbols,
          ...child.symbols,
        ]);
      }

      node.counts.childFolders = node.children.length;
      node.counts.descendantFolders = descendantFolders;
      node.counts.descendantFeatures = descendantFeatures;

      return {
        totalFolders: node.children.length + descendantFolders,
        totalFeatures: descendantFeatures,
      };
    };

    for (const root of roots) {
      enrichCounts(root);
    }

    return {
      map: mapRecord,
      tree: roots,
    };
  }

  private async getFolderSymbolRows(mapId: string): Promise<FolderSymbolRow[]> {
    return this.databaseService.client<FolderSymbolRow[]>`
      WITH grouped_symbols AS (
        SELECT
          folder_id,
          geometry_type,
          style_url,
          count(*)::int AS feature_count
        FROM map_features
        WHERE map_id = ${mapId}
        GROUP BY folder_id, geometry_type, style_url
      ),
      ranked_symbols AS (
        SELECT
          folder_id,
          geometry_type,
          style_url,
          feature_count,
          row_number() OVER (
            PARTITION BY folder_id
            ORDER BY feature_count DESC, geometry_type NULLS LAST, style_url NULLS LAST
          ) AS rank
        FROM grouped_symbols
      )
      SELECT folder_id, geometry_type, style_url, feature_count
      FROM ranked_symbols
      WHERE rank <= 4
      ORDER BY folder_id, rank
    `;
  }

  private async listTreeLineFeatures(mapId: string): Promise<TreeFeatureRow[]> {
    return this.databaseService.client<TreeFeatureRow[]>`
      SELECT
        mf.id::text AS id,
        mf.folder_id::text AS folder_id,
        mf.name AS name,
        mf.geometry_type AS geometry_type,
        mf.style_url AS style_url,
        CASE
          WHEN start_node.name IS NOT NULL
            AND end_node.name IS NOT NULL
            AND start_node.name <> end_node.name
          THEN start_node.name || ' - ' || end_node.name
          ELSE NULL
        END AS display_name
      FROM map_features AS mf
      CROSS JOIN LATERAL (
        SELECT
          ST_StartPoint(ST_GeometryN(mf.geom, 1)) AS start_geom,
          ST_EndPoint(
            ST_GeometryN(mf.geom, ST_NumGeometries(mf.geom))
          ) AS end_geom
      ) AS endpoints
      LEFT JOIN LATERAL (
        SELECT n.name
        FROM nodes AS n
        WHERE n.map_id = mf.map_id
          AND mf.geom IS NOT NULL
          AND n.geom && ST_Expand(
            endpoints.start_geom,
            ${ROUTE_SEGMENT_ENDPOINT_MATCH_DEGREES}
          )
          AND ST_DWithin(
            n.geom::geography,
            endpoints.start_geom::geography,
            ${ROUTE_SEGMENT_ENDPOINT_MATCH_METERS}
          )
        ORDER BY n.geom <-> endpoints.start_geom
        LIMIT 1
      ) AS start_node ON mf.geometry_type = 'LineString'
      LEFT JOIN LATERAL (
        SELECT n.name
        FROM nodes AS n
        WHERE n.map_id = mf.map_id
          AND mf.geom IS NOT NULL
          AND n.geom && ST_Expand(
            endpoints.end_geom,
            ${ROUTE_SEGMENT_ENDPOINT_MATCH_DEGREES}
          )
          AND ST_DWithin(
            n.geom::geography,
            endpoints.end_geom::geography,
            ${ROUTE_SEGMENT_ENDPOINT_MATCH_METERS}
          )
        ORDER BY n.geom <-> endpoints.end_geom
        LIMIT 1
      ) AS end_node ON mf.geometry_type = 'LineString'
      WHERE mf.map_id = ${mapId}::uuid
        AND mf.geometry_type IN ('LineString', 'MultiLineString')
      ORDER BY mf.folder_id, mf.sort_order
    `;
  }

  async getFeatures(
    mapId: string,
    query:
      | ListMapFeaturesQueryDto
      | {
          provinceId?: string;
          bbox?: string;
          folderIds?: string | string[];
          limit?: number;
        },
  ) {
    const mapRecord = await this.getMapRecord(mapId);
    const provinceId = query.provinceId?.trim() || null;
    const limit = query.limit ?? 5000;
    const bbox = this.parseBbox(query.bbox);
    const bboxValue = bbox ? query.bbox?.trim() || null : null;
    const folderIds = await this.resolveFolderFilter(mapId, query.folderIds);

    if (!provinceId) {
      return {
        type: 'FeatureCollection' as const,
        features: [],
        meta: {
          mapId,
          provinceId: null,
          bbox: bboxValue,
          limit,
          truncated: false,
        },
      };
    }

    const provinceRecord = await this.findProvinceRecord(provinceId);
    if (!provinceRecord) {
      return {
        type: 'FeatureCollection' as const,
        features: [],
        meta: {
          mapId,
          provinceId,
          bbox: bboxValue,
          limit,
          truncated: false,
        },
      };
    }

    const drawnPointRows = await this.listDrawnPointFeatures(
      mapId,
      provinceRecord.id,
      bbox,
      limit + 1,
    );
    const remainingAreaLimit = Math.max(
      0,
      limit + 1 - Math.min(limit + 1, drawnPointRows.length),
    );
    const drawnRows = await this.listDrawnAreaFeatures(
      mapId,
      provinceRecord.id,
      bbox,
      remainingAreaLimit,
    );
    const drawnCount = drawnPointRows.length + drawnRows.length;
    const remainingImportLimit = Math.max(
      0,
      limit + 1 - Math.min(limit + 1, drawnCount),
    );
    const importedWhereClauses = [
      eq(mapFeatures.mapId, mapId),
      sql`${mapFeatures.geom} IS NOT NULL`,
      sql`COALESCE(${mapFeatures.geometryType}, '') NOT IN ('Point', 'MultiPoint')`,
      sql`EXISTS (
        SELECT 1
        FROM ${provinces}
        WHERE ${provinces.id} = ${provinceRecord.id}
          AND ST_Intersects(${mapFeatures.geom}, ${provinces.geom})
      )`,
    ];

    if (bbox) {
      importedWhereClauses.push(
        sql`ST_Intersects(${mapFeatures.geom}, ST_MakeEnvelope(${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng}, ${bbox.maxLat}, 4326))`,
      );
    }

    if (folderIds) {
      if (folderIds.length === 0) {
        const drawnPointFeatures = drawnPointRows.map((row) => ({
          type: 'Feature' as const,
          id: row.id,
          geometry: row.geometry_json ? JSON.parse(row.geometry_json) : null,
          properties: {
            name: row.name,
            description: row.description,
            geometryType: row.geometry_type,
            sourcePath: null,
            styleUrl: null,
            style: row.style,
            rawProperties: {
              ...(row.raw_properties ?? {}),
              source: 'drawn',
            },
          },
        }));
        const drawnFeatures = drawnRows.map((row) => ({
          type: 'Feature' as const,
          id: row.id,
          geometry: row.geometry_json ? JSON.parse(row.geometry_json) : null,
          properties: {
            name: row.name,
            description: row.description,
            geometryType: row.geometry_type,
            sourcePath: null,
            styleUrl: null,
            style: row.style,
            rawProperties: {
              ...(row.raw_properties ?? {}),
              source: 'drawn',
            },
          },
        }));
        const combinedFeatures = [...drawnPointFeatures, ...drawnFeatures];
        const truncated = combinedFeatures.length > limit;
        const features = combinedFeatures.slice(0, limit);

        return {
          type: 'FeatureCollection' as const,
          features,
          meta: {
            mapId,
            provinceId: provinceRecord.id,
            bbox: bboxValue,
            limit,
            truncated,
          },
        };
      }

      importedWhereClauses.push(inArray(mapFeatures.folderId, folderIds));
    }

    const importedRows = remainingImportLimit
      ? await this.databaseService.db
          .select({
            id: mapFeatures.id,
            name: mapFeatures.name,
            description: mapFeatures.description,
            geometryType: mapFeatures.geometryType,
            sourcePath: mapFeatures.sourcePath,
            styleUrl: mapFeatures.styleUrl,
            rawProperties: mapFeatures.rawProperties,
            geometryJson: sql<string>`ST_AsGeoJSON(${mapFeatures.geom})`,
          })
          .from(mapFeatures)
          .where(and(...importedWhereClauses))
          .orderBy(mapFeatures.sourcePath)
          .limit(remainingImportLimit)
      : [];

    const styleLookup = await this.resolveStyleLookup(
      mapRecord,
      importedRows.map((row) => row.styleUrl),
    );
    const importedFeatures = importedRows.map(
      (row: ImportedAreaFeatureRow) => ({
        type: 'Feature' as const,
        id: row.id,
        geometry: row.geometryJson ? JSON.parse(row.geometryJson) : null,
        properties: {
          name: row.name,
          description: row.description,
          geometryType: row.geometryType,
          sourcePath: row.sourcePath,
          styleUrl: row.styleUrl,
          style: featureStyle(row, styleLookup),
          rawProperties: row.rawProperties,
        },
      }),
    );
    const drawnPointFeatures = drawnPointRows.map((row) => ({
      type: 'Feature' as const,
      id: row.id,
      geometry: row.geometry_json ? JSON.parse(row.geometry_json) : null,
      properties: {
        name: row.name,
        description: row.description,
        geometryType: row.geometry_type,
        sourcePath: null,
        styleUrl: null,
        style: row.style,
        rawProperties: {
          ...(row.raw_properties ?? {}),
          source: 'drawn',
        },
      },
    }));
    const drawnFeatures = drawnRows.map((row) => ({
      type: 'Feature' as const,
      id: row.id,
      geometry: row.geometry_json ? JSON.parse(row.geometry_json) : null,
      properties: {
        name: row.name,
        description: row.description,
        geometryType: row.geometry_type,
        sourcePath: null,
        styleUrl: null,
        style: row.style,
        rawProperties: {
          ...(row.raw_properties ?? {}),
          source: 'drawn',
        },
      },
    }));

    const combinedFeatures = [
      ...drawnPointFeatures,
      ...drawnFeatures,
      ...importedFeatures,
    ];
    const truncated = drawnCount + importedRows.length > limit;
    const features = combinedFeatures.slice(0, limit);

    return {
      type: 'FeatureCollection' as const,
      features,
      meta: {
        mapId,
        provinceId: provinceRecord.id,
        bbox: bboxValue,
        limit,
        truncated,
      },
    };
  }

  async getPointSummary(
    mapId: string,
    provinceId: string,
    query?: FolderFilterQueryDto | { folderIds?: string | string[] },
  ) {
    await this.getMapRecord(mapId);
    const provinceRecord = await this.getProvinceRecord(provinceId);
    const folderIds = await this.resolveFolderFilter(mapId, query?.folderIds);
    const hasFolderFilter = folderIds !== null;
    const folderIdArray = this.databaseService.client.array(folderIds ?? []);

    const [row] = await this.databaseService.client<
      Array<{
        point_count: number;
      }>
    >`
      WITH imported_points AS (
        SELECT DISTINCT ON (
          COALESCE(NULLIF(BTRIM(n.name), ''), '[unnamed]'),
          ST_AsBinary(n.geom)
        )
          n.id::text AS id
        FROM nodes AS n
        LEFT JOIN map_features AS mf
          ON mf.id = n.imported_feature_id
        WHERE n.map_id = ${mapId}::uuid
          AND (
            NOT ${hasFolderFilter}
            OR mf.folder_id = ANY(${folderIdArray}::uuid[])
          )
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceRecord.id}
              AND ST_Intersects(n.geom, p.geom)
          )
        ORDER BY
          COALESCE(NULLIF(BTRIM(n.name), ''), '[unnamed]'),
          ST_AsBinary(n.geom),
          n.imported_feature_id NULLS LAST,
          n.id
      ),
      drawn_points AS (
        SELECT dn.id::text AS id
        FROM drawn_nodes AS dn
        WHERE dn.map_id = ${mapId}::uuid
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceRecord.id}
              AND ST_Intersects(dn.geom, p.geom)
          )
      )
      SELECT COUNT(*)::int AS point_count
      FROM (
        SELECT id FROM imported_points
        UNION ALL
        SELECT id FROM drawn_points
      ) AS combined_points
    `;

    return {
      mapId,
      provinceId: provinceRecord.id,
      provinceName: provinceRecord.name,
      pointCount: Number(row?.point_count ?? 0),
    };
  }

  async getPointTile(
    mapId: string,
    provinceId: string,
    z: number,
    x: number,
    y: number,
    query?: FolderFilterQueryDto | { folderIds?: string | string[] },
  ) {
    const mapRecord = await this.getMapRecord(mapId);
    const provinceRecord = await this.getProvinceRecord(provinceId);
    const folderIds = await this.resolveFolderFilter(mapId, query?.folderIds);
    const hasFolderFilter = folderIds !== null;
    const folderIdArray = this.databaseService.client.array(folderIds ?? []);
    this.assertTileCoordinates(z, x, y);
    const maxTileIndex = 2 ** z - 1;
    const includeEastBoundary = x === maxTileIndex;
    const includeNorthBoundary = y === 0;

    const rows = await this.databaseService.client<Array<PointTileRow>>`
      WITH tile_bounds AS (
        SELECT
          ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}), 4326) AS geom,
          ST_XMin(ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}), 4326))::float8 AS min_lng,
          ST_XMax(ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}), 4326))::float8 AS max_lng,
          ST_YMin(ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}), 4326))::float8 AS min_lat,
          ST_YMax(ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}), 4326))::float8 AS max_lat
      ),
      deduplicated_points AS (
        SELECT DISTINCT ON (
          COALESCE(NULLIF(BTRIM(n.name), ''), '[unnamed]'),
          ST_AsBinary(n.geom)
        )
          n.id::text AS id,
          n.imported_feature_id::text AS imported_feature_id,
          n.name AS name,
          ST_X(n.geom)::float8 AS longitude,
          ST_Y(n.geom)::float8 AS latitude,
          mf.source_path AS source_path,
          NULL::jsonb AS raw_properties,
          NULL::jsonb AS style,
          mf.style_url AS style_url
        FROM nodes AS n
        LEFT JOIN map_features AS mf
          ON mf.id = n.imported_feature_id
        CROSS JOIN tile_bounds AS tb
        WHERE n.map_id = ${mapId}::uuid
          AND (
            NOT ${hasFolderFilter}
            OR mf.folder_id = ANY(${folderIdArray}::uuid[])
          )
          AND ST_Intersects(n.geom, tb.geom)
          AND ST_X(n.geom)::float8 >= tb.min_lng
          AND (ST_X(n.geom)::float8 < tb.max_lng OR ${includeEastBoundary})
          AND ST_Y(n.geom)::float8 >= tb.min_lat
          AND (ST_Y(n.geom)::float8 < tb.max_lat OR ${includeNorthBoundary})
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceRecord.id}
              AND ST_Intersects(n.geom, p.geom)
          )
        ORDER BY
          COALESCE(NULLIF(BTRIM(n.name), ''), '[unnamed]'),
          ST_AsBinary(n.geom),
          mf.source_path NULLS LAST,
          n.id
      ),
      drawn_points AS (
        SELECT
          dn.id::text AS id,
          NULL::text AS imported_feature_id,
          dn.name AS name,
          ST_X(dn.geom)::float8 AS longitude,
          ST_Y(dn.geom)::float8 AS latitude,
          NULL::text AS source_path,
          dn.raw_properties AS raw_properties,
          dn.style AS style,
          NULL::text AS style_url
        FROM drawn_nodes AS dn
        CROSS JOIN tile_bounds AS tb
        WHERE dn.map_id = ${mapId}::uuid
          AND ST_Intersects(dn.geom, tb.geom)
          AND ST_X(dn.geom)::float8 >= tb.min_lng
          AND (ST_X(dn.geom)::float8 < tb.max_lng OR ${includeEastBoundary})
          AND ST_Y(dn.geom)::float8 >= tb.min_lat
          AND (ST_Y(dn.geom)::float8 < tb.max_lat OR ${includeNorthBoundary})
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceRecord.id}
              AND ST_Intersects(dn.geom, p.geom)
          )
      )
      SELECT
        points.id,
        points.imported_feature_id,
        points.name,
        points.longitude,
        points.latitude,
        points.source_path,
        points.raw_properties,
        points.style,
        points.style_url
      FROM (
        SELECT * FROM deduplicated_points
        UNION ALL
        SELECT * FROM drawn_points
      ) AS points
      ORDER BY points.source_path NULLS LAST, points.id
    `;

    const styleLookup = await this.resolveStyleLookup(
      mapRecord,
      rows.map((row) => row.style_url),
    );

    const points = rows.map((row) => ({
      id: row.id,
      featureId: row.imported_feature_id,
      name: row.name,
      longitude: Number(row.longitude),
      latitude: Number(row.latitude),
      sourcePath: row.source_path,
      rawProperties: row.raw_properties,
      styleUrl: row.style_url,
      style:
        row.style ??
        (row.style_url ? (styleLookup.get(row.style_url) ?? null) : null),
    }));

    return {
      meta: {
        mapId,
        provinceId: provinceRecord.id,
        provinceName: provinceRecord.name,
        mode: 'points' as const,
        z,
        x,
        y,
        tileId: `${z}/${x}/${y}`,
        pointCount: points.length,
      },
      points,
    };
  }

  async getPointClusterTile(
    mapId: string,
    provinceId: string,
    z: number,
    x: number,
    y: number,
    query?: FolderFilterQueryDto | { folderIds?: string | string[] },
  ) {
    await this.getMapRecord(mapId);
    const provinceRecord = await this.getProvinceRecord(provinceId);
    const folderIds = await this.resolveFolderFilter(mapId, query?.folderIds);
    const hasFolderFilter = folderIds !== null;
    const folderIdArray = this.databaseService.client.array(folderIds ?? []);
    this.assertTileCoordinates(z, x, y);
    const maxTileIndex = 2 ** z - 1;
    const includeEastBoundary = x === maxTileIndex;
    const includeNorthBoundary = y === 0;

    const rows = await this.databaseService.client<Array<PointClusterRow>>`
      WITH tile_bounds AS (
        SELECT
          ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}), 4326) AS geom,
          ST_XMin(ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}), 4326))::float8 AS min_lng,
          ST_XMax(ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}), 4326))::float8 AS max_lng,
          ST_YMin(ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}), 4326))::float8 AS min_lat,
          ST_YMax(ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}), 4326))::float8 AS max_lat
      ),
      deduplicated_points AS (
        SELECT DISTINCT ON (
          COALESCE(NULLIF(BTRIM(n.name), ''), '[unnamed]'),
          ST_AsBinary(n.geom)
        )
          ST_X(n.geom)::float8 AS longitude,
          ST_Y(n.geom)::float8 AS latitude
        FROM nodes AS n
        LEFT JOIN map_features AS mf
          ON mf.id = n.imported_feature_id
        CROSS JOIN tile_bounds AS tb
        WHERE n.map_id = ${mapId}::uuid
          AND (
            NOT ${hasFolderFilter}
            OR mf.folder_id = ANY(${folderIdArray}::uuid[])
          )
          AND ST_Intersects(n.geom, tb.geom)
          AND ST_X(n.geom)::float8 >= tb.min_lng
          AND (ST_X(n.geom)::float8 < tb.max_lng OR ${includeEastBoundary})
          AND ST_Y(n.geom)::float8 >= tb.min_lat
          AND (ST_Y(n.geom)::float8 < tb.max_lat OR ${includeNorthBoundary})
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceRecord.id}
              AND ST_Intersects(n.geom, p.geom)
          )
        ORDER BY
          COALESCE(NULLIF(BTRIM(n.name), ''), '[unnamed]'),
          ST_AsBinary(n.geom),
          n.imported_feature_id NULLS LAST,
          n.id
      ),
      drawn_points AS (
        SELECT
          ST_X(dn.geom)::float8 AS longitude,
          ST_Y(dn.geom)::float8 AS latitude
        FROM drawn_nodes AS dn
        CROSS JOIN tile_bounds AS tb
        WHERE dn.map_id = ${mapId}::uuid
          AND ST_Intersects(dn.geom, tb.geom)
          AND ST_X(dn.geom)::float8 >= tb.min_lng
          AND (ST_X(dn.geom)::float8 < tb.max_lng OR ${includeEastBoundary})
          AND ST_Y(dn.geom)::float8 >= tb.min_lat
          AND (ST_Y(dn.geom)::float8 < tb.max_lat OR ${includeNorthBoundary})
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceRecord.id}
              AND ST_Intersects(dn.geom, p.geom)
          )
      ),
      candidates AS (
        SELECT
          points.longitude,
          points.latitude,
          tb.min_lng,
          tb.max_lng,
          tb.min_lat,
          tb.max_lat
        FROM (
          SELECT * FROM deduplicated_points
          UNION ALL
          SELECT * FROM drawn_points
        ) AS points
        CROSS JOIN tile_bounds AS tb
      ),
      bucketed AS (
        SELECT
          CASE
            WHEN max_lng = min_lng THEN 0
            ELSE LEAST(
              ${TILE_CLUSTER_GRID_SIZE - 1},
              GREATEST(
                0,
                FLOOR(
                  ((longitude - min_lng) / NULLIF(max_lng - min_lng, 0)) * ${TILE_CLUSTER_GRID_SIZE}
                )::int
              )
            )
          END AS cell_x,
          CASE
            WHEN max_lat = min_lat THEN 0
            ELSE LEAST(
              ${TILE_CLUSTER_GRID_SIZE - 1},
              GREATEST(
                0,
                FLOOR(
                  ((latitude - min_lat) / NULLIF(max_lat - min_lat, 0)) * ${TILE_CLUSTER_GRID_SIZE}
                )::int
              )
            )
          END AS cell_y,
          longitude,
          latitude
        FROM candidates
      )
      SELECT
        cell_x,
        cell_y,
        count(*)::int AS count,
        avg(longitude)::float8 AS longitude,
        avg(latitude)::float8 AS latitude
      FROM bucketed
      GROUP BY cell_x, cell_y
      ORDER BY cell_y, cell_x
    `;

    const clusters = rows.map((row) => ({
      id: `${z}/${x}/${y}:${row.cell_x}:${row.cell_y}`,
      position: [Number(row.longitude), Number(row.latitude)] as [
        number,
        number,
      ],
      count: Number(row.count),
    }));
    const pointCount = clusters.reduce(
      (total, cluster) => total + Number(cluster.count),
      0,
    );

    return {
      meta: {
        mapId,
        provinceId: provinceRecord.id,
        provinceName: provinceRecord.name,
        mode: 'clusters' as const,
        z,
        x,
        y,
        tileId: `${z}/${x}/${y}`,
        pointCount,
        clusterCount: clusters.length,
      },
      clusters,
    };
  }

  async exportKml(mapId: string, body: ExportKmlDto) {
    const payload = await this.buildExportPayload(mapId, body);
    const content = serializeKmlExport(payload);

    return {
      content,
      filename: createKmlFilename(payload.mapName, payload.provinceName),
    };
  }

  async exportCsv(mapId: string, body: ExportKmlDto) {
    const payload = await this.buildExportPayload(mapId, body);
    const content = serializeCsvExport(payload);

    return {
      content,
      filename: createCsvFilename(payload.mapName, payload.provinceName),
    };
  }

  private async buildExportPayload(
    mapId: string,
    body: ExportKmlDto,
  ): Promise<ExportPayload> {
    const mapRecord = await this.getMapRecord(mapId);
    const provinceRecord = await this.getProvinceRecord(body.provinceId);
    const folderIds = await this.resolveFolderFilter(mapId, body.folderIds);
    const excludedFolderIds = await this.resolveFolderFilter(
      mapId,
      body.excludedFolderIds,
      { includeDescendants: true },
    );
    const importedWhereClauses = [
      eq(mapFeatures.mapId, mapId),
      sql`${mapFeatures.geom} IS NOT NULL`,
      sql`EXISTS (
        SELECT 1
        FROM ${provinces}
        WHERE ${provinces.id} = ${provinceRecord.id}
          AND ST_Intersects(${mapFeatures.geom}, ${provinces.geom})
      )`,
    ];

    if (folderIds) {
      if (folderIds.length === 0) {
        importedWhereClauses.push(sql`false`);
      } else {
        importedWhereClauses.push(inArray(mapFeatures.folderId, folderIds));
      }
    }

    if (excludedFolderIds?.length) {
      importedWhereClauses.push(
        notInArray(mapFeatures.folderId, excludedFolderIds),
      );
    }

    if (body.hiddenFeatureIds?.length) {
      importedWhereClauses.push(
        notInArray(mapFeatures.id, body.hiddenFeatureIds),
      );
    }

    const [folderRows, importedRows, drawnRows] = await Promise.all([
      this.databaseService.db
        .select({
          id: mapFolders.id,
          parentId: mapFolders.parentId,
          name: mapFolders.name,
          sortOrder: mapFolders.sortOrder,
        })
        .from(mapFolders)
        .where(eq(mapFolders.mapId, mapId))
        .orderBy(mapFolders.depth, mapFolders.sortOrder),
      this.databaseService.db
        .select({
          id: mapFeatures.id,
          folderId: mapFeatures.folderId,
          name: mapFeatures.name,
          description: mapFeatures.description,
          geometryType: mapFeatures.geometryType,
          sourcePath: mapFeatures.sourcePath,
          styleUrl: mapFeatures.styleUrl,
          rawProperties: mapFeatures.rawProperties,
          geometryJson: sql<string>`ST_AsGeoJSON(${mapFeatures.geom})`,
        })
        .from(mapFeatures)
        .where(and(...importedWhereClauses))
        .orderBy(mapFeatures.sourcePath),
      this.listDrawnFeaturesForExport(mapId, provinceRecord.id),
    ]);

    const importedStyleLookup = await this.resolveStyleLookup(
      mapRecord,
      importedRows.map((row) => row.styleUrl),
    );
    const importedDisplayNames = await this.listRouteSegmentDisplayNames(
      mapId,
      importedRows.map((row) => row.id),
    );
    const importedFeatures = importedRows.map((row) =>
      this.toKmlExportFeature(
        {
          ...row,
          name: importedDisplayNames.get(row.id) ?? row.name,
        },
        importedStyleLookup,
      ),
    );
    const drawnFeatures = drawnRows.map((row) =>
      this.toKmlExportFeature(row, new Map()),
    );
    return {
      mapName: mapRecord.name,
      provinceName: provinceRecord.name,
      folders: folderRows,
      importedFeatures,
      drawnFeatures,
    };
  }

  private toKmlExportFeature(
    row: ExportFeatureRow,
    styleLookup: Map<string, ResolvedFeatureStyle | null>,
  ): KmlExportFeature {
    return {
      id: row.id,
      folderId: row.folderId,
      name: row.name,
      description: row.description,
      geometry: row.geometryJson ? JSON.parse(row.geometryJson) : null,
      rawProperties: row.rawProperties,
      style:
        row.styleUrl && styleLookup.has(row.styleUrl)
          ? (styleLookup.get(row.styleUrl) ?? null)
          : ((row.rawProperties?.style as ResolvedFeatureStyle | undefined) ??
            null),
      sourcePath: row.sourcePath,
    };
  }

  private async listRouteSegmentDisplayNames(
    mapId: string,
    featureIds: string[],
  ) {
    if (featureIds.length === 0) {
      return new Map<string, string>();
    }

    const featureIdArray = this.databaseService.client.array(featureIds);
    const rows = await this.databaseService.client<
      Array<{ display_name: string | null; id: string }>
    >`
      SELECT
        mf.id::text AS id,
        CASE
          WHEN start_node.name IS NOT NULL
            AND end_node.name IS NOT NULL
            AND start_node.name <> end_node.name
          THEN start_node.name || ' - ' || end_node.name
          ELSE NULL
        END AS display_name
      FROM map_features AS mf
      CROSS JOIN LATERAL (
        SELECT
          ST_StartPoint(ST_GeometryN(mf.geom, 1)) AS start_geom,
          ST_EndPoint(
            ST_GeometryN(mf.geom, ST_NumGeometries(mf.geom))
          ) AS end_geom
      ) AS endpoints
      LEFT JOIN LATERAL (
        SELECT n.name
        FROM nodes AS n
        WHERE n.map_id = mf.map_id
          AND mf.geom IS NOT NULL
          AND n.geom && ST_Expand(
            endpoints.start_geom,
            ${ROUTE_SEGMENT_ENDPOINT_MATCH_DEGREES}
          )
          AND ST_DWithin(
            n.geom::geography,
            endpoints.start_geom::geography,
            ${ROUTE_SEGMENT_ENDPOINT_MATCH_METERS}
          )
        ORDER BY n.geom <-> endpoints.start_geom
        LIMIT 1
      ) AS start_node ON mf.geometry_type = 'LineString'
      LEFT JOIN LATERAL (
        SELECT n.name
        FROM nodes AS n
        WHERE n.map_id = mf.map_id
          AND mf.geom IS NOT NULL
          AND n.geom && ST_Expand(
            endpoints.end_geom,
            ${ROUTE_SEGMENT_ENDPOINT_MATCH_DEGREES}
          )
          AND ST_DWithin(
            n.geom::geography,
            endpoints.end_geom::geography,
            ${ROUTE_SEGMENT_ENDPOINT_MATCH_METERS}
          )
        ORDER BY n.geom <-> endpoints.end_geom
        LIMIT 1
      ) AS end_node ON mf.geometry_type = 'LineString'
      WHERE mf.map_id = ${mapId}::uuid
        AND mf.id = ANY(${featureIdArray}::uuid[])
    `;

    return new Map(
      rows
        .filter((row): row is { display_name: string; id: string } =>
          Boolean(row.display_name?.trim()),
        )
        .map((row) => [row.id, row.display_name.trim()]),
    );
  }

  private async listDrawnFeaturesForExport(
    mapId: string,
    provinceId: string,
  ): Promise<ExportFeatureRow[]> {
    return this.databaseService.client<Array<ExportFeatureRow>>`
      WITH drawn_features AS (
        SELECT
          dn.id::text AS id,
          NULL::uuid AS folder_id,
          dn.name AS name,
          dn.description AS description,
          'Point'::text AS geometry_type,
          NULL::text AS source_path,
          NULL::text AS style_url,
          jsonb_build_object(
            'source', 'drawn',
            'style', dn.style
          ) || COALESCE(dn.raw_properties, '{}'::jsonb) AS raw_properties,
          ST_AsGeoJSON(dn.geom) AS geometry_json
        FROM drawn_nodes AS dn
        WHERE dn.map_id = ${mapId}::uuid
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceId}
              AND ST_Intersects(dn.geom, p.geom)
          )

        UNION ALL

        SELECT
          dl.id::text AS id,
          NULL::uuid AS folder_id,
          dl.name AS name,
          dl.description AS description,
          'LineString'::text AS geometry_type,
          NULL::text AS source_path,
          NULL::text AS style_url,
          jsonb_build_object(
            'source', 'drawn',
            'style', dl.style
          ) || COALESCE(dl.raw_properties, '{}'::jsonb) AS raw_properties,
          ST_AsGeoJSON(dl.geom) AS geometry_json
        FROM drawn_lines AS dl
        WHERE dl.map_id = ${mapId}::uuid
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceId}
              AND ST_Intersects(dl.geom, p.geom)
          )

        UNION ALL

        SELECT
          dp.id::text AS id,
          NULL::uuid AS folder_id,
          dp.name AS name,
          dp.description AS description,
          'Polygon'::text AS geometry_type,
          NULL::text AS source_path,
          NULL::text AS style_url,
          jsonb_build_object(
            'source', 'drawn',
            'style', dp.style
          ) || COALESCE(dp.raw_properties, '{}'::jsonb) AS raw_properties,
          ST_AsGeoJSON(dp.geom) AS geometry_json
        FROM drawn_polygons AS dp
        WHERE dp.map_id = ${mapId}::uuid
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceId}
              AND ST_Intersects(dp.geom, p.geom)
          )
      )
      SELECT
        id,
        folder_id AS "folderId",
        name,
        description,
        geometry_type AS "geometryType",
        source_path AS "sourcePath",
        style_url AS "styleUrl",
        raw_properties AS "rawProperties",
        geometry_json AS "geometryJson"
      FROM drawn_features
      ORDER BY geometry_type, name, id
    `;
  }

  private async listDrawnPointFeatures(
    mapId: string,
    provinceId: string,
    bbox: {
      minLng: number;
      minLat: number;
      maxLng: number;
      maxLat: number;
    } | null,
    limit: number,
  ) {
    if (limit <= 0) {
      return [] as DrawnPointFeatureRow[];
    }

    const hasBbox = Boolean(bbox);
    const minLng = bbox?.minLng ?? 0;
    const minLat = bbox?.minLat ?? 0;
    const maxLng = bbox?.maxLng ?? 0;
    const maxLat = bbox?.maxLat ?? 0;

    return this.databaseService.client<Array<DrawnPointFeatureRow>>`
      SELECT
        dn.id::text AS id,
        dn.name AS name,
        dn.description AS description,
        'Point'::text AS geometry_type,
        ST_AsGeoJSON(dn.geom) AS geometry_json,
        dn.raw_properties AS raw_properties,
        dn.style AS style
      FROM drawn_nodes AS dn
      WHERE dn.map_id = ${mapId}::uuid
        AND EXISTS (
          SELECT 1
          FROM provinces AS p
          WHERE p.id = ${provinceId}
            AND ST_Intersects(dn.geom, p.geom)
        )
        AND (
          NOT ${hasBbox}
          OR ST_Intersects(
            dn.geom,
            ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)
          )
        )
      ORDER BY name, id
      LIMIT ${limit}
    `;
  }

  private async listDrawnAreaFeatures(
    mapId: string,
    provinceId: string,
    bbox: {
      minLng: number;
      minLat: number;
      maxLng: number;
      maxLat: number;
    } | null,
    limit: number,
  ) {
    if (limit <= 0) {
      return [] as DrawnFeatureRow[];
    }

    const hasBbox = Boolean(bbox);
    const minLng = bbox?.minLng ?? 0;
    const minLat = bbox?.minLat ?? 0;
    const maxLng = bbox?.maxLng ?? 0;
    const maxLat = bbox?.maxLat ?? 0;

    return this.databaseService.client<Array<DrawnFeatureRow>>`
      WITH drawn_features AS (
        SELECT
          dl.id::text AS id,
          dl.name AS name,
          dl.description AS description,
          'LineString'::text AS geometry_type,
          ST_AsGeoJSON(dl.geom) AS geometry_json,
          dl.raw_properties AS raw_properties,
          dl.style AS style
        FROM drawn_lines AS dl
        WHERE dl.map_id = ${mapId}::uuid
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceId}
              AND ST_Intersects(dl.geom, p.geom)
          )
          AND (
            NOT ${hasBbox}
            OR ST_Intersects(
              dl.geom,
              ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)
            )
          )

        UNION ALL

        SELECT
          dp.id::text AS id,
          dp.name AS name,
          dp.description AS description,
          'Polygon'::text AS geometry_type,
          ST_AsGeoJSON(dp.geom) AS geometry_json,
          dp.raw_properties AS raw_properties,
          dp.style AS style
        FROM drawn_polygons AS dp
        WHERE dp.map_id = ${mapId}::uuid
          AND EXISTS (
            SELECT 1
            FROM provinces AS p
            WHERE p.id = ${provinceId}
              AND ST_Intersects(dp.geom, p.geom)
          )
          AND (
            NOT ${hasBbox}
            OR ST_Intersects(
              dp.geom,
              ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)
            )
          )
      )
      SELECT
        id,
        name,
        description,
        geometry_type,
        geometry_json,
        raw_properties,
        style
      FROM drawn_features
      ORDER BY name, id
      LIMIT ${limit}
    `;
  }

  async registerBootstrapKmz(filePath: string, name?: string) {
    return this.mapImportService.importBootstrapSource(filePath, name);
  }

  async registerUploadedSource(
    file: Parameters<MapImportService['importUploadedSource']>[0],
    name?: string,
    uploadedByUserId?: string | null,
    autoRoute = true,
  ) {
    const result = await this.mapImportService.importUploadedSource(
      file,
      name,
      uploadedByUserId,
      autoRoute,
    );
    const suggestedProvince = await this.getSuggestedProvince(result.map.id);

    return {
      ...result,
      suggestedProvince,
    };
  }

  async suggestProvince(
    mapId: string,
    query?: FolderFilterBodyDto | { folderIds?: string | string[] },
  ) {
    await this.getMapRecord(mapId);
    const folderIds = await this.resolveFolderFilter(mapId, query?.folderIds);
    return this.getSuggestedProvince(mapId, folderIds ?? undefined);
  }

  private async getSuggestedProvince(mapId: string, folderIds?: string[]) {
    if (folderIds && folderIds.length === 0) {
      return null;
    }

    const hasFolderFilter = Boolean(folderIds);
    const folderIdArray = this.databaseService.client.array(folderIds ?? []);

    const [row] = await this.databaseService.client<SuggestedProvinceRow[]>`
      WITH selected_features AS MATERIALIZED (
        SELECT id, geometry_type, geom
        FROM map_features
        WHERE map_id = ${mapId}::uuid
          AND geom IS NOT NULL
          AND (
            NOT ${hasFolderFilter}
            OR folder_id = ANY(${folderIdArray}::uuid[])
          )
      )
      SELECT
        p.id,
        p.name,
        count(sf.id)::int AS feature_count,
        count(sf.id) FILTER (
          WHERE COALESCE(sf.geometry_type, '') IN ('Point', 'MultiPoint')
        )::int AS point_count
      FROM provinces AS p
      JOIN selected_features AS sf
        ON ST_Intersects(sf.geom, p.geom)
      GROUP BY p.id, p.name
      ORDER BY feature_count DESC, point_count DESC, p.name
      LIMIT 1
    `;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      featureCount: Number(row.feature_count),
      pointCount: Number(row.point_count),
    };
  }

  private async getMapRecord(mapId: string) {
    const cached = this.mapRecordCache.get(mapId);
    if (cached) {
      return cached;
    }

    const pending = this.loadMapRecord(mapId);
    this.mapRecordCache.set(mapId, pending);

    try {
      return await pending;
    } catch (error) {
      this.mapRecordCache.delete(mapId);
      throw error;
    }
  }

  private async loadMapRecord(mapId: string) {
    const [mapRecord] = await this.databaseService.db
      .select()
      .from(maps)
      .where(eq(maps.id, mapId))
      .limit(1);

    if (!mapRecord) {
      throw new NotFoundException(`Map ${mapId} was not found.`);
    }

    return mapRecord;
  }

  private async getProvinceRecord(provinceId: string) {
    const provinceRecord = await this.findProvinceRecord(provinceId);
    if (!provinceRecord) {
      throw new NotFoundException(`Province ${provinceId} was not found.`);
    }

    return provinceRecord;
  }

  private async findProvinceRecord(
    provinceId: string,
  ): Promise<ProvinceRecord | null> {
    const cached = this.provinceRecordCache.get(provinceId);
    if (cached) {
      return cached;
    }

    const pending = this.loadProvinceRecord(provinceId);
    this.provinceRecordCache.set(provinceId, pending);

    try {
      return await pending;
    } catch (error) {
      this.provinceRecordCache.delete(provinceId);
      throw error;
    }
  }

  private async loadProvinceRecord(
    provinceId: string,
  ): Promise<ProvinceRecord | null> {
    const [provinceRecord] = await this.databaseService.db
      .select({
        id: provinces.id,
        name: provinces.name,
      })
      .from(provinces)
      .where(eq(provinces.id, provinceId))
      .limit(1);

    return provinceRecord ?? null;
  }

  private async resolveStyleLookup(
    mapRecord: Pick<MapRecord, 'id' | 'updatedAt' | 'sourceDocumentPath'>,
    styleUrls: Array<string | null | undefined>,
  ) {
    const uniqueStyleUrls = [
      ...new Set(
        styleUrls.filter((styleUrl): styleUrl is string => Boolean(styleUrl)),
      ),
    ];

    if (uniqueStyleUrls.length === 0) {
      return new Map<string, ResolvedFeatureStyle | null>();
    }

    try {
      const resolvedStyles: Array<[string, ResolvedFeatureStyle | null]> =
        await Promise.all(
          uniqueStyleUrls.map(async (styleUrl) => {
            const resolvedStyle =
              await this.mapStyleResolverService.resolveFeatureStyle(
                mapRecord,
                styleUrl,
              );

            return [styleUrl, resolvedStyle] as [
              string,
              ResolvedFeatureStyle | null,
            ];
          }),
        );

      return new Map(resolvedStyles);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown KML style resolution failure';
      this.logger.warn(
        `Map style resolution failed for ${mapRecord.id}: ${message}`,
      );
      return new Map<string, ResolvedFeatureStyle | null>();
    }
  }

  private async removePreservedImportedSource(
    mapId: string,
    storagePath: string,
  ) {
    const resolvedStoragePath = resolve(storagePath);
    if (!isPathInside(IMPORTED_SOURCE_STORAGE_DIRECTORY, resolvedStoragePath)) {
      return;
    }

    const parentDirectory = dirname(resolvedStoragePath);
    const cleanupTarget = isPathInside(
      IMPORTED_SOURCE_STORAGE_DIRECTORY,
      parentDirectory,
    )
      ? parentDirectory
      : resolvedStoragePath;

    try {
      await rm(cleanupTarget, { force: true, recursive: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown file removal error';
      this.logger.warn(
        `Unable to remove stored source for map package ${mapId}: ${message}`,
      );
    }
  }

  private assertTileCoordinates(z: number, x: number, y: number) {
    if (!Number.isInteger(z) || z < MIN_TILE_ZOOM || z > MAX_TILE_ZOOM) {
      throw new BadRequestException(
        `Tile zoom must be between ${MIN_TILE_ZOOM} and ${MAX_TILE_ZOOM}.`,
      );
    }

    const maxCoordinate = 2 ** z - 1;

    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x > maxCoordinate ||
      y > maxCoordinate
    ) {
      throw new BadRequestException(
        `Tile coordinates must be between 0 and ${maxCoordinate} for zoom ${z}.`,
      );
    }
  }

  private parseBbox(value?: string) {
    if (!value) {
      return null;
    }

    const [minLng, minLat, maxLng, maxLat] = value
      .split(',')
      .map((item) => Number(item.trim()));

    if (
      [minLng, minLat, maxLng, maxLat].some((item) => !Number.isFinite(item)) ||
      minLng >= maxLng ||
      minLat >= maxLat
    ) {
      return null;
    }

    return {
      minLng,
      minLat,
      maxLng,
      maxLat,
    };
  }

  private async resolveFolderFilter(
    mapId: string,
    rawFolderIds?: string | string[],
    options: { includeDescendants?: boolean } = {},
  ) {
    if (rawFolderIds === undefined) {
      return null;
    }

    const requestedFolderIds = (
      Array.isArray(rawFolderIds) ? rawFolderIds : rawFolderIds.split(',')
    )
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value,
        ),
      );

    if (requestedFolderIds.length === 0) {
      return [] as string[];
    }

    const uniqueFolderIds = [...new Set(requestedFolderIds)];

    if (options.includeDescendants) {
      const requestedFolderIdArray =
        this.databaseService.client.array(uniqueFolderIds);
      const rows = await this.databaseService.client<Array<{ id: string }>>`
        WITH RECURSIVE selected_folders AS (
          SELECT id
          FROM map_folders
          WHERE map_id = ${mapId}::uuid
            AND id = ANY(${requestedFolderIdArray}::uuid[])

          UNION ALL

          SELECT child.id
          FROM map_folders AS child
          INNER JOIN selected_folders AS parent
            ON child.parent_id = parent.id
          WHERE child.map_id = ${mapId}::uuid
        )
        SELECT DISTINCT id::text AS id
        FROM selected_folders
      `;

      return rows.map((row) => row.id);
    }

    const rows = await this.databaseService.db
      .select({
        id: mapFolders.id,
      })
      .from(mapFolders)
      .where(
        and(
          eq(mapFolders.mapId, mapId),
          inArray(mapFolders.id, uniqueFolderIds),
        ),
      );

    return rows.map((row) => row.id);
  }
}
