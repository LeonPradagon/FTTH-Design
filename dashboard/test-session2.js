const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: 'desc' },
    take: 1
  });
  console.log(sessions);
}
main().finally(() => prisma.$disconnect());
