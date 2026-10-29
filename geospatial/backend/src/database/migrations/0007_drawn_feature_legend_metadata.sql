ALTER TABLE "drawn_nodes" ADD COLUMN "style" jsonb;
ALTER TABLE "drawn_nodes" ADD COLUMN "raw_properties" jsonb;

ALTER TABLE "drawn_lines" ADD COLUMN "style" jsonb;
ALTER TABLE "drawn_lines" ADD COLUMN "raw_properties" jsonb;

ALTER TABLE "drawn_polygons" ADD COLUMN "style" jsonb;
ALTER TABLE "drawn_polygons" ADD COLUMN "raw_properties" jsonb;
