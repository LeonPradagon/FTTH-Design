import { auth } from "../src/lib/auth";
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();
  
  // Clean up old admins
  try {
    await prisma.user.deleteMany({
      where: { email: { in: ["admin@ftth.com", "admin@surge.com"] } }
    });
  } catch(e) {}

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
  } catch(e: any) {
    console.log("Signup error (might already exist):", e.message);
  }

  // Update role to admin
  await prisma.user.update({
    where: { email: "admin@surge.com" },
    data: { role: "admin" }
  });
  console.log("Role set to admin!");
}

main().catch(console.error);
