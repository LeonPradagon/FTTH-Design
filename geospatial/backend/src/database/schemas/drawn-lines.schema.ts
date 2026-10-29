import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { geometry, timestamps } from './_helpers';
import { maps } from './maps.schema';

export const drawnLines = pgTable(
  'drawn_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mapId: uuid('map_id')
      .references(() => maps.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    description: text('description'),
    geom: geometry('geom', 'LineString', 4326).notNull(),
    style: jsonb('style').$type<Record<string, unknown>>(),
    rawProperties: jsonb('raw_properties').$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    index('drawn_lines_map_id_idx').on(table.mapId),
    index('drawn_lines_geom_idx').using('gist', table.geom),
  ],
);

export type DrawnLineRecord = typeof drawnLines.$inferSelect;
export type NewDrawnLineRecord = typeof drawnLines.$inferInsert;
