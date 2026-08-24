import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function check() {
  const sessions = await prisma.session.findMany();
  console.log("Sessions from DB:", sessions.map(s => s.token));
  prisma.$disconnect();
}
check();
