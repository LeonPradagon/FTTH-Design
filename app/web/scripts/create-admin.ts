import { auth } from "../src/lib/auth";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";

async function main() {
  // Clean up old admins
  try {
    await db.execute(sql`DELETE FROM "user" WHERE email IN ('admin@ftth.com', 'admin@surge.com')`);
  } catch {}

  // Create the user
  try {
    const res = await auth.api.signUpEmail({
      body: {
        email: "admin@surge.com",
        password: "admin123",
        name: "Super Admin",
      }
    });
    console.log("Signup success:", res);
  } catch (error) {
    console.log(
      "Signup error (might already exist):",
      error instanceof Error ? error.message : error,
    );
  }

  // Update role to admin
  await db.execute(sql`UPDATE "user" SET role = 'admin' WHERE email = 'admin@surge.com'`);
  console.log("Role set to admin!");
}

main().catch(console.error);
