ALTER TABLE "design_cable" ALTER COLUMN "path" SET DATA TYPE geometry(LineString, 4326);--> statement-breakpoint
ALTER TABLE "design_odc" ALTER COLUMN "location" SET DATA TYPE geometry(Point, 4326);--> statement-breakpoint
ALTER TABLE "design_odp" ALTER COLUMN "location" SET DATA TYPE geometry(Point, 4326);--> statement-breakpoint
ALTER TABLE "project_customer" ALTER COLUMN "location" SET DATA TYPE geometry(Point, 4326);