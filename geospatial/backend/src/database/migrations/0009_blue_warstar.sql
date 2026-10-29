ALTER TABLE "users" ADD COLUMN "app_access" text[] DEFAULT ARRAY['geospatial']::text[] NOT NULL;
