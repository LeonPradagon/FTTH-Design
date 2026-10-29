import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { geometry, timestamps } from './_helpers';
import { maps } from './maps.schema';

export const drawnPolygons = pgTable(
  'drawn_polygons',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mapId: uuid('map_id')
      .references(() => maps.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    description: text('description'),
    geom: geometry('geom', 'Polygon', 4326).notNull(),
    style: jsonb('style').$type<Record<string, unknown>>(),
    rawProperties: jsonb('raw_properties').$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    index('drawn_polygons_map_id_idx').on(table.mapId),
    index('drawn_polygons_geom_idx').using('gist', table.geom),
  ],
);

export type DrawnPolygonRecord = typeof drawnPolygons.$inferSelect;
export type NewDrawnPolygonRecord = typeof drawnPolygons.$inferInsert;
