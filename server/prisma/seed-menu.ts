// ============================================================================
// THE MISSISSAUGA MENU — every section and every item, as code.
//
// WHAT IT IS
//   The menu used to exist only as rows in one database. That made it
//   unbacked-up, unreviewable, and impossible to put on a second till without
//   retyping forty items by hand. This file is the menu written down, so it can
//   be recreated anywhere the app runs.
//
// ✅ SAFE TO RE-RUN, and safe on a till with real trading history.
//    Unlike prisma/seed.ts — which erases visits, bills and kitchen orders —
//    this script DELETES NOTHING. It only ever adds what is missing:
//      - a section that already exists (by name) is left exactly as it is
//      - an item that already exists (by name, in that section) is skipped
//    So it never overwrites a price someone corrected at the till, and running
//    it twice does nothing the second time.
//
//    It is deliberately blind to prices on items that already exist. Changing a
//    live price is a decision for the Menu screen, not for a script that might
//    be run months later by someone expecting it to be harmless.
//
// HOW TO RUN IT
//   cd server && npx ts-node prisma/seed-menu.ts
//
// WHICH LOCATION IT FILLS
//   The first active location — the same one the server treats as "here" (see
//   currentLocation in src/index.ts). On a database that has no location yet,
//   one called "Mississauga" is created, matching what the server would do.
//   To fill a different site, pass its name:
//
//     npx ts-node prisma/seed-menu.ts --location "Toronto"
//
// WHERE IT'S USED
//   Nowhere in the running app. A command run by hand when setting up an
//   install, or to top up a menu with sections it is missing.
// ============================================================================

import { PrismaClient, MenuGroup, Station } from "@prisma/client";

const prisma = new PrismaClient();

// The house tax rate every item here is sold at. Copied onto each charge at the
// moment of sale, so changing it later never alters an old receipt.
const TAX = 0.13;

type SeedItem = {
  name: string;
  price: number;
  // Buying this GRANTS this many prepaid entries. Only the pass pack has one.
  visitCredits?: number;
  // Choosing this SPENDS one of the guest's prepaid entries. Only the pass
  // admission has this. Never set both on the same item — they are opposites.
  redeemsPass?: boolean;
  // Whether selling this puts a card on its section's board. Defaults to true,
  // and only ever turns tickets OFF — the section decides whether a ticket is
  // made at all. Set false for things nobody has to make: a can of pop is a
  // drink, but a ticket for it is noise the bartender has to clear.
  sendsToKitchen?: boolean;
};

type SeedCategory = {
  name: string;
  group: MenuGroup;
  // WHICH BOARD this section's tickets appear on. Only meaningful on
  // FOOD_DRINK — merchandise prints nothing, so its station is inert.
  station: Station;
  // Picking anything in this section REPLACES the guest's entry charge instead
  // of adding to their tab. True for entry charges and nothing else — a hat in
  // an admission section would wipe out somebody's entry fee.
  isAdmission: boolean;
  items: SeedItem[];
};

