import {
  desc,
  type InferInsertModel,
  type InferSelectModel,
} from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { geometry, timestamps } from './_helpers';
import { users } from './users.schema';

export const maps = pgTable(
  'maps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    originalFilename: text('original_filename').notNull(),
    storedFilename: text('stored_filename').notNull(),
    storagePath: text('storage_path').notNull(),
    mimeType: varchar('mime_type', { length: 255 }),
    sourceKind: varchar('source_kind', { length: 32 })
      .default('kmz_archive')
      .notNull(),
    sourceDocumentPath: text('source_document_path'),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    importStatus: varchar('import_status', { length: 32 })
      .default('uploaded')
      .notNull(),
    importError: text('import_error'),
    catalogRootName: text('catalog_root_name'),
    folderCount: integer('folder_count').default(0).notNull(),
    featureCount: integer('feature_count').default(0).notNull(),
    pointCount: integer('point_count').default(0).notNull(),
    lineStringCount: integer('line_string_count').default(0).notNull(),
    polygonCount: integer('polygon_count').default(0).notNull(),
    nodeCount: integer('node_count').default(0).notNull(),
    footprint: geometry('footprint', 'MultiPolygon', 4326),
    ...timestamps,
  },
  (table) => [
    index('maps_created_at_idx').on(table.createdAt),
    index('maps_uploaded_by_user_id_idx').on(table.uploadedByUserId),
  ],
);

export const mapsDefaultOrder = desc(maps.createdAt);

export type MapRecord = InferSelectModel<typeof maps>;
export type NewMapRecord = InferInsertModel<typeof maps>;
