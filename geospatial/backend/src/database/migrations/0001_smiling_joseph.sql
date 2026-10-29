CREATE TABLE "provinces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"raw_properties" jsonb,
	"geom" geometry(MultiPolygon,4326) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "provinces_name_idx" ON "provinces" USING btree ("name");--> statement-breakpoint
CREATE INDEX "provinces_geom_idx" ON "provinces" USING gist ("geom");