CREATE TABLE "drawn_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"geom" geometry(Point,4326) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawn_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"geom" geometry(LineString,4326) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawn_polygons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"geom" geometry(Polygon,4326) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drawn_nodes" ADD CONSTRAINT "drawn_nodes_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drawn_lines" ADD CONSTRAINT "drawn_lines_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drawn_polygons" ADD CONSTRAINT "drawn_polygons_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "drawn_nodes_map_id_idx" ON "drawn_nodes" USING btree ("map_id");
--> statement-breakpoint
CREATE INDEX "drawn_nodes_geom_idx" ON "drawn_nodes" USING gist ("geom");
--> statement-breakpoint
CREATE INDEX "drawn_lines_map_id_idx" ON "drawn_lines" USING btree ("map_id");
--> statement-breakpoint
CREATE INDEX "drawn_lines_geom_idx" ON "drawn_lines" USING gist ("geom");
--> statement-breakpoint
CREATE INDEX "drawn_polygons_map_id_idx" ON "drawn_polygons" USING btree ("map_id");
--> statement-breakpoint
CREATE INDEX "drawn_polygons_geom_idx" ON "drawn_polygons" USING gist ("geom");
