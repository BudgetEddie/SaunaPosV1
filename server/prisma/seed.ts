// ============================================================================
// FIRST-TIME SETUP — creates the building's 120 lockers.
//
// ⚠️  THIS ERASES DATA. It deletes every bill, every charge, every kitchen
//     order and every visit before rebuilding the lockers. On a real till that
//     is the entire trading history. It exists for setting up a fresh install,
//     not for day-to-day use.
//
//     Only prisma/seed-users.ts is safe to re-run. This one is not.
//
//     It now refuses to run at all if the database has any visits in it — see
//     the SAFETY GUARD below. That refusal is the normal, expected outcome on
//     any database that has been used.
//
// HOW TO RUN IT
//   cd server && npx ts-node prisma/seed.ts
//
//   On a database that already has visits, add --force-wipe to mean it:
//     cd server && npx ts-node prisma/seed.ts --force-wipe
//
// WHERE IT'S USED
//   Nowhere in the running app — nothing imports this. It's a one-off command
//   run by hand, documented in CODE-GUIDE.md under "First-time setup".
// ============================================================================

import { PrismaClient, Gender } from "@prisma/client";

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// SAFETY GUARD
//
// Everything below erases data: every kitchen order, every charge, every bill,
// every visit, every locker. That was right on day one — the database was empty
// and this script existed to create the lockers for the first time. It is not
// right on a database anyone has actually used.
//
// So: refuse outright if there are visits in there, unless told otherwise in
// terms nobody types by accident.
//
//     npx ts-node prisma/seed.ts --force-wipe
//
// The flag is deliberately long and unpleasant. It should be.
//
// Counting visits catches everything that was ever sold: a bill can't exist
// without one (Bill.visitId is required) and neither can a kitchen order, and a
// takeout sale opens a visit too — one that's checked out the moment it's
// created, but a real row all the same. So no trading history can hide from
// this count.
//
// KNOWN LIMIT: this does not protect locker state. The lockers are dropped and
// rebuilt below, which clears every `status` and every `maintenanceNote`. On a
// database with no visits that's the intended behaviour — it's a fresh install
// and creating the lockers is the whole point — but it does mean that flagging
// a broken locker before opening day, and then running this, loses the flag.
// ---------------------------------------------------------------------------
async function guardAgainstWipingRealData() {
  const visits = await prisma.visit.count();
  if (visits === 0) return; // nothing sold yet — but see KNOWN LIMIT above

  if (process.argv.includes("--force-wipe")) {
    console.warn(
      `\n⚠  --force-wipe given. Erasing ${visits} visits and everything billed ` +
      `against them.\n`
    );
    return;
  }

  const bills = await prisma.bill.count();
  console.error(
    `\nRefusing to run.\n\n` +
    `This database has ${visits} visits and ${bills} bills in it. This script ` +
    `deletes every one of them, along with every charge, every kitchen order ` +
    `and every locker, and then recreates the lockers from scratch.\n\n` +
    `It is only safe on an empty database: a brand new install, or your own ` +
    `machine when you want a clean slate.\n\n` +
    `If that is genuinely what you want:\n\n` +
    `    npx ts-node prisma/seed.ts --force-wipe\n\n`
  );
  process.exit(1);
}

async function main() {
  await guardAgainstWipingRealData();

  // Clear existing data — order matters, children before parents. The database
  // refuses to delete a row that another row still points at, so this works
  // inward: order items point at orders, orders and bills point at visits,
  // visits point at lockers.
  //
  // Orders were added after this script was written, and were missing from this
  // list — which meant it would fail at the visit line, after the bills were
  // already gone. If a model is ever added that points at Visit, it belongs
  // here too.
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
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