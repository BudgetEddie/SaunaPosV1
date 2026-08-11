// ============================================================================
// CREATES THE LOUNGE'S TABLES.
//
// SAFE TO RE-RUN. Unlike prisma/seed.ts, this deletes nothing. It skips any
// table whose number already exists, so when the lounge changes you add a line
// to the list below and run it again — every existing table, including any
// currently occupied, is left exactly as it is.
//
// HOW TO RUN IT
//   cd server && npx ts-node prisma/seed-tables.ts
//
// WHERE IT'S USED
//   Nowhere in the running app. A one-off command run by hand.
// ============================================================================

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// EDIT THIS LIST to match the actual room. `seats` is optional — drop it and
// the screen just won't show a seat count for that table.
//
// Sixteen tables, in a spread that's a guess at a sauna lounge: a row of
// two-tops, a middle band of fours, and a few larger ones for groups. Correct
// the numbers and seat counts once the room has actually been counted, then
// run this again — nothing is lost by doing so.
const TABLES = [
  { number: "T1", seats: 2 },
  { number: "T2", seats: 2 },
  { number: "T3", seats: 2 },
  { number: "T4", seats: 2 },
  { number: "T5", seats: 2 },
  { number: "T6", seats: 2 },
  { number: "T7", seats: 4 },
  { number: "T8", seats: 4 },
  { number: "T9", seats: 4 },
  { number: "T10", seats: 4 },
  { number: "T11", seats: 4 },
  { number: "T12", seats: 4 },
  { number: "T13", seats: 6 },
  { number: "T14", seats: 6 },
  { number: "T15", seats: 6 },
  { number: "T16", seats: 8 },
];

async function main() {
  // Deliberately NOT deleting anything. This script can be run again after
  // adding a table to the list above, and existing tables — including any
  // currently marked occupied — are left exactly as they are.
  let created = 0;
  for (const t of TABLES) {
    const existing = await prisma.table.findFirst({ where: { number: t.number } });
    if (existing) continue;
    await prisma.table.create({ data: t });
    created++;
  }
  console.log(`Created ${created} new tables (${TABLES.length} in the list)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
