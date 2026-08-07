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

// EDIT THESE two passwords before running. Rerunning this script later
// with new passwords is also how you reset a forgotten one.
//
// ADMIN can see the takings, edit the menu, void charges and give refunds.
// STAFF can do everything else. `displayName` is what appears on screen.
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
    await prisma.user.upsert({
      where: { username: u.username },
      update: { displayName: u.displayName, role: u.role, passwordHash },
      create: { username: u.username, displayName: u.displayName, role: u.role, passwordHash },
    });
    console.log(`Saved user ${u.username} (${u.role})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());