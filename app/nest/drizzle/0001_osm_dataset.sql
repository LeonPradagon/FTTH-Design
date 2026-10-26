CREATE SCHEMA IF NOT EXISTS "osm_data";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "osm_data"."building" (
	"dataset_id" text NOT NULL,
	"osm_id" bigint NOT NULL,
	"geom" geometry NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "osm_data"."dataset" (
	"dataset_id" text PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source_url" text NOT NULL,
	"source_timestamp" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checksum" text,
	"status" text NOT NULL,
	"coverage" geometry NOT NULL,
	"building_count" integer DEFAULT 0 NOT NULL,
	"road_node_count" integer DEFAULT 0 NOT NULL,
	"road_edge_count" integer DEFAULT 0 NOT NULL,
	"poi_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "dataset_status_check" CHECK ("osm_data"."dataset"."status" IN ('staging', 'active', 'failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "osm_data"."poi" (
	"dataset_id" text NOT NULL,
	"poi_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"geom" geometry NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "osm_data"."road_edge" (
	"dataset_id" text NOT NULL,
	"edge_id" text NOT NULL,
	"source_node" bigint NOT NULL,
	"target_node" bigint NOT NULL,
	"edge_index" integer DEFAULT 0 NOT NULL,
	"geom" geometry NOT NULL,
	"highway" text,
	"length_m" double precision,
	"oneway" boolean,
	"name" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "osm_data"."road_node" (
	"dataset_id" text NOT NULL,
	"node_id" bigint NOT NULL,
	"geom" geometry NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"osm_data"."building"'::regclass AND confrelid = '"osm_data"."dataset"'::regclass AND contype = 'f') THEN ALTER TABLE "osm_data"."building" ADD CONSTRAINT "building_dataset_id_dataset_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "osm_data"."dataset"("dataset_id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"osm_data"."poi"'::regclass AND confrelid = '"osm_data"."dataset"'::regclass AND contype = 'f') THEN ALTER TABLE "osm_data"."poi" ADD CONSTRAINT "poi_dataset_id_dataset_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "osm_data"."dataset"("dataset_id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"osm_data"."road_edge"'::regclass AND confrelid = '"osm_data"."dataset"'::regclass AND contype = 'f') THEN ALTER TABLE "osm_data"."road_edge" ADD CONSTRAINT "road_edge_dataset_id_dataset_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "osm_data"."dataset"("dataset_id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"osm_data"."road_node"'::regclass AND confrelid = '"osm_data"."dataset"'::regclass AND contype = 'f') THEN ALTER TABLE "osm_data"."road_node" ADD CONSTRAINT "road_node_dataset_id_dataset_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "osm_data"."dataset"("dataset_id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "building_dataset_osm_id_key" ON "osm_data"."building" USING btree ("dataset_id","osm_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "building_dataset_idx" ON "osm_data"."building" USING btree ("dataset_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dataset_one_active" ON "osm_data"."dataset" USING btree ("status") WHERE "osm_data"."dataset"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poi_dataset_poi_id_key" ON "osm_data"."poi" USING btree ("dataset_id","poi_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poi_dataset_kind_idx" ON "osm_data"."poi" USING btree ("dataset_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "road_edge_dataset_edge_index_key" ON "osm_data"."road_edge" USING btree ("dataset_id","edge_id","edge_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "road_edge_dataset_idx" ON "osm_data"."road_edge" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "road_edge_nodes_idx" ON "osm_data"."road_edge" USING btree ("dataset_id","source_node","target_node");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "road_node_dataset_node_id_key" ON "osm_data"."road_node" USING btree ("dataset_id","node_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "road_node_dataset_idx" ON "osm_data"."road_node" USING btree ("dataset_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "building_geom_gix" ON "osm_data"."building" USING gist ("geom");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_coverage_gix" ON "osm_data"."dataset" USING gist ("coverage");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poi_geom_gix" ON "osm_data"."poi" USING gist ("geom");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "road_edge_geom_gix" ON "osm_data"."road_edge" USING gist ("geom");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "road_node_geom_gix" ON "osm_data"."road_node" USING gist ("geom");
