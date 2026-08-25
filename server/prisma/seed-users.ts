// ============================================================================
// THE STAFF LOGINS — creates the accounts people sign in with.
//
// WHAT IT IS
//   There is no "add a user" screen anywhere in the app. Accounts exist only
//   because this script made them, which is deliberate: creating logins is a
//   deskside job, not something to be done from the till.
//
// ⚠️ WHAT CHANGED 2026-08-24, AND WHY
//   This script used to carry two passwords written into it in plain text,
//   and its upsert wrote passwordHash on EVERY run. Those are two separate
//   hazards and both are now fixed:
//
//     1. The passwords sat in a PUBLIC GitHub repository. Anyone who found
//        the repo knew the login to a till that takes real money.
//     2. Because the update branch always wrote passwordHash, re-running
//        this after someone had set a proper password SILENTLY put the
//        public one back — while printing the same cheerful "Saved user"
//        line as always. The old header even called re-running it "safe".
//
//   So: there are no passwords in this file any more, and there must never
//   be again. A password now comes from one of two places.
//
//     - Typed at a prompt when you run this by hand. Nothing is echoed to
//       the screen and it never enters your shell history. You are asked
//       twice and the two must match, because getting this wrong locks you
//       out of a machine that may be two hours away.
//     - An environment variable, for the rare scripted case. The name is the
//       username uppercased plus _PASSWORD:  OWNER_PASSWORD, FRONTDESK_PASSWORD
//
//   AND THE IMPORTANT PART: if you supply no password for an account that
//   ALREADY EXISTS, this script leaves that account's password completely
//   alone and updates only the display name and role. Press Enter at the
//   prompt to skip an account. That is what makes re-running this safe now,
//   in the way the old header wrongly claimed it already was.
//
//   Setting a password is still how you reset a forgotten one — a passphrase
//   genuinely cannot be recovered, only replaced.
//
// HOW TO RUN IT
//   In the container, on a site's box:
//     sudo docker compose -f docker-compose.prod.yml exec app \
//       npx ts-node prisma/seed-users.ts
//
//   On a developer machine:
//     cd server && npx ts-node prisma/seed-users.ts
//
//   Note there is no -T on that exec. This script needs a real terminal to
//   type into; -T removes it and the prompt cannot work.
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

// The roster. Note there are no passwords here — see the header. Adding a
// third account (say a kitchen-only login) is still a one-line addition, and
// the login screen's roster chips pick it up automatically.
//
// LOCAL-FIRST: staff accounts are separate per site (decided 2026-08-19), and
// this script only ever runs against one site's own local database. Using the
// same username — "frontdesk" at both Mississauga and Niagara Falls — is
// fine, and stays fine once both sites' data lands together on the read-only
// standby at the owner's house: `username` is unique per site, not globally
// (the @@unique([siteId, username]) on User in schema.prisma). So the two
// names below can be left exactly as they are for every site; no
// "frontdesk-mississauga" rename convention is needed.
const USERS = [
  { username: "owner", displayName: "Owner", role: Role.ADMIN },
  { username: "frontdesk", displayName: "Front Desk", role: Role.STAFF },
];

// The two passwords this script used to ship with. They are in the public
// repository's history forever, so they can never be used again — refusing
// them here costs nothing and closes the most likely accident: someone
// reaching for the familiar one out of muscle memory.
const BURNED_PASSWORDS = ["Test1234!", "Test12345!"];

// Short enough not to be a nuisance for someone typing it at the start of
// every shift, long enough that it isn't the actual problem. Length is what
// matters most; a memorable phrase of four or five words beats a short
// scramble of punctuation and is far easier to type at a busy front desk.
const MIN_LENGTH = 10;

// Control characters handled by hand once the terminal is in raw mode.
const CTRL_C = "\u0003";
const BACKSPACE = "\u007f";

// ---------------------------------------------------------------------------
// Asking for a password without putting it on the screen.
//
// Terminals echo what you type. To stop that we switch the terminal into "raw
// mode", where this script receives each keystroke itself and decides what (if
// anything) to display — so nothing appears, and nothing is left on the screen
// of a machine sitting on a front desk.
//
// Raw mode also means the ordinary conveniences stop being automatic, which is
// why Enter, Backspace and Ctrl-C are all handled by hand below.
// ---------------------------------------------------------------------------
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;

    // No terminal means no prompt is possible — running under `exec -T`, from
    // cron, or piped. Say so plainly instead of hanging forever waiting for
    // input that can never arrive.
    if (!stdin.isTTY) {
      reject(
        new Error(
          "No terminal available to type a password into. Either run this without -T, " +
            "or supply the password in an environment variable (e.g. OWNER_PASSWORD)."
        )
      );
      return;
    }

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const finish = (result: string | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (result === null) {
        // Ctrl-C. Leave the database untouched and stop — half-changing a set
        // of logins is worse than not starting.
        console.log("Cancelled. Nothing was changed.");
        process.exit(130);
      }
      resolve(result);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(value);
        if (ch === CTRL_C) return finish(null);
        if (ch === BACKSPACE || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore the escape sequences that arrow keys and similar send, so a
        // stray cursor key doesn't quietly become part of the password.
        if (ch < " ") continue;
        value += ch;
      }
    };

    stdin.on("data", onData);
  });
}

