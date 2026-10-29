import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { geometry, timestamps } from './_helpers';
import { mapFolders } from './map-folders.schema';
import { maps } from './maps.schema';

export const mapFeatures = pgTable(
  'map_features',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mapId: uuid('map_id')
      .references(() => maps.id, { onDelete: 'cascade' })
      .notNull(),
    folderId: uuid('folder_id')
      .references(() => mapFolders.id, { onDelete: 'cascade' })
      .notNull(),
    sourceFeatureId: text('source_feature_id'),
    sourcePath: text('source_path').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    visibility: boolean('visibility').default(true).notNull(),
    geometryType: varchar('geometry_type', { length: 32 }),
    geom: geometry('geom', 'Geometry', 4326),
    styleUrl: text('style_url'),
    rawProperties: jsonb('raw_properties').$type<Record<string, unknown>>(),
    sortOrder: integer('sort_order').notNull(),
    ...timestamps,
  },
  (table) => [
    index('map_features_map_id_folder_id_idx').on(table.mapId, table.folderId),
    index('map_features_geom_idx').using('gist', table.geom),
    uniqueIndex('map_features_map_id_source_path_unique').on(
      table.mapId,
      table.sourcePath,
    ),
  ],
);

export type MapFeatureRecord = typeof mapFeatures.$inferSelect;
export type NewMapFeatureRecord = typeof mapFeatures.$inferInsert;
