CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE TABLE "map_features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"source_feature_id" text,
	"source_path" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" boolean DEFAULT true NOT NULL,
	"geometry_type" varchar(32),
	"geom" geometry(Geometry,4326),
	"style_url" text,
	"raw_properties" jsonb,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "map_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"source_path" text NOT NULL,
	"display_path" text NOT NULL,
	"depth" integer NOT NULL,
	"sort_order" integer NOT NULL,
	"is_open_by_default" boolean DEFAULT false NOT NULL,
	"child_folder_count" integer DEFAULT 0 NOT NULL,
	"descendant_folder_count" integer DEFAULT 0 NOT NULL,
	"direct_feature_count" integer DEFAULT 0 NOT NULL,
	"descendant_feature_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"original_filename" text NOT NULL,
	"stored_filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"mime_type" varchar(255),
	"source_kind" varchar(32) DEFAULT 'kmz_archive' NOT NULL,
	"source_document_path" text,
	"file_size_bytes" integer NOT NULL,
	"import_status" varchar(32) DEFAULT 'uploaded' NOT NULL,
	"import_error" text,
	"catalog_root_name" text,
	"folder_count" integer DEFAULT 0 NOT NULL,
	"feature_count" integer DEFAULT 0 NOT NULL,
	"point_count" integer DEFAULT 0 NOT NULL,
	"line_string_count" integer DEFAULT 0 NOT NULL,
	"polygon_count" integer DEFAULT 0 NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"footprint" geometry(MultiPolygon,4326),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"imported_feature_id" uuid,
	"name" text NOT NULL,
	"geom" geometry(Point,4326) NOT NULL,
	"source_properties" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_features" ADD CONSTRAINT "map_features_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_features" ADD CONSTRAINT "map_features_folder_id_map_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."map_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_folders" ADD CONSTRAINT "map_folders_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_folders" ADD CONSTRAINT "map_folders_parent_id_map_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."map_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_imported_feature_id_map_features_id_fk" FOREIGN KEY ("imported_feature_id") REFERENCES "public"."map_features"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "map_features_map_id_folder_id_idx" ON "map_features" USING btree ("map_id","folder_id");--> statement-breakpoint
CREATE INDEX "map_features_geom_idx" ON "map_features" USING gist ("geom");--> statement-breakpoint
CREATE UNIQUE INDEX "map_features_map_id_source_path_unique" ON "map_features" USING btree ("map_id","source_path");--> statement-breakpoint
CREATE INDEX "map_folders_map_id_parent_id_idx" ON "map_folders" USING btree ("map_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "map_folders_map_id_source_path_unique" ON "map_folders" USING btree ("map_id","source_path");--> statement-breakpoint
CREATE INDEX "maps_created_at_idx" ON "maps" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "nodes_map_id_idx" ON "nodes" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "nodes_geom_idx" ON "nodes" USING gist ("geom");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_imported_feature_id_unique" ON "nodes" USING btree ("imported_feature_id");