function validate(password: string): string | null {
  // The burned list is checked BEFORE the length rule on purpose. "Test1234!"
  // is nine characters, so a length-first order would reject it with "too
  // short" — technically a refusal, but it teaches the wrong lesson and would
  // send someone off to try "Test1234!!" instead. Say the real reason.
  if (BURNED_PASSWORDS.includes(password)) {
    return "That is one of the old defaults from the public repository. It can never be used again.";
  }
  if (password.length < MIN_LENGTH) {
    return `Too short — ${MIN_LENGTH} characters minimum, and length beats punctuation.`;
  }
  return null;
}

// Returns the password to set, or null meaning "leave this account alone".
async function resolvePassword(username: string, exists: boolean): Promise<string | null> {
  const envName = `${username.toUpperCase()}_PASSWORD`;
  const fromEnv = process.env[envName];

  if (fromEnv) {
    const problem = validate(fromEnv);
    if (problem) {
      throw new Error(`${envName} is not acceptable: ${problem}`);
    }
    return fromEnv;
  }

  // Up to three attempts, then stop rather than looping at someone who is
  // clearly having a bad time with a keyboard whose output they can't see.
  for (let attempt = 0; attempt < 3; attempt++) {
    const skipHint = exists ? " (Enter to leave it unchanged)" : "";
    const first = await askHidden(`  New password for "${username}"${skipHint}: `);

    if (!first) {
      if (exists) return null;
      console.log(`  "${username}" does not exist yet, so it needs a password.`);
      continue;
    }

    const problem = validate(first);
    if (problem) {
      console.log(`  ${problem}`);
      continue;
    }

    const second = await askHidden("  Type it once more to confirm: ");
    if (first !== second) {
      console.log("  Those didn't match.");
      continue;
    }

    return first;
  }

  throw new Error(
    `Gave up on "${username}" after three attempts. Nothing was changed for this account.`
  );
}

async function main() {
  console.log(`Staff logins for site ${SITE_ID}.\n`);

  for (const u of USERS) {
    const existing = await prisma.user.findUnique({
      where: { siteId_username: { siteId: SITE_ID, username: u.username } },
      select: { id: true },
    });

    const password = await resolvePassword(u.username, existing !== null);

    // Scramble the passphrase before it goes anywhere near the database. This
    // is one-directional — the result can be checked against, but never turned
    // back into the original. The 10 is a difficulty setting: higher makes
    // hashing slower, which is the whole point, since it makes guessing
    // millions of passphrases impractical.
    const passwordHash = password === null ? null : await bcrypt.hash(password, 10);

    if (existing === null) {
      if (passwordHash === null) {
        // Unreachable — resolvePassword refuses to return null for an account
        // that doesn't exist yet, because there would be no hash to write.
        throw new Error(`No password for new account "${u.username}".`);
      }
      await prisma.user.create({
        data: {
          username: u.username,
          displayName: u.displayName,
          role: u.role,
          passwordHash,
          siteId: SITE_ID,
        },
      });
      console.log(`  Created ${u.username} (${u.role}) for site ${SITE_ID}\n`);
      continue;
    }

    // The account exists. Display name, role and siteId are always refreshed —
    // siteId included, so re-running this can't leave a stale one sitting on an
    // account from before the local-first migration. passwordHash is written
    // ONLY when a new password was actually given. That is the fix: supplying
    // no password means the existing one survives, rather than being replaced
    // by whatever happened to be written into this file.
    await prisma.user.update({
      where: { siteId_username: { siteId: SITE_ID, username: u.username } },
      data: {
        displayName: u.displayName,
        role: u.role,
        siteId: SITE_ID,
        ...(passwordHash === null ? {} : { passwordHash }),
      },
    });

    console.log(
      passwordHash === null
        ? `  Left ${u.username}'s password unchanged (name and role refreshed)\n`
        : `  Set a new password for ${u.username} (${u.role})\n`
    );
  }

  console.log("Done. Nothing typed above reached your shell history.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
