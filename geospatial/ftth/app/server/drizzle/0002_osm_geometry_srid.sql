DO $$ BEGIN
    IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = '"osm_data"."building"'::regclass AND attname = 'geom') <> 'geometry(Geometry,4326)' THEN
        ALTER TABLE "osm_data"."building" ALTER COLUMN "geom" SET DATA TYPE geometry(Geometry, 4326);
    END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = '"osm_data"."dataset"'::regclass AND attname = 'coverage') <> 'geometry(Polygon,4326)' THEN
        ALTER TABLE "osm_data"."dataset" ALTER COLUMN "coverage" SET DATA TYPE geometry(Polygon, 4326);
    END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = '"osm_data"."poi"'::regclass AND attname = 'geom') <> 'geometry(Geometry,4326)' THEN
        ALTER TABLE "osm_data"."poi" ALTER COLUMN "geom" SET DATA TYPE geometry(Geometry, 4326);
    END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = '"osm_data"."road_edge"'::regclass AND attname = 'geom') <> 'geometry(LineString,4326)' THEN
        ALTER TABLE "osm_data"."road_edge" ALTER COLUMN "geom" SET DATA TYPE geometry(LineString, 4326);
    END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = '"osm_data"."road_node"'::regclass AND attname = 'geom') <> 'geometry(Point,4326)' THEN
        ALTER TABLE "osm_data"."road_node" ALTER COLUMN "geom" SET DATA TYPE geometry(Point, 4326);
    END IF;
END $$;
