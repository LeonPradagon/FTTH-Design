import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { geometry, timestamps } from './_helpers';

export const provinces = pgTable(
  'provinces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    rawProperties: jsonb('raw_properties').$type<Record<string, unknown>>(),
    geom: geometry('geom', 'MultiPolygon', 4326).notNull(),
    ...timestamps,
  },
  (table) => [
    index('provinces_name_idx').on(table.name),
    index('provinces_geom_idx').using('gist', table.geom),
  ],
);

export type ProvinceRecord = typeof provinces.$inferSelect;
export type NewProvinceRecord = typeof provinces.$inferInsert;
