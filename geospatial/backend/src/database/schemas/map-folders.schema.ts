import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps } from './_helpers';
import { maps } from './maps.schema';

export const mapFolders = pgTable(
  'map_folders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mapId: uuid('map_id')
      .references(() => maps.id, { onDelete: 'cascade' })
      .notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => mapFolders.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    sourcePath: text('source_path').notNull(),
    displayPath: text('display_path').notNull(),
    depth: integer('depth').notNull(),
    sortOrder: integer('sort_order').notNull(),
    isOpenByDefault: boolean('is_open_by_default').default(false).notNull(),
    childFolderCount: integer('child_folder_count').default(0).notNull(),
    descendantFolderCount: integer('descendant_folder_count')
      .default(0)
      .notNull(),
    directFeatureCount: integer('direct_feature_count').default(0).notNull(),
    descendantFeatureCount: integer('descendant_feature_count')
      .default(0)
      .notNull(),
    ...timestamps,
  },
  (table) => [
    index('map_folders_map_id_parent_id_idx').on(table.mapId, table.parentId),
    uniqueIndex('map_folders_map_id_source_path_unique').on(
      table.mapId,
      table.sourcePath,
    ),
  ],
);

export type MapFolderRecord = typeof mapFolders.$inferSelect;
export type NewMapFolderRecord = typeof mapFolders.$inferInsert;
