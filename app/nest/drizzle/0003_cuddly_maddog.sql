CREATE TABLE "generation_rate_limit" (
	"userId" text PRIMARY KEY NOT NULL,
	"windowIndex" bigint NOT NULL,
	"count" integer NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "generation_rate_limit_updatedAt_idx" ON "generation_rate_limit" USING btree ("updatedAt");