const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const sessions = await prisma.session.findMany();
  console.log(sessions);
}
main().finally(() => prisma.$disconnect());
