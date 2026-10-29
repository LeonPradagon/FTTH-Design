import {
  index,
  jsonb,
  pgTable,
  uniqueIndex,
  uuid,
  text,
} from 'drizzle-orm/pg-core';
import { geometry, timestamps } from './_helpers';
import { mapFeatures } from './map-features.schema';
import { maps } from './maps.schema';

export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mapId: uuid('map_id')
      .references(() => maps.id, { onDelete: 'cascade' })
      .notNull(),
    importedFeatureId: uuid('imported_feature_id').references(
      () => mapFeatures.id,
      {
        onDelete: 'set null',
      },
    ),
    name: text('name').notNull(),
    geom: geometry('geom', 'Point', 4326).notNull(),
    sourceProperties:
      jsonb('source_properties').$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    index('nodes_map_id_idx').on(table.mapId),
    index('nodes_geom_idx').using('gist', table.geom),
    uniqueIndex('nodes_imported_feature_id_unique').on(table.importedFeatureId),
  ],
);

export type NodeRecord = typeof nodes.$inferSelect;
export type NewNodeRecord = typeof nodes.$inferInsert;