// ---------------------------------------------------------------------------
// THE MENU. Eleven sections, and which board each one prints on:
//
//   KITCHEN   Soups, Cold Apps / Zakuski, Hot Mains, Baked & Sweet, Extras
//   BAR       Cocktails, Spirits & Shots, Beer & Wine, Non-Alcoholic
//   nothing   Admissions, Extras & Retail — merchandise, nobody cooks a hat
//
// ⚠️  SEVEN ITEMS ARE PRICED $5 AS A PLACEHOLDER — akresh, cheb, plov, pork,
//     salo, salty fish and xsalty were supplied without a price. They are
//     sellable at $5 until someone sets the real one on the Menu screen.
// ---------------------------------------------------------------------------
const MENU: SeedCategory[] = [
  {
    name: "Soups",
    group: MenuGroup.FOOD_DRINK,
    station: Station.KITCHEN,
    isAdmission: false,
    items: [
      { name: "borcht", price: 12 },
      { name: "karcho", price: 14 },
      { name: "salyan", price: 10 },
      { name: "pea", price: 12 },
    ],
  },
  {
    name: "Cold Apps / Zakuski",
    group: MenuGroup.FOOD_DRINK,
    station: Station.KITCHEN,
    isAdmission: false,
    items: [
      { name: "salo", price: 5 },        // placeholder price
      { name: "shuba", price: 15 },
      { name: "pickle", price: 20 },
      { name: "salty fish", price: 5 },  // placeholder price
      { name: "xsalty", price: 5 },      // placeholder price
      { name: "akresh", price: 5 },      // placeholder price
      { name: "sour cream", price: 2 },
    ],
  },
  {
    name: "Hot Mains",
    group: MenuGroup.FOOD_DRINK,
    station: Station.KITCHEN,
    isAdmission: false,
    items: [
      { name: "beef", price: 23 },
      { name: "pork", price: 5 },        // placeholder price
      { name: "fish", price: 20 },
      { name: "kebob", price: 15 },
      { name: "kot", price: 24 },
      { name: "plov", price: 5 },        // placeholder price
      { name: "strog", price: 18 },
      { name: "tabak", price: 24 },
      { name: "pel", price: 15 },
      { name: "var", price: 15 },
      { name: "cabb", price: 20 },
      { name: "knee", price: 40 },
      { name: "cheh", price: 20 },
      { name: "jul", price: 12 },
      { name: "kalalaki", price: 20 },
      { name: "saus", price: 26 },
    ],
  },
  {
    name: "Baked & Sweet",
    group: MenuGroup.FOOD_DRINK,
    station: Station.KITCHEN,
    isAdmission: false,
    items: [
      { name: "cheb", price: 5 },        // placeholder price
      { name: "aladi", price: 16 },
      { name: "cake", price: 10 },
    ],
  },
  {
    name: "Extras",
    group: MenuGroup.FOOD_DRINK,
    station: Station.KITCHEN,
    isAdmission: false,
    items: [{ name: "extra", price: 6 }],
  },

  // --- THE BAR ------------------------------------------------------------
  // The four sections below are the only ones that go to the BAR board. They
  // are FOOD_DRINK like the food, which is what makes them print a ticket at
  // all; `station` is what sends that ticket to the bartender rather than the
  // cook. Get the group wrong and the station is ignored entirely.
  {
    name: "Cocktails",
    group: MenuGroup.FOOD_DRINK,
    station: Station.BAR,
    isAdmission: false,
    items: [
      { name: "Amaretto Sour", price: 15 },
      { name: "Black Russian", price: 13 },
      { name: "Bloody [Mary/Caesar]", price: 15 },
      { name: "Blushing", price: 15 },
      { name: "Cocktail Regular", price: 13 },
      { name: "Cocktail Signature", price: 15 },
      { name: "Dacha Lemonade", price: 15 },
      { name: "Honey Bison", price: 15 },
      { name: "Julius", price: 15 },
      // Not the same thing as plain `kombucha` in Non-Alcoholic below — this
      // one is a $13 cocktail. Both are on the menu on purpose.
      { name: "Komboucha Storm", price: 13 },
      { name: "Mint Moomin", price: 15 },
      { name: "Moscow Martini", price: 15 },
      { name: "moscow mule", price: 15 },
      { name: "Negroni", price: 13 },
      { name: "Red Orchard", price: 15 },
      { name: "white Russian", price: 13 },
    ],
  },
  {
    name: "Spirits & Shots",
    group: MenuGroup.FOOD_DRINK,
    station: Station.BAR,
    isAdmission: false,
    items: [
      { name: "Liquor Basic", price: 9 },
      { name: "Liquor Regular", price: 11 },
      { name: "Liquor Signature", price: 12 },
      { name: "liqueur infusion", price: 9 },
      { name: "vodka", price: 6 },
      { name: "vodka signature", price: 12 },
      { name: "Special shot", price: 6 },
      { name: "Special shot deal", price: 16 },
    ],
  },
  {
    name: "Beer & Wine",
    group: MenuGroup.FOOD_DRINK,
    station: Station.BAR,
    isAdmission: false,
    items: [
      { name: "draft", price: 9 },
      { name: "half pint", price: 5 },
      { name: "Sparkling wine", price: 60 },
      // "vine", not "wine" — spelled as supplied, and confirmed deliberate.
      { name: "vine basic", price: 9 },
      { name: "vine regular", price: 11 },
    ],
  },
  {
    name: "Non-Alcoholic",
    group: MenuGroup.FOOD_DRINK,
    station: Station.BAR,
    isAdmission: false,
    items: [
      // The four taken straight from a fridge print NO ticket. Nobody has to
      // make them, so a card on the bar board is just something to clear.
      // kompot and turkish coffee are made to order, so they still print.
      { name: "borjomi", price: 7, sendsToKitchen: false },
      { name: "kombucha", price: 5, sendsToKitchen: false },
      { name: "minwater", price: 8, sendsToKitchen: false },
      { name: "pop or juice", price: 3, sendsToKitchen: false },
      { name: "kompot", price: 7 },
      { name: "turkish coffee", price: 6 },
    ],
  },

  {
    // THE ENTRY CHARGES. Nothing but entry charges belongs in here.
    name: "Admissions",
    group: MenuGroup.MERCH_SERVICE,
    station: Station.KITCHEN,
    isAdmission: true,
    items: [
      { name: "adult admission", price: 65 },
      { name: "child admission", price: 30 },
      // How a prepaid pass is spent. $0 because the guest already paid for the
      // pack. Check-in looks for exactly this shape — redeemsPass, no credits
      // of its own, in an admission section — when a guest has passes banked.
      // Without it a pass can be sold but never used.
      { name: "admission (visit pass)", price: 0, redeemsPass: true },
    ],
  },
  {
    name: "Extras & Retail",
    group: MenuGroup.MERCH_SERVICE,
    station: Station.KITCHEN,
    isAdmission: false,
    items: [
      { name: "extra robe", price: 3 },
      { name: "hat", price: 20 },
      { name: "scrub", price: 4 },
      { name: "sticker", price: 3 },
      { name: "venik massage", price: 25 },
      // The pack that SELLS ten entries. Deliberately NOT in Admissions: the
      // server refuses a credit-selling item used as an entry charge.
      { name: "ten visit pass", price: 520, visitCredits: 10 },
    ],
  },
];

