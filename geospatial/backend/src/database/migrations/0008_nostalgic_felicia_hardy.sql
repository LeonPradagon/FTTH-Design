ALTER TABLE "maps" ADD COLUMN "uploaded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "maps" ADD CONSTRAINT "maps_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maps_uploaded_by_user_id_idx" ON "maps" USING btree ("uploaded_by_user_id");
