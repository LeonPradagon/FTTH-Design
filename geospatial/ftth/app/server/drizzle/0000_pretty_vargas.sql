CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"password" text,
	"issuer" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"action" text NOT NULL,
	"projectId" text,
	"versionId" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_cable" (
	"id" text PRIMARY KEY NOT NULL,
	"designVersionId" text NOT NULL,
	"type" text NOT NULL,
	"sourceLabel" text NOT NULL,
	"targetLabel" text NOT NULL,
	"length" real NOT NULL,
	"path" geometry
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_odc" (
	"id" text PRIMARY KEY NOT NULL,
	"designVersionId" text NOT NULL,
	"label" text NOT NULL,
	"location" geometry
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_odp" (
	"id" text PRIMARY KEY NOT NULL,
	"designVersionId" text NOT NULL,
	"odcId" text NOT NULL,
	"label" text NOT NULL,
	"location" geometry
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_version" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"validation" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"status" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "generation_job" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"projectId" text,
	"batchId" text,
	"itemId" text,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"stage" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"result" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"publicKey" text NOT NULL,
	"privateKey" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_customer" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"location" geometry
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"layers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"feature_colors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"userId" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	"impersonatedBy" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"role" text DEFAULT 'engineer',
	"banned" boolean DEFAULT false,
	"banReason" text,
	"banExpires" timestamp,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"account"'::regclass AND confrelid = '"public"."user"'::regclass AND contype = 'f') THEN ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"audit_log"'::regclass AND confrelid = '"public"."user"'::regclass AND contype = 'f') THEN ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"design_cable"'::regclass AND confrelid = '"public"."design_version"'::regclass AND contype = 'f') THEN ALTER TABLE "design_cable" ADD CONSTRAINT "design_cable_designVersionId_design_version_id_fk" FOREIGN KEY ("designVersionId") REFERENCES "public"."design_version"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"design_odc"'::regclass AND confrelid = '"public"."design_version"'::regclass AND contype = 'f') THEN ALTER TABLE "design_odc" ADD CONSTRAINT "design_odc_designVersionId_design_version_id_fk" FOREIGN KEY ("designVersionId") REFERENCES "public"."design_version"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"design_odp"'::regclass AND confrelid = '"public"."design_version"'::regclass AND contype = 'f') THEN ALTER TABLE "design_odp" ADD CONSTRAINT "design_odp_designVersionId_design_version_id_fk" FOREIGN KEY ("designVersionId") REFERENCES "public"."design_version"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"design_odp"'::regclass AND confrelid = '"public"."design_odc"'::regclass AND contype = 'f') THEN ALTER TABLE "design_odp" ADD CONSTRAINT "design_odp_odcId_design_odc_id_fk" FOREIGN KEY ("odcId") REFERENCES "public"."design_odc"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"design_version"'::regclass AND confrelid = '"public"."project"'::regclass AND contype = 'f') THEN ALTER TABLE "design_version" ADD CONSTRAINT "design_version_projectId_project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"generation_job"'::regclass AND confrelid = '"public"."user"'::regclass AND contype = 'f') THEN ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"generation_job"'::regclass AND confrelid = '"public"."project"'::regclass AND contype = 'f') THEN ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_projectId_project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"project_customer"'::regclass AND confrelid = '"public"."project"'::regclass AND contype = 'f') THEN ALTER TABLE "project_customer" ADD CONSTRAINT "project_customer_projectId_project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"project"'::regclass AND confrelid = '"public"."user"'::regclass AND contype = 'f') THEN ALTER TABLE "project" ADD CONSTRAINT "project_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"session"'::regclass AND confrelid = '"public"."user"'::regclass AND contype = 'f') THEN ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_userId_idx" ON "audit_log" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_projectId_idx" ON "audit_log" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_cable_designVersionId_idx" ON "design_cable" USING btree ("designVersionId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_odc_designVersionId_idx" ON "design_odc" USING btree ("designVersionId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_odp_designVersionId_idx" ON "design_odp" USING btree ("designVersionId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_odp_odcId_idx" ON "design_odp" USING btree ("odcId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "design_version_projectId_version_key" ON "design_version" USING btree ("projectId","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_job_userId_createdAt_idx" ON "generation_job" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_job_projectId_createdAt_idx" ON "generation_job" USING btree ("projectId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_job_status_idx" ON "generation_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_customer_projectId_idx" ON "project_customer" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_userId_idx" ON "project" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" USING btree ("identifier");
