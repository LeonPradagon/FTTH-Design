import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schemas';

const DEFAULT_DATABASE_URL =
  'postgres://postgres:postgres@db:5432/geospatial_app';

export interface DatabaseHealthSnapshot {
  status: 'up' | 'degraded';
  database: string;
  databaseVersion: string;
  postgisEnabled: boolean;
  postgisVersion: string | null;
  checkedAt: string;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly client: ReturnType<typeof postgres>;
  readonly db: PostgresJsDatabase<typeof schema>;

  constructor(private readonly configService: ConfigService) {
    const databaseUrl =
      this.configService.get<string>('DATABASE_URL') ?? DEFAULT_DATABASE_URL;
    const databasePoolMax =
      this.configService.get<number>('DATABASE_POOL_MAX') ?? 10;

    this.client = postgres(databaseUrl, {
      max: Math.max(1, databasePoolMax),
      prepare: false,
    });
    this.db = drizzle(this.client, { schema });
  }

  async ensurePostgis(): Promise<void> {
    await this.client`CREATE EXTENSION IF NOT EXISTS postgis`;
  }

  async checkHealth(): Promise<DatabaseHealthSnapshot> {
    const [row] = await this.client<
      Array<{
        checked_at: string;
        database_name: string;
        database_version: string;
        postgis_enabled: boolean;
        postgis_version: string | null;
      }>
    >`
      SELECT
        NOW()::text AS checked_at,
        current_database() AS database_name,
        version() AS database_version,
        EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS postgis_enabled,
        (SELECT extversion FROM pg_extension WHERE extname = 'postgis') AS postgis_version
    `;

    return {
      status: row.postgis_enabled ? 'up' : 'degraded',
      database: row.database_name,
      databaseVersion: row.database_version,
      postgisEnabled: row.postgis_enabled,
      postgisVersion: row.postgis_version,
      checkedAt: row.checked_at,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.end();
  }
}
