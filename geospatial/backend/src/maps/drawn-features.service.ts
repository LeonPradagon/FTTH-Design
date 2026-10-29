import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { maps } from '../database/schemas';
import { CreateDrawnFeatureDto } from './dto/create-drawn-feature.dto';
import { UpdateDrawnFeatureDto } from './dto/update-drawn-feature.dto';
import { GraphHopperRoutingService } from './graphhopper-routing.service';

type PointGeometry = {
  type: 'Point';
  coordinates: [number, number];
};

type LineStringGeometry = {
  type: 'LineString';
  coordinates: [number, number][];
};

type PolygonGeometry = {
  type: 'Polygon';
  coordinates: [Array<[number, number]>, ...Array<Array<[number, number]>>];
};

type SupportedGeometry = PointGeometry | LineStringGeometry | PolygonGeometry;

type CreatedDrawnFeatureRow = {
  id: string;
  map_id: string;
  name: string;
  description: string | null;
  geometry_json: string;
  raw_properties: Record<string, unknown> | null;
  style: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

@Injectable()
export class DrawnFeaturesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly graphHopperRoutingService: GraphHopperRoutingService,
  ) {}

  async create(mapId: string, payload: CreateDrawnFeatureDto) {
    await this.assertMapExists(mapId);

    const sourceGeometry = this.normalizeGeometry(payload.geometry);
    const rawProperties = this.normalizeObject(payload.rawProperties) ?? {};
    const routedLine = await this.routeLineForCreate(
      sourceGeometry,
      rawProperties,
    );
    const geometry = routedLine.geometry;
    const geometryJson = JSON.stringify(geometry);
    const name = this.normalizeName(payload.name, geometry.type);
    const description = this.normalizeText(payload.description);
    const style = this.normalizeObject(payload.style);
    const styleJson = style ? JSON.stringify(style) : null;
    const rawPropertiesJson =
      Object.keys(rawProperties).length > 0
        ? JSON.stringify(rawProperties)
        : null;

    if (geometry.type === 'Point') {
      const [row] = await this.databaseService.client<
        Array<CreatedDrawnFeatureRow>
      >`
        INSERT INTO drawn_nodes ("map_id", "name", "description", "geom", "style", "raw_properties", "created_at", "updated_at")
        VALUES (
          ${mapId}::uuid,
          ${name},
          ${description},
          ST_SetSRID(ST_GeomFromGeoJSON(${geometryJson}), 4326),
          ${styleJson}::jsonb,
          ${rawPropertiesJson}::jsonb,
          NOW(),
          NOW()
        )
        RETURNING
          id::text AS id,
          map_id::text AS map_id,
          name,
          description,
          ST_AsGeoJSON(geom) AS geometry_json,
          raw_properties,
          style,
          created_at::text AS created_at,
          updated_at::text AS updated_at
      `;

      return this.toFeatureResponse(row, geometry.type);
    }

    if (geometry.type === 'LineString') {
      const [row] = await this.databaseService.client<
        Array<CreatedDrawnFeatureRow>
      >`
        INSERT INTO drawn_lines ("map_id", "name", "description", "geom", "style", "raw_properties", "created_at", "updated_at")
        VALUES (
          ${mapId}::uuid,
          ${name},
          ${description},
          ST_SetSRID(ST_GeomFromGeoJSON(${geometryJson}), 4326),
          ${styleJson}::jsonb,
          ${rawPropertiesJson}::jsonb,
          NOW(),
          NOW()
        )
        RETURNING
          id::text AS id,
          map_id::text AS map_id,
          name,
          description,
          ST_AsGeoJSON(geom) AS geometry_json,
          raw_properties,
          style,
          created_at::text AS created_at,
          updated_at::text AS updated_at
      `;

      return this.toFeatureResponse(row, geometry.type);
    }

    const [row] = await this.databaseService.client<
      Array<CreatedDrawnFeatureRow>
    >`
      INSERT INTO drawn_polygons ("map_id", "name", "description", "geom", "style", "raw_properties", "created_at", "updated_at")
      VALUES (
        ${mapId}::uuid,
        ${name},
        ${description},
        ST_SetSRID(ST_GeomFromGeoJSON(${geometryJson}), 4326),
        ${styleJson}::jsonb,
        ${rawPropertiesJson}::jsonb,
        NOW(),
        NOW()
      )
      RETURNING
        id::text AS id,
        map_id::text AS map_id,
        name,
        description,
        ST_AsGeoJSON(geom) AS geometry_json,
        raw_properties,
        style,
        created_at::text AS created_at,
        updated_at::text AS updated_at
    `;

    return this.toFeatureResponse(row, geometry.type);
  }

  async update(
    mapId: string,
    featureId: string,
    payload: UpdateDrawnFeatureDto,
  ) {
    await this.assertMapExists(mapId);

    const geometryType = this.normalizeGeometryType(payload.geometryType);
    const name = this.normalizeName(payload.name, geometryType);
    const description = this.normalizeText(payload.description);
    const style = this.normalizeObject(payload.style);
    const rawProperties = this.normalizeObject(payload.rawProperties);
    const styleJson = style ? JSON.stringify(style) : null;
    const rawPropertiesJson = rawProperties
      ? JSON.stringify(rawProperties)
      : null;
    const tableName = this.drawnTableName(geometryType);

    const [row] = await this.databaseService.client<
      Array<CreatedDrawnFeatureRow>
    >`
      UPDATE ${this.databaseService.client(tableName)}
      SET
        name = ${name},
        description = ${description},
        style = ${styleJson}::jsonb,
        raw_properties = ${rawPropertiesJson}::jsonb,
        updated_at = NOW()
      WHERE id = ${featureId}::uuid
        AND map_id = ${mapId}::uuid
      RETURNING
        id::text AS id,
        map_id::text AS map_id,
        name,
        description,
        ST_AsGeoJSON(geom) AS geometry_json,
        raw_properties,
        style,
        created_at::text AS created_at,
        updated_at::text AS updated_at
    `;

    if (!row) {
      throw new NotFoundException(`Drawn feature ${featureId} was not found.`);
    }

    return this.toFeatureResponse(row, geometryType);
  }

  async remove(
    mapId: string,
    featureId: string,
    geometryType: UpdateDrawnFeatureDto['geometryType'],
  ) {
    await this.assertMapExists(mapId);

    const normalizedGeometryType = this.normalizeGeometryType(geometryType);
    const tableName = this.drawnTableName(normalizedGeometryType);
    const [row] = await this.databaseService.client<Array<{ id: string }>>`
      DELETE FROM ${this.databaseService.client(tableName)}
      WHERE id = ${featureId}::uuid
        AND map_id = ${mapId}::uuid
      RETURNING id::text AS id
    `;

    if (!row) {
      throw new NotFoundException(`Drawn feature ${featureId} was not found.`);
    }

    return {
      success: true,
      deletedFeatureId: row.id,
      geometryType: normalizedGeometryType,
    };
  }

  private async assertMapExists(mapId: string) {
    const [mapRecord] = await this.databaseService.db
      .select({ id: maps.id })
      .from(maps)
      .where(eq(maps.id, mapId))
      .limit(1);

    if (!mapRecord) {
      throw new NotFoundException(`Map ${mapId} was not found.`);
    }
  }

  private async routeLineForCreate(
    geometry: SupportedGeometry,
    rawProperties: Record<string, unknown>,
  ): Promise<{ geometry: SupportedGeometry }> {
    if (geometry.type !== 'LineString') {
      return { geometry };
    }

    if (rawProperties.routeProvider === 'graphhopper') {
      rawProperties.routeStatus = rawProperties.routeStatus ?? 'routed';
      return { geometry };
    }

    rawProperties.originalGeometry = {
      type: 'LineString',
      coordinates: geometry.coordinates,
    };
    rawProperties.originalGeometryPreserved = true;
    rawProperties.routeMode = 'drawn-auto-routed';

    try {
      const route = await this.graphHopperRoutingService.routeLine(
        geometry.coordinates,
      );

      rawProperties.routeProvider = route.provider;
      rawProperties.routeCosting = route.costing;
      rawProperties.routeDistanceMeters = route.distanceMeters;
      rawProperties.routeDurationSeconds = route.durationSeconds;
      rawProperties.routeFallbackUsed = route.fallbackUsed;
      rawProperties.routeWarnings = route.warnings;
      rawProperties.routeStatus = 'routed';

      return { geometry: route.geometry };
    } catch (error) {
      rawProperties.routeProvider = 'graphhopper';
      rawProperties.routeStatus = 'failed';
      rawProperties.routeError =
        error instanceof Error ? error.message : 'Auto route failed.';
      rawProperties.routeWarnings = [
        'Auto route failed; original geometry was kept.',
      ];
      return { geometry };
    }
  }

  private normalizeGeometry(value: Record<string, unknown>): SupportedGeometry {
    const geometryType = typeof value.type === 'string' ? value.type : null;

    if (geometryType === 'Point') {
      const coordinates = this.parsePoint(value.coordinates);
      return {
        type: 'Point',
        coordinates,
      };
    }

    if (geometryType === 'LineString') {
      const coordinates = this.parseLineString(value.coordinates);
      return {
        type: 'LineString',
        coordinates,
      };
    }

    if (geometryType === 'Polygon') {
      const coordinates = this.parsePolygon(value.coordinates);
      return {
        type: 'Polygon',
        coordinates,
      };
    }

    throw new BadRequestException(
      'Unsupported drawn geometry type. Only Point, LineString, and Polygon are allowed.',
    );
  }

  private parsePoint(value: unknown): [number, number] {
    if (
      !Array.isArray(value) ||
      value.length < 2 ||
      !Number.isFinite(value[0]) ||
      !Number.isFinite(value[1])
    ) {
      throw new BadRequestException(
        'Point coordinates must contain [longitude, latitude].',
      );
    }

    return [Number(value[0]), Number(value[1])];
  }

  private parseLineString(value: unknown): [number, number][] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(
        'LineString coordinates must be an array of positions.',
      );
    }

    const coordinates = value.map((position) => this.parsePoint(position));

    if (coordinates.length < 2) {
      throw new BadRequestException(
        'LineString geometries require at least 2 positions.',
      );
    }

    return coordinates;
  }

  private parsePolygon(
    value: unknown,
  ): [Array<[number, number]>, ...Array<Array<[number, number]>>] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new BadRequestException(
        'Polygon coordinates must include at least one ring.',
      );
    }

    const rings = value.map((ring, ringIndex) => {
      if (!Array.isArray(ring)) {
        throw new BadRequestException(
          'Polygon rings must be arrays of positions.',
        );
      }

      const coordinates = ring.map((position) => this.parsePoint(position));

      if (coordinates.length < 4) {
        throw new BadRequestException(
          `Polygon ring ${ringIndex + 1} must contain at least 4 positions.`,
        );
      }

      const [firstLng, firstLat] = coordinates[0];
      const [lastLng, lastLat] = coordinates[coordinates.length - 1];

      if (firstLng !== lastLng || firstLat !== lastLat) {
        throw new BadRequestException(
          `Polygon ring ${ringIndex + 1} must be closed.`,
        );
      }

      return coordinates;
    });

    return rings as [
      Array<[number, number]>,
      ...Array<Array<[number, number]>>,
    ];
  }

  private normalizeName(
    value: string | undefined,
    geometryType: SupportedGeometry['type'],
  ) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }

    if (geometryType === 'Point') {
      return 'Drawn node';
    }

    if (geometryType === 'LineString') {
      return 'Drawn line';
    }

    return 'Drawn polygon';
  }

  private normalizeText(value: string | undefined) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private normalizeObject(value: Record<string, unknown> | undefined) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return Object.keys(value).length > 0 ? value : null;
  }

  private normalizeGeometryType(value: string): SupportedGeometry['type'] {
    if (value === 'Point' || value === 'LineString' || value === 'Polygon') {
      return value;
    }

    throw new BadRequestException(
      'Unsupported drawn geometry type. Only Point, LineString, and Polygon are allowed.',
    );
  }

  private drawnTableName(geometryType: SupportedGeometry['type']) {
    if (geometryType === 'Point') {
      return 'drawn_nodes';
    }

    if (geometryType === 'LineString') {
      return 'drawn_lines';
    }

    return 'drawn_polygons';
  }

  private toFeatureResponse(
    row: CreatedDrawnFeatureRow | undefined,
    geometryType: SupportedGeometry['type'],
  ) {
    if (!row) {
      throw new BadRequestException('The drawn feature could not be saved.');
    }

    return {
      type: 'Feature' as const,
      id: row.id,
      geometry: JSON.parse(row.geometry_json),
      properties: {
        mapId: row.map_id,
        name: row.name,
        description: row.description,
        geometryType,
        sourcePath: null,
        style: row.style,
        rawProperties: {
          ...(row.raw_properties ?? {}),
          source: 'drawn',
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  }
}
