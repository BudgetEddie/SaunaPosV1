import { PrismaClient, Gender } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Clear existing data — order matters, children before parents
  await prisma.billLineItem.deleteMany();
  await prisma.bill.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.locker.deleteMany();

  const lockers = [];
  for (let i = 1; i <= 60; i++) {
    const padded = String(i).padStart(2, "0");
    lockers.push({ number: `M${padded}`, gender: Gender.MALE });
    lockers.push({ number: `F${padded}`, gender: Gender.FEMALE });
  }

  await prisma.locker.createMany({ data: lockers });
  console.log(`Seeded ${lockers.length} lockers`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());