import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseService } from '../database/database.service';
import { provinces } from '../database/schemas';

type ProvinceGeoJsonGeometry =
  | {
      type: 'Polygon';
      coordinates: number[][][];
    }
  | {
      type: 'MultiPolygon';
      coordinates: number[][][][];
    };

type ProvinceGeoJsonFeature = {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: ProvinceGeoJsonGeometry | null;
};

type ProvinceGeoJsonCollection = {
  type: 'FeatureCollection';
  features: ProvinceGeoJsonFeature[];
};

@Injectable()
export class RegionsService {
  private readonly logger = new Logger(RegionsService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async listProvinces() {
    const rows = await this.databaseService.db
      .select({
        id: provinces.id,
        name: provinces.name,
        rawProperties: provinces.rawProperties,
        geometryJson: sql<string>`ST_AsGeoJSON(${provinces.geom})`,
      })
      .from(provinces)
      .orderBy(provinces.name);

    return {
      type: 'FeatureCollection' as const,
      features: rows.map((row) => ({
        type: 'Feature' as const,
        id: row.id,
        geometry: JSON.parse(row.geometryJson),
        properties: {
          provinceId: row.id,
          name: row.name,
          rawProperties: row.rawProperties ?? null,
        },
      })),
    };
  }

  async ensureBundledProvincesImported() {
    const [row] = await this.databaseService.client<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM provinces
    `;

    if ((row?.count ?? 0) > 0) {
      return {
        imported: false,
        count: row.count,
      };
    }

    const importSummary = await this.importBundledProvinces();
    this.logger.log(
      `Seeded ${importSummary.count} provinces from bundled GeoJSON.`,
    );

    return {
      imported: true,
      count: importSummary.count,
    };
  }

  async importBundledProvinces() {
    const collection = await this.loadBundledProvinceCollection();
    const normalizedFeatures = collection.features
      .map((feature) => this.normalizeProvinceFeature(feature))
      .filter((feature): feature is NonNullable<typeof feature> =>
        Boolean(feature),
      );
    const mergedFeatures = new Map<
      string,
      {
        id: string;
        name: string;
        rawProperties: Record<string, unknown>;
        coordinates: number[][][][];
      }
    >();

    for (const feature of normalizedFeatures) {
      const existing = mergedFeatures.get(feature.id);

      if (existing) {
        existing.coordinates.push(...feature.coordinates);
        continue;
      }

      mergedFeatures.set(feature.id, {
        id: feature.id,
        name: feature.name,
        rawProperties: feature.rawProperties,
        coordinates: [...feature.coordinates],
      });
    }

    await this.databaseService.db.delete(provinces);

    for (const feature of mergedFeatures.values()) {
      const rawPropertiesJson = JSON.stringify(feature.rawProperties);
      const geometryJson = JSON.stringify({
        type: 'MultiPolygon',
        coordinates: feature.coordinates,
      });

      await this.databaseService.client`
        INSERT INTO provinces ("id", "name", "raw_properties", "geom", "created_at", "updated_at")
        VALUES (
          ${feature.id},
          ${feature.name},
          ${rawPropertiesJson}::jsonb,
          ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geometryJson}), 4326)),
          NOW(),
          NOW()
        )
      `;
    }

    return {
      count: mergedFeatures.size,
    };
  }

  private async loadBundledProvinceCollection(): Promise<ProvinceGeoJsonCollection> {
    const filePath = resolve(
      process.cwd(),
      'src/regions/data/indonesia-38-provinces.geojson',
    );
    const fileContents = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(fileContents) as ProvinceGeoJsonCollection;

    if (
      parsed.type !== 'FeatureCollection' ||
      !Array.isArray(parsed.features)
    ) {
      throw new Error(
        'Bundled provinces file is not a valid GeoJSON FeatureCollection.',
      );
    }

    return parsed;
  }

  private normalizeProvinceFeature(feature: ProvinceGeoJsonFeature) {
    if (!feature.geometry) {
      return null;
    }

    const provinceId = String(
      feature.properties.KODE_PROV ?? feature.properties.id ?? '',
    ).trim();
    const provinceName = String(
      feature.properties.PROVINSI ?? feature.properties.name ?? '',
    ).trim();

    if (!provinceId || !provinceName) {
      this.logger.warn('Skipping province feature with missing code or name.');
      return null;
    }

    return {
      id: provinceId,
      name: provinceName,
      rawProperties: feature.properties,
      coordinates:
        feature.geometry.type === 'Polygon'
          ? [feature.geometry.coordinates]
          : feature.geometry.coordinates,
    };
  }
}
