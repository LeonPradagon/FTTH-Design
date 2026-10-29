import { customType, timestamp } from 'drizzle-orm/pg-core';

type GeometryKind =
  | 'Geometry'
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPoint'
  | 'MultiLineString'
  | 'MultiPolygon';

export const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => timestamptz('created_at').defaultNow().notNull();
export const updatedAt = () => timestamptz('updated_at').defaultNow().notNull();

export const timestamps = {
  createdAt: createdAt(),
  updatedAt: updatedAt(),
};

export const geometry = (
  name: string,
  geometryType: GeometryKind = 'Geometry',
  srid = 4326,
) =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return `geometry(${geometryType},${srid})`;
    },
  })(name);
