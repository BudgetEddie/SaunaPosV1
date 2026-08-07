// ============================================================================
// A ONE-TIME REPAIR SCRIPT — ALREADY RUN. Kept as a record.
//
// WHAT IT WAS FOR
//   When per-item tax rates and menu groups were added to the database, every
//   record that already existed had those fields empty. This filled them in,
//   choosing values that left every existing price and every past receipt
//   adding up to exactly what they did before.
//
//   It has served its purpose. Running it again would stamp EVERY menu item
//   with the house tax rate, wiping any per-item rates set since — so don't,
//   unless you're rebuilding an old database from scratch.
//
// WHERE IT'S USED
//   Nowhere. Nothing imports it and nothing runs it. It's here because it
//   documents how the data got into its current shape, which is genuinely
//   useful if a historic figure ever looks wrong.
//
//   The migration it accompanied is
//   prisma/migrations/20260730204557_menu_groups_and_item_tax/.
// ============================================================================

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Categories that printed kitchen tickets become Food & drinks; the rest
  // become Merchandise & services. You can move any of them later on screen.
  await prisma.category.updateMany({
    where: { isKitchen: true },
    data: { group: "FOOD_DRINK" },
  });
  await prisma.category.updateMany({
    where: { isKitchen: false },
    data: { group: "MERCH_SERVICE" },
  });

  // Every charge already on a bill keeps the rate that bill was created with,
  // so old receipts and past reports come out to exactly the same numbers.
  const bills = await prisma.bill.findMany({ select: { id: true, taxRate: true } });
  for (const bill of bills) {
    await prisma.billLineItem.updateMany({
      where: { billId: bill.id },
      data: { taxRate: bill.taxRate },
    });
  }

  // Existing menu items start at the business rate you've been using, so
  // nothing changes price until you edit it.
  const settings = await prisma.settings.findFirst();
  const rate = settings?.taxRate ?? 0.13;
  await prisma.menuItem.updateMany({ data: { taxRate: rate } });

  const categories = await prisma.category.count();
  const items = await prisma.menuItem.count();
  console.log(
    `Backfilled ${categories} categories, ${bills.length} bills, ${items} items at ${(rate * 100).toFixed(2)}%.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());