// ============================================================================
// THE STAFF LOGINS — creates the accounts people sign in with.
//
// WHAT IT IS
//   There is no "add a user" screen anywhere in the app. Accounts exist only
//   because this script made them, which is deliberate: creating logins is a
//   deskside job, not something to be done from the till.
//
//   Safe to re-run as often as you like — unlike prisma/seed.ts, this deletes
//   nothing. Re-running it with a new password IS the password-reset
//   procedure, since a forgotten passphrase genuinely cannot be recovered.
//
// HOW TO RUN IT
//   cd server && npx ts-node prisma/seed-users.ts
//
// WHERE IT'S USED
//   Nowhere in the running app. A one-off command run by hand.
//   The accounts it makes are what client/src/Login.tsx checks against, via
//   POST /login in server/src/index.ts.
// ============================================================================

import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// LOCAL-FIRST (2026-08-19): which site this script is creating/resetting
// accounts for. This script opens its own PrismaClient above — it does NOT
// go through the $extends wrapper in server/src/index.ts that stamps siteId
// onto new rows automatically — so it has to be checked and applied here too.
// Same reasoning as SITE_ID in index.ts: a box silently saving accounts with
// no site on them is worse than a script that refuses to run.
const SITE_ID = process.env.SITE_ID || "";
if (!SITE_ID) {
  console.error("SITE_ID is missing from server/.env — see claude/sauna-pos-local-first-implementation-guide.md.");
  process.exit(1);
}

// EDIT THESE two passwords before running. Rerunning this script later
// with new passwords is also how you reset a forgotten one.
//
// ADMIN can see the takings, edit the menu, void charges and give refunds.
// STAFF can do everything else. `displayName` is what appears on screen.
//
// LOCAL-FIRST: staff accounts are separate per site (decided 2026-08-19), and
// this script only ever runs against one site's own local database — so
// using the same username (e.g. "frontdesk") at both Mississauga and Niagara
// Falls is fine here, each site's SQLite file only ever sees its own copy.
// It stops being fine the moment both sites' data lands together on the
// read-only standby at the owner's house: `username` is still declared
// globally unique in schema.prisma, so two sites both naming someone
// "frontdesk" WILL collide there. Flagged in schema.prisma too — worth
// re-confirming (rename convention, e.g. "frontdesk-mississauga"? drop the
// global unique constraint in favour of a compound one on
// [siteId, username]?) once Niagara Falls actually has its own accounts.
const USERS = [
  { username: "owner",     displayName: "Owner",      role: Role.ADMIN, password: "Test1234!" },
  { username: "frontdesk", displayName: "Front Desk", role: Role.STAFF, password: "Test12345!" },
];

async function main() {
  for (const u of USERS) {
    // Scramble the passphrase before it goes anywhere near the database. This
    // is one-directional — the result can be checked against, but never turned
    // back into the original. The 10 is a difficulty setting: higher makes
    // hashing slower, which is the whole point, since it makes guessing
    // millions of passphrases impractical.
    const passwordHash = await bcrypt.hash(u.password, 10);
    // "upsert" = update if this username exists, otherwise create it. That's
    // what makes re-running this safe, and what makes it a password reset.
    // siteId is stamped on both branches — on `create` because every row
    // needs one, and on `update` too, so re-running this script on an
    // existing account can't silently leave a stale/wrong siteId sitting on
    // it from before this migration.
    await prisma.user.upsert({
      where: { username: u.username },
      update: { displayName: u.displayName, role: u.role, passwordHash, siteId: SITE_ID },
      create: { username: u.username, displayName: u.displayName, role: u.role, passwordHash, siteId: SITE_ID },
    });
    console.log(`Saved user ${u.username} (${u.role}) for site ${SITE_ID}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());