// Which item check-in should charge automatically. Only applied if no default
// is set yet — see the note at the bottom for why this script won't change one.
const DEFAULT_ADMISSION = "adult admission";

async function main() {
  // --- Which site are we filling? -----------------------------------------
  const wanted = process.argv.indexOf("--location");
  const wantedName = wanted !== -1 ? process.argv[wanted + 1] : null;

  let location = wantedName
    ? await prisma.location.findFirst({ where: { name: wantedName } })
    : await prisma.location.findFirst({ where: { active: true }, orderBy: { id: "asc" } });

  if (!location && wantedName) {
    console.error(`\nNo location called "${wantedName}". Existing locations:`);
    for (const l of await prisma.location.findMany({ orderBy: { id: "asc" } })) {
      console.error(`  - ${l.name}`);
    }
    process.exit(1);
  }
  if (!location) {
    // Same fallback the server uses on a database that has no location yet.
    location = await prisma.location.create({ data: { name: "Mississauga" } });
    console.log(`Created location "${location.name}".`);
  }

  console.log(`\nFilling the menu for: ${location.name}\n`);

  let addedCategories = 0;
  let addedItems = 0;
  let skippedItems = 0;

  for (const section of MENU) {
    // Reuse a section that's already there rather than making a second one.
    // Names are unique per location, so this is the same test the database
    // would apply.
    let category = await prisma.category.findFirst({
      where: { locationId: location.id, name: section.name },
    });

    if (!category) {
      category = await prisma.category.create({
        data: {
          locationId: location.id,
          name: section.name,
          group: section.group,
          // Food and drink is what gets made to order — that alone decides
          // whether selling something prints a ticket.
          isKitchen: section.group === MenuGroup.FOOD_DRINK,
          // Which board that ticket lands on. Inert on a section that prints
          // nothing, which is why merchandise can carry KITCHEN harmlessly.
          station: section.station,
          isAdmission: section.isAdmission,
        },
      });
      addedCategories++;
      console.log(`+ ${section.name}`);
    } else {
      console.log(`= ${section.name} (already there, left alone)`);
    }

    for (const item of section.items) {
      const existing = await prisma.menuItem.findFirst({
        where: { categoryId: category.id, name: item.name },
      });
      if (existing) {
        skippedItems++;
        continue;
      }
      await prisma.menuItem.create({
        data: {
          categoryId: category.id,
          name: item.name,
          price: item.price,
          taxRate: TAX,
          visitCredits: item.visitCredits ?? 0,
          redeemsPass: item.redeemsPass ?? false,
          // Defaults to true — a ticket nobody needed is obvious and harmless,
          // whereas a missing one leaves a guest waiting with no signal at all.
          sendsToKitchen: item.sendsToKitchen ?? true,
        },
      });
      addedItems++;
      console.log(`    + ${item.name} — $${item.price.toFixed(2)}`);
    }
  }

  // --- The entry charge applied automatically at check-in ------------------
  //
  // Only set when there ISN'T one already. Changing it decides what every guest
  // is charged on arrival, and a script run months later must not quietly move
  // that. If a default is already configured, this leaves it and says so.
  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, taxRate: TAX },
  });

  if (settings.defaultAdmissionItemId) {
    const current = await prisma.menuItem.findUnique({
      where: { id: settings.defaultAdmissionItemId },
    });
    console.log(
      `\nDefault entry charge left as it was: ${current?.name ?? "(item no longer exists)"}.`
    );
  } else {
    const admissionCategory = await prisma.category.findFirst({
      where: { locationId: location.id, name: "Admissions" },
    });
    const item = admissionCategory
      ? await prisma.menuItem.findFirst({
          where: { categoryId: admissionCategory.id, name: DEFAULT_ADMISSION },
        })
      : null;
    if (item) {
      await prisma.settings.update({
        where: { id: 1 },
        data: { defaultAdmissionItemId: item.id },
      });
      console.log(`\nDefault entry charge set to "${item.name}" ($${item.price.toFixed(2)}).`);
    }
  }

  console.log(
    `\nDone. Added ${addedCategories} section(s) and ${addedItems} item(s). ` +
    `${skippedItems} item(s) were already there and were left untouched.\n`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
