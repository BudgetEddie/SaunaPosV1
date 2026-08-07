// ============================================================================
// FIRST-TIME SETUP — creates the building's 120 lockers.
//
// ⚠️  THIS ERASES DATA. It deletes every bill, every charge and every visit
//     before rebuilding the lockers. On a real till that is the entire
//     trading history. It exists for setting up a fresh install, not for
//     day-to-day use.
//
//     Only prisma/seed-users.ts is safe to re-run. This one is not.
//
// HOW TO RUN IT
//   cd server && npx ts-node prisma/seed.ts
//
// WHERE IT'S USED
//   Nowhere in the running app — nothing imports this. It's a one-off command
//   run by hand, documented in CODE-GUIDE.md under "First-time setup".
// ============================================================================

import { PrismaClient, Gender } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Clear existing data — order matters, children before parents
  //
  // Charges belong to bills, bills belong to visits, visits hold lockers. The
  // database refuses to delete something another record still points at, so
  // they have to go in this order, innermost first. Swapping two of these
  // lines makes the script fail.
  await prisma.billLineItem.deleteMany();
  await prisma.bill.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.locker.deleteMany();

  // Build the list: 60 men's and 60 women's, numbered M01–M60 and F01–F60.
  // The padding is what keeps them sorting correctly — without it "M10" would
  // come before "M2" in every dropdown in the app.
  const lockers = [];
  for (let i = 1; i <= 60; i++) {
    const padded = String(i).padStart(2, "0");
    lockers.push({ number: `M${padded}`, gender: Gender.MALE });
    lockers.push({ number: `F${padded}`, gender: Gender.FEMALE });
  }

  // Create all 120 in one go rather than 120 separate commands.
  await prisma.locker.createMany({ data: lockers });
  console.log(`Seeded ${lockers.length} lockers`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());