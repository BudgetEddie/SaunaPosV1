// ============================================================================
// THE SERVER — the entire backend of the bathhouse till, in one file.
//
// WHAT IT IS
//   The referee. Every terminal asks this one program for everything, and it
//   is the only thing that writes to the database. It decides whether a locker
//   is really free, what a bill comes to, and who's allowed to see the takings.
//   The client screens are just windows onto this.
//
// HOW IT'S ORGANISED
//   Everything lives here — all 32 endpoints, in these sections, in this order:
//
//     Setup            — start Express, Socket.IO and the database connection
//     Auth             — who's signed in, and who's an admin
//     Public routes    — /health, /login, /login-roster
//     >> THE GATE <<   — one line, after which everything needs a token
//     Settings         — the house tax rate
//     Menu             — categories and items
//     Customers        — the guest book
//     Lockers          — the physical lockers
//     Visits + billing — check-in, orders, voids, refunds
//     Reports          — the day's takings
//     Kitchen          — the ticket board
//     Check-out        — end a visit and take payment
//
// WHO CALLS IT
//   Every screen in client/src. Each one's file header lists the endpoints it
//   uses. Nothing else talks to this — there is no other client.
//
// TWO THINGS TO KNOW BEFORE READING ON
//   1. Money is stored as ordinary decimal numbers, not whole cents.
//   2. Tax is recorded on each individual charge and frozen at the moment of
//      sale, so an old receipt always shows what was really charged that day.
//      One bill can legitimately mix 13%, 5% and 0% items.
//
// (New to any of this? See CODE-GUIDE.md in the project root.)
// ============================================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
// Node's own randomness. Used for one thing: minting override tokens that
// nobody can guess. Math.random() would NOT do here — it's predictable.
import crypto from "node:crypto";
// For locating the built client on disk, below.
import path from "node:path";
import type { Request, Response, NextFunction } from "express";

// The secret used to sign sign-in tokens, read from server/.env — a file kept
// out of version control. Anyone who knows this string could forge a token and
// walk in as an admin, so the server refuses to start without it rather than
// quietly falling back to something guessable.
const JWT_SECRET = process.env.JWT_SECRET || "";
if (!JWT_SECRET) {
  console.error("JWT_SECRET is missing from server/.env — see the login guide, Part 2.");
  process.exit(1);
}

// The database connection. Every `prisma.something` below goes through this.
const prisma = new PrismaClient();
const app = express();
// Allow browsers on other addresses to talk to us. Browsers block that by
// default; the client runs on a different port, so it would be refused.
app.use(cors());
// Automatically unpack incoming JSON, so handlers can just read `req.body`.
app.use(express.json());

// ---- The outer web app ----
//
// `app` above holds every API route, all defined at the root: /customers,
// /reports and so on. Four of those names are ALSO screens in the client.
// If the browser asked this server for /customers it would get JSON, and a
// member of staff refreshing the Customers page would be looking at raw data
// instead of the app.
//
// So `app` gets mounted under /api, and a second, outer Express app handles
// everything else: the built client files, and — for any address that isn't
// a file — index.html, which lets React Router take it from there.
//
// Order matters. /api is checked first, then real files, then the catch-all.
// Socket.IO is unaffected: it attaches to the HTTP server directly, below the
// Express layer entirely.
//
// path.resolve is what guarantees an absolute path. sendFile refuses a relative
// one and throws, so without it a CLIENT_DIST of "client/dist" — the obvious
// thing to type — would turn every page of the app into a 500.
const CLIENT_DIST = path.resolve(process.env.CLIENT_DIST || path.join(__dirname, "../../client/dist"));
const web = express();
web.use("/api", app);
// An /api address that matched nothing above. Without this line it would fall
// through to the catch-all and come back as index.html with status 200 — and
// the client, which decides success by asking `res.ok`, would treat a typo'd or
// missing endpoint as "saved successfully". A wrong address must look wrong.
web.use("/api", (_req, res) => {
  res.status(404).json({ error: "Unknown endpoint" });
});
web.use(express.static(CLIENT_DIST));
web.get(/.*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));

// Socket.IO needs to sit alongside Express on the same port, so the outer app
// is wrapped in a plain HTTP server and both are attached to it. `io` is what
// broadcasts "something changed" to every connected terminal.
const httpServer = createServer(web);
const io = new Server(httpServer, { cors: { origin: "*" } });

// ---- Auth ----

// A normal request, plus the `auth` note requireAuth attaches once it has
// checked the token. Handlers below read `req.auth.role` from it.
type AuthedRequest = Request & { auth?: { userId: number; role: string } };

// The bouncer. Runs before a protected request and either waves it through by
// calling `next()`, or answers 401 and stops it dead.
//
// A 401 is what makes the client sign out — see authFetch.ts, which wipes the
// stored token and reloads back to the login screen.
function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  // The token arrives as "Bearer eyJhbGci..."; slice off the label.
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Sign in first" });
  }
  try {
    // Check the signature. This catches both forgeries and expired tokens,
    // because verify throws on either.
    //
    // Note the role comes out of the TOKEN, not the database — so changing
    // someone's role doesn't take effect until their token runs out.
    req.auth = jwt.verify(token, JWT_SECRET) as { userId: number; role: string };
    next();
  } catch {
    res.status(401).json({ error: "Session expired — sign in again" });
  }
}

// The second bouncer, for the things only a manager should do: reports,
// refunds, editing the menu, voiding a charge. Added individually to those
// routes rather than applied to everything.
// Now also accepts a manager's permission slip. A staff member who has had an
// admin type their password gets a token (see POST /override below) and sends
// it back in the X-Override header; this is where it's checked and spent.
//
// It's `async` now. Express 5 handles a middleware that returns a promise, and
// none of the twelve routes using it need changing.
async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  // A real admin login never needs a permission slip.
  if (req.auth?.role === "ADMIN") return next();

  const token = req.header("X-Override");
  if (token) {
    // For ACTION tokens, spending is done as ONE conditional write rather than
    // read-then-write. `updateMany` with the conditions in its `where` compiles
    // to a single UPDATE … WHERE, and the database guarantees only one caller
    // can match a row whose usedAt is still null. Two simultaneous clicks
    // therefore produce one success and one refusal, instead of both reading
    // "not used yet" and both going through.
    const spent = await prisma.override.updateMany({
      where: {
        token,
        scope: "ACTION",
        usedAt: null,
        expiresAt: { gt: new Date() },
        requestedById: req.auth?.userId,
      },
      data: { usedAt: new Date() },
    });
    if (spent.count === 1) return next();

    // PAGE tokens aren't spent — a screen re-fetches constantly and a
    // single-use token would die on the first refresh.
    const page = await prisma.override.findFirst({
      where: {
        token,
        scope: "PAGE",
        expiresAt: { gt: new Date() },
        requestedById: req.auth?.userId,
      },
    });
    if (page) return next();
  }

  // `needsOverride` is the flag the client watches to know it should offer the
  // manager prompt rather than just showing an error.
  res.status(403).json({
    error: "This needs a manager's approval",
    needsOverride: true,
  });
}

// ---------------------------------------------------------------------------
// PUBLIC ROUTES — the only three that work without signing in. They're up here
// because of the gate below; position in this file is what makes them public.
// ---------------------------------------------------------------------------

// "Are you alive?" Useful for checking the server is up without signing in.
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Sign in. Called by client/src/Login.tsx.
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Enter both a name and a passphrase" });
  }
  const user = await prisma.user.findUnique({ where: { username: String(username).toLowerCase() } });
  // The real passphrase is never stored — only a scrambled version it can be
  // compared against, which can't be turned back into the original. bcrypt is
  // deliberately slow, which is what makes guessing millions of passphrases
  // impractical.
  //
  // Note the same message for "no such user" and "wrong passphrase": telling
  // them apart would let someone work out which names exist.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Wrong name or passphrase" });
  }
  // Issue the wristband. It carries who they are and what they're allowed to
  // do, is signed so it can't be tampered with, and stops working after 12
  // hours — about one long shift.
  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, user: { username: user.username, displayName: user.displayName, role: user.role } });
});

// The list of staff accounts. Public so the login screen can offer name chips
// to tap. Note `select` — it returns names and roles only, never the stored
// passphrase hashes.
app.get("/login-roster", async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { username: true, displayName: true, role: true },
    orderBy: { role: "asc" },
  });
  res.json(users);
});

// ===========================================================================
// >>> THE GATE <<<
//
// Everything below this line requires a signed-in user
//
// This single line is the app's security. It's POSITIONAL: routes written
// ABOVE it are open to the world, routes written BELOW it demand a valid
// token. Nothing is marked or labelled — where a route sits in this file is
// what decides.
//
// So: moving a route above this line silently makes it public. Add new routes
// below it unless you genuinely mean otherwise.
// ===========================================================================
app.use(requireAuth);

// ---------------------------------------------------------------------------
// ---- Manager override ----
//
// Staff hits something admin-only, a manager types their password at the
// terminal, and the staff member carries on without anyone signing out.
//
// These two routes live BELOW the gate above on purpose. The guide this came
// from said to put them up in the Auth section — but everything above
// `app.use(requireAuth)` is public, so `req.auth` would be undefined and
// GET /overrides would have refused everybody, admins included.
// ---------------------------------------------------------------------------

// How long an approval is good for. ACTION is single-use as well, so two
// minutes only has to cover typing a password and the request landing.
const OVERRIDE_MINUTES: Record<string, number> = { ACTION: 2, PAGE: 10 };

// Five wrong passwords locks that staff member's prompt for five minutes.
// In memory on purpose: a restart clears it, and a fat-fingered password
// doesn't deserve a permanent row in the database.
const overrideLockout = new Map<number, { failures: number; lockedUntil: number }>();

app.post("/override", async (req: AuthedRequest, res) => {
  const staffId = req.auth?.userId;
  if (!staffId) return res.status(401).json({ error: "Sign in first" });

  const { password, action } = req.body;
  const scope = req.body.scope === "PAGE" ? "PAGE" : "ACTION";
  if (typeof password !== "string" || typeof action !== "string" || !password || !action) {
    return res.status(400).json({ error: "password and action are required" });
  }

  const record = overrideLockout.get(staffId);
  if (record && record.lockedUntil > Date.now()) {
    const seconds = Math.ceil((record.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `Too many wrong passwords — try again in ${seconds}s` });
  }

  // No username was typed, so ask each admin account in turn "is this yours?".
  // bcrypt.compare is deliberately slow, which is most of what makes guessing
  // a password while standing at the counter impractical.
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
  let approver: (typeof admins)[number] | null = null;
  for (const admin of admins) {
    if (await bcrypt.compare(password, admin.passwordHash)) {
      approver = admin;
      break;
    }
  }

  if (!approver) {
    // Re-read rather than reusing `record` from before the awaits above —
    // several wrong guesses can be in flight at once, and the stale copy would
    // keep resetting the count to 1.
    const now = overrideLockout.get(staffId);
    const failures = (now?.failures ?? 0) + 1;
    overrideLockout.set(staffId, {
      failures,
      lockedUntil: failures >= 5 ? Date.now() + 5 * 60 * 1000 : 0,
    });
    // 403, NOT 401. authFetch treats every 401 as "your session died" and
    // reloads the page — so a mistyped manager password would have signed the
    // staff member out mid-void.
    return res.status(403).json({ error: "That isn't an admin password" });
  }

  overrideLockout.delete(staffId);

  const override = await prisma.override.create({
    data: {
      token: crypto.randomBytes(24).toString("hex"),
      action: action.slice(0, 120),
      scope,
      approvedById: approver.id,
      requestedById: staffId,
      expiresAt: new Date(Date.now() + OVERRIDE_MINUTES[scope] * 60 * 1000),
    },
  });

  res.status(201).json({
    token: override.token,
    scope,
    approvedBy: approver.displayName,
    expiresAt: override.expiresAt,
  });
});

// The audit trail. Admin-only for real — a staff member holding a PAGE token
// for Reports should not be able to read who approved what.
app.get("/overrides", async (req: AuthedRequest, res) => {
  if (req.auth?.role !== "ADMIN") {
    return res.status(403).json({ error: "Only the admin login can do this" });
  }
  const rows = await prisma.override.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { approvedBy: true, requestedBy: true },
  });
  res.json(
    rows.map((o) => ({
      id: o.id,
      action: o.action,
      scope: o.scope,
      approvedBy: o.approvedBy.displayName,
      requestedBy: o.requestedBy.displayName,
      createdAt: o.createdAt,
      usedAt: o.usedAt,
    }))
  );
});

// ---------------------------------------------------------------------------
// ---- Settings ----
// House-wide configuration. There is exactly ONE settings record, always with
// id 1 — it's a single row used as a scratchpad, not a list of anything.
// ---------------------------------------------------------------------------

// Read the settings, creating them with sensible defaults if this is a fresh
// database. "upsert" means update-or-insert: it guarantees a row comes back,
// so nothing downstream ever has to handle settings being missing.
async function getSettings() {
  return prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, taxRate: 0.13 },
  });
}

// ---- The current location -------------------------------------------------
// The ONE place that decides what "here" means. Every menu, settings and
// checkout query goes through it, so which site a request belongs to is a
// single function to reason about rather than a rule scattered everywhere.
//
// How it decides (Stage 2a): the terminal tells us. The client attaches the
// selected location as an "X-Location-Id" header on every request — see the
// location switcher in Shell.tsx and authFetch.ts. An id we don't recognise, or
// no header at all, falls back to the first active location, which is what keeps
// a one-location business — and Login, which sends no header — working unchanged.
//
// Like getSettings(), it guarantees a row comes back: a fresh database with no
// location yet gets "Mississauga" created on the spot, so nothing downstream
// ever has to handle there being no location.
async function currentLocation(req?: Request) {
  const active = await prisma.location.findMany({
    where: { active: true },
    orderBy: { id: "asc" },
  });
  if (active.length === 0) {
    return prisma.location.create({ data: { name: "Mississauga" } });
  }
  const requestedId = Number(req?.header("X-Location-Id"));
  return active.find((l) => l.id === requestedId) ?? active[0];
}

// ---- Locations ------------------------------------------------------------
// The list every terminal's switcher reads, and the one way to add a site.
// There's no delete: a location that ever traded has history hanging off it, so
// retiring one is a Stage 2 job (flip `active` false), never a deletion.
// ---------------------------------------------------------------------------

// Every active site, for the switcher. Any signed-in user can read it — a
// terminal has to know its choices before anyone has proved they're an admin.
app.get("/locations", async (_req, res) => {
  res.json(await prisma.location.findMany({ where: { active: true }, orderBy: { id: "asc" } }));
});

// Add a site. ADMIN ONLY. A new location starts with an empty menu — the admin
// switches to it and builds one, exactly as this one was built.
app.post("/locations", requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const location = await prisma.location.create({ data: { name } });
    io.emit("locations:updated", {});
    res.status(201).json(location);
  } catch {
    // Names are unique. As elsewhere, ANY failure is reported as a clash — far
    // and away the likeliest cause.
    res.status(409).json({ error: `A location named "${name}" already exists` });
  }
});

// ---- The cash discount ----------------------------------------------------
//
// Guests who settle up in cash get money off their ENTRY charge. This is the
// only place in the app where what something costs depends on how it's paid
// for, so the rule lives in exactly one function and everything else asks it.
//
// Two callers, deliberately:
//   GET /visits/:id/cash-discount — so the Checkout screen can SHOW the
//     discount while the staff member is still deciding, without doing this
//     arithmetic itself. The browser has been the wrong place for money maths
//     in this project before.
//   POST /check-out — the real thing, written inside the payment transaction.
//
// Why not write it the moment someone taps "Cash"? Because tapping Cash is not
// paying. Staff tap it, get distracted, close the screen — and a discount left
// behind on an open tab would follow the guest to a card payment later. The
// tender isn't real until the money is taken, so neither is the discount.
//
// Returns null when it doesn't apply, which is most of the time.
function cashDiscountFor(
  lineItems: { amount: number; taxRate: number; isAdmission: boolean }[],
  settings: { cashDiscount: number; cashDiscountMinEntry: number }
) {
  // Zero means the house isn't running the offer. This is the default, so a
  // fresh database never starts handing money back on its own.
  if (settings.cashDiscount <= 0) return null;

  // No entry charge, no entry discount. This is what keeps takeout out of it —
  // a counter sale has no admission line — and it also covers a guest checked
  // in before any default admission was configured.
  const admission = lineItems.find((li) => li.isAdmission);
  if (!admission) return null;

  // Below the house minimum. A $3 child admission doesn't qualify, and neither
  // does a pass-funded visit, whose entry charge is $0.
  //
  // This test is also the only reason no clamping is needed anywhere: while the
  // minimum is larger than the discount, the entry charge cannot go negative.
  if (admission.amount < settings.cashDiscountMinEntry) return null;

  return {
    description: "Cash discount",
    amount: -settings.cashDiscount,
    // The ENTRY charge's own tax rate, not the tab's blended one that
    // /apply-discount uses. That difference is the whole point: this discount
    // is against one charge, so it must take tax off that charge and nothing
    // else. $5 off a $30 entry at 13% relieves 65c of tax, leaving the drinks
    // beside it taxed exactly as they were.
    taxRate: admission.taxRate,
  };
}

// The house tax rate and default entry charge (from Settings, shared), plus the
// current location's cash discount merged in. The client reads all four off one
// object — see MenuPage.tsx — so the response SHAPE is unchanged even though the
// cash discount now lives on Location, not Settings.
app.get("/settings", async (req, res) => {
  const [settings, location] = await Promise.all([getSettings(), currentLocation(req)]);
  res.json({
    ...settings,
    cashDiscount: location.cashDiscount,
    cashDiscountMinEntry: location.cashDiscountMinEntry,
  });
});

// Change the settings. ADMIN ONLY. Called from client/src/MenuPage.tsx.
//
// This only affects things priced FROM NOW ON. Existing menu items keep their
// own rates, and charges already on bills keep the rate they were sold at.
//
// The fields are split by where they now live: the tax rate and default
// admission are house-wide (Settings), while the cash discount is per-location
// (Location). The browser still sends and receives them as one bundle.
app.put("/settings", requireAdmin, async (req, res) => {
  const { taxRate, defaultAdmissionItemId, cashDiscount, cashDiscountMinEntry } = req.body;
  const settingsData: { taxRate?: number; defaultAdmissionItemId?: number | null } = {};
  const locationData: { cashDiscount?: number; cashDiscountMinEntry?: number } = {};

  // Stored as a decimal (0.13), not a percentage (13). The client does that
  // conversion before sending; this guards against a stray 13 arriving and
  // quietly setting tax to 1300%.
  if (taxRate !== undefined) {
    if (typeof taxRate !== "number" || taxRate < 0 || taxRate > 1) {
      return res.status(400).json({ error: "taxRate must be a number between 0 and 1 (e.g. 0.13 for 13%)" });
    }
    settingsData.taxRate = taxRate;
  }
  if (defaultAdmissionItemId !== undefined) {
    settingsData.defaultAdmissionItemId = defaultAdmissionItemId === null ? null : Number(defaultAdmissionItemId);
  }
  // Both in dollars. Negatives are refused outright — a "discount" that added
  // money to the bill is never what anyone meant.
  if (cashDiscount !== undefined) {
    if (typeof cashDiscount !== "number" || !Number.isFinite(cashDiscount) || cashDiscount < 0) {
      return res.status(400).json({ error: "The cash discount must be a number of dollars, or 0 to switch it off" });
    }
    locationData.cashDiscount = cashDiscount;
  }
  if (cashDiscountMinEntry !== undefined) {
    if (typeof cashDiscountMinEntry !== "number" || !Number.isFinite(cashDiscountMinEntry) || cashDiscountMinEntry < 0) {
      return res.status(400).json({ error: "The minimum entry fee must be a number of dollars" });
    }
    locationData.cashDiscountMinEntry = cashDiscountMinEntry;
  }

  // The minimum has to stay above the discount, and this is the check that
  // makes that a rule rather than a hope. cashDiscountFor does no clamping — it
  // relies on a qualifying entry charge always being bigger than the money
  // coming off it, which is exactly what this guarantees.
  //
  // Compared against whichever value is NOT being changed, read from the
  // location the discount now lives on.
  const location = await currentLocation(req);
  const nextDiscount = locationData.cashDiscount ?? location.cashDiscount;
  const nextMinEntry = locationData.cashDiscountMinEntry ?? location.cashDiscountMinEntry;
  if (nextDiscount > 0 && nextMinEntry <= nextDiscount) {
    return res.status(400).json({
      error: `The minimum entry fee must be more than the discount — otherwise a $${nextDiscount.toFixed(2)} discount could take an entry charge to zero or below.`,
    });
  }

  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    update: settingsData,
    create: { id: 1, taxRate: settingsData.taxRate ?? 0.13, defaultAdmissionItemId: settingsData.defaultAdmissionItemId ?? null },
  });
  // Only touch the location if a cash-discount field was actually sent.
  const updatedLocation =
    Object.keys(locationData).length > 0
      ? await prisma.location.update({ where: { id: location.id }, data: locationData })
      : location;

  // Hand back the same merged shape GET returns, so the browser sees its own
  // edit reflected without a second fetch.
  const merged = {
    ...settings,
    cashDiscount: updatedLocation.cashDiscount,
    cashDiscountMinEntry: updatedLocation.cashDiscountMinEntry,
  };
  // Tell every terminal. (Nothing currently listens for this one — the Menu
  // screen is the only place settings appear, and it already knows. Kept
  // because it costs nothing and completes the pattern.)
  io.emit("settings:updated", merged);
  res.json(merged);
});

// ---------------------------------------------------------------------------
// ---- Menu ----
// The catalogue: categories, and the items inside them. All editing here is
// ADMIN ONLY, done from client/src/MenuPage.tsx. Reading is open to any
// signed-in user, because the till needs the menu to draw its tiles.
//
// Every change broadcasts "menu:updated", which makes the till and the kitchen
// refetch — so a price change reaches every terminal within a second.
// ---------------------------------------------------------------------------

// The whole menu in one go: categories, alphabetical, each with its items
// nested inside. This one query feeds the till, the kitchen and the editor.
app.get("/categories", async (req, res) => {
  // Only THIS location's menu. With one site that's every category; the moment a
  // second site exists, each till sees only its own menu without another change.
  const location = await currentLocation(req);
  const categories = await prisma.category.findMany({
    where: { locationId: location.id },
    include: { items: { orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

// WHICH BOARD a category's tickets print on, worked out from what the browser
// asked for. Anything that isn't explicitly the bar is the kitchen, and a
// section that prints nothing at all is forced back to the kitchen so it can't
// sit in the database claiming a station it will never use.
//
// The fallback direction is deliberate and is the rule this whole feature
// follows: when in doubt, the KITCHEN. That board has existed for a year, is
// always staffed, and is on a wall. A drink that wrongly appears there is
// noticed in seconds by someone whose job is to read it. The opposite mistake —
// a ticket that reaches no board at all — has no error, no card, and no signal
// until a guest asks where their order is. Fail the noisy way.
function stationFor(group: string, station: unknown) {
  if (group !== "FOOD_DRINK") return "KITCHEN" as const;
  return station === "BAR" ? ("BAR" as const) : ("KITCHEN" as const);
}

// Add a category. ADMIN ONLY.
app.post("/categories", requireAdmin, async (req, res) => {
  const { name, group, isAdmission, station } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  // Anything that isn't explicitly merchandise is treated as food and drink.
  const menuGroup = group === "MERCH_SERVICE" ? "MERCH_SERVICE" : "FOOD_DRINK";
  // A new section joins the current location's menu.
  const location = await currentLocation(req);
  try {
    const category = await prisma.category.create({
      data: {
        locationId: location.id,
        name,
        group: menuGroup,
        // Food & drinks is what gets made to order — that's the whole rule for
        // whether a ticket prints. `station` below decides where it prints.
        isKitchen: menuGroup === "FOOD_DRINK",
        station: stationFor(menuGroup, station),
        isAdmission: Boolean(isAdmission),
      },
    });
    io.emit("menu:updated", {});
    res.status(201).json(category);
  } catch {
    // Names are unique WITHIN a location now, and a clash is far and away the
    // most likely failure. Worth knowing: this reports ANY failure as a
    // duplicate name, so a different database problem would show a misleading
    // message.
    res.status(409).json({ error: `A category named "${name}" already exists at this location` });
  }
});

// Rename a category, move it between the two halves, send it to the other
// board, or toggle its admission flag. ADMIN ONLY. Moving into Food & drinks
// starts it printing tickets; moving out stops that.
//
// ⚠️ THIS REPLACES THE WHOLE CATEGORY, it doesn't patch it. Every field is
//    rewritten from the body on every call, and the browser's saveCategory is
//    the one function behind Rename, Admission, Move AND Send to bar. So a
//    field the browser forgets to send is a field that gets reset to its
//    default — leave `station` out and renaming "Drinks" quietly marches every
//    drink back onto the cook's board. If you add a field here, add it there.
app.put("/categories/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, group, isAdmission, station } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const menuGroup = group === "MERCH_SERVICE" ? "MERCH_SERVICE" : "FOOD_DRINK";
  const category = await prisma.category.update({
    where: { id },
    data: {
      name,
      group: menuGroup,
      isKitchen: menuGroup === "FOOD_DRINK",
      station: stationFor(menuGroup, station),
      isAdmission: Boolean(isAdmission),
    },
  });
  io.emit("menu:updated", {});
  res.json(category);
});

// Remove a category. ADMIN ONLY. Refuses while it still holds items, so half
// the menu can't be orphaned by one click.
app.delete("/categories/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const itemCount = await prisma.menuItem.count({ where: { categoryId: id } });
  if (itemCount > 0) {
    return res.status(409).json({ error: "Move or delete this category's items first" });
  }
  await prisma.category.delete({ where: { id } });
  io.emit("menu:updated", {});
  res.json({ ok: true });
});

// Shared by create and update — one place that decides what a menu item is.
//
// Its real job is not trusting what arrived. Anything sent by a browser could
// have been tampered with, so every field is forced into the right shape here
// rather than being passed to the database as-is.
//
// One trap worth knowing: if `taxRate` is missing or nonsense, this quietly
// falls back to 0 — meaning an item saved without a rate sells tax-free. The
// Menu screen always sends one, so it doesn't happen in practice.
function menuItemData(body: Record<string, unknown>) {
  return {
    categoryId: Number(body.categoryId),
    name: String(body.name),
    price: Number(body.price),
    description: body.description ? String(body.description) : null,
    taxRate: Number.isFinite(Number(body.taxRate)) ? Number(body.taxRate) : 0,
    imageData: body.imageData ? String(body.imageData) : null,
    // New items default to on sale; existing ones keep whatever was sent.
    available: body.available === undefined ? true : Boolean(body.available),
    // Same shape, same reason: `Boolean(undefined)` is false, and defaulting
    // this to false would silently stop food reaching the kitchen. The
    // `=== undefined` check is what makes a missing field mean "yes, send it".
    sendsToKitchen: body.sendsToKitchen === undefined ? true : Boolean(body.sendsToKitchen),
    // How many passes buying this GRANTS. Not to be confused with redeemsPass
    // just below, which is whether choosing it SPENDS one.
    visitCredits: Number(body.visitCredits) || 0,
    redeemsPass: Boolean(body.redeemsPass),
    // Only ever "FIXED" or "PERCENT" — anything else means it isn't a
    // discount, so it lands as null rather than being taken on trust.
    discountKind:
      body.discountKind === "FIXED" || body.discountKind === "PERCENT"
        ? String(body.discountKind)
        : null,
    discountValue: Number(body.discountValue) || 0,
  };
}

// Add an item to the menu. ADMIN ONLY.
app.post("/menu-items", requireAdmin, async (req, res) => {
  const { categoryId, name, price } = req.body;
  if (!categoryId || !name || typeof price !== "number") {
    return res.status(400).json({ error: "categoryId, name, and price are required" });
  }
  const item = await prisma.menuItem.create({ data: menuItemData(req.body) });
  io.emit("menu:updated", {});
  res.status(201).json(item);
});

// Save changes to an item. ADMIN ONLY. Changing a price here does NOT change
// anything already on a bill — charges store their own name and price as text
// at the moment of sale.
app.put("/menu-items/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { categoryId, name, price } = req.body;
  if (!categoryId || !name || typeof price !== "number") {
    return res.status(400).json({ error: "categoryId, name, and price are required" });
  }
  const item = await prisma.menuItem.update({ where: { id }, data: menuItemData(req.body) });
  io.emit("menu:updated", {});
  res.json(item);
});

// Flip one item on or off without opening the editor.
app.post("/menu-items/:id/available", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const item = await prisma.menuItem.update({
    where: { id },
    data: { available: Boolean(req.body.available) },
  });
  io.emit("menu:updated", {});
  res.json(item);
});

// Remove an item from the menu entirely. ADMIN ONLY. Safe for history: past
// bills keep their own copy of the name and price.
app.delete("/menu-items/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await prisma.menuItem.delete({ where: { id } });
  io.emit("menu:updated", {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ---- Customers ----
// The guest book. Any signed-in user can look people up and create new ones —
// the front desk does that constantly — but EDITING a profile is admin only.
// Served to client/src/CustomerDirectory.tsx.
// ---------------------------------------------------------------------------

// The directory list, newest first.
app.get("/customers", async (_req, res) => {
  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      // Just the newest visit — enough for the "Last visit" column, and if its
      // checkOutAt is still null we know they're in the building right now.
      visits: {
        orderBy: { checkInAt: "desc" },
        take: 1,
        select: { id: true, checkInAt: true, checkOutAt: true },
      },
    },
  });
  res.json(customers);
});

// One guest's full record: every visit they've ever made, each with its locker
// and its itemised bill. This is what fills the profile page, so it's much
// heavier than the list above — hence two separate endpoints.
app.get("/customers/:id", async (req, res) => {
  const id = Number(req.params.id);
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      visits: {
        orderBy: { checkInAt: "desc" },
        include: {
          locker: true,
          bill: { include: { lineItems: true } },
        },
      },
    },
  });
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.json(customer);
});

// Create a guest. NOT admin-only, deliberately: the front desk signs new
// people up all day. Gender is required because it decides which locker pool
// they can be given one from.
app.post("/customers", async (req, res) => {
  const { firstName, lastName, gender, phone, email, dateOfBirth, address, notes } = req.body;
  if (!firstName || !lastName || !gender) {
    return res.status(400).json({ error: "First name, last name, and gender are required" });
  }
  const customer = await prisma.customer.create({
    data: {
      firstName,
      lastName,
      gender,
      phone: phone || null,
      email: email || null,
      address: address || null,
      notes: notes || null,
      // `|| null` above turns an empty form box into a proper "not recorded"
      // rather than storing an empty string, so "no phone number" is one thing
      // in the database rather than two.
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
    },
  });
  io.emit("customer:created", customer);
  res.status(201).json(customer);
});

// Edit a guest's details. ADMIN ONLY.
app.put("/customers/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { firstName, lastName, gender, phone, email, dateOfBirth, address, notes } = req.body;
  if (!firstName || !lastName || !gender) {
    return res.status(400).json({ error: "First name, last name, and gender are required" });
  }

  const existing = await prisma.customer.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Customer not found" });

  // Lockers are split into a men's pool and a women's pool, so flipping gender
  // mid-visit would leave this guest holding a locker from the wrong one.
  if (gender !== existing.gender) {
    const activeVisit = await prisma.visit.findFirst({
      where: { customerId: id, checkOutAt: null },
    });
    if (activeVisit) {
      return res.status(400).json({
        error: "Check this guest out before changing their gender — their locker belongs to the other pool",
      });
    }
  }

  const customer = await prisma.customer.update({
    where: { id },
    data: {
      firstName,
      lastName,
      gender,
      phone: phone || null,
      email: email || null,
      address: address || null,
      notes: notes || null,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
    },
  });
  io.emit("customer:updated", customer);
  res.json(customer);
});

// ---------------------------------------------------------------------------
// ---- Lockers ----
// The physical lockers. They're created once by prisma/seed.ts (120 of them,
// M01–M60 and F01–F60) and then just change status as guests come and go.
//
// Each belongs to a gendered pool, and a guest can only be given one from
// their own — a rule enforced at check-in and again on any locker move.
// ---------------------------------------------------------------------------

// Every locker and its current state. Used by the dashboard's capacity dials
// and by every "pick a locker" dropdown.
app.get("/lockers", async (_req, res) => {
  const lockers = await prisma.locker.findMany({ orderBy: [{ gender: "asc" }, { number: "asc" }] });
  res.json(lockers);
});

// Add a locker. Rarely used — the building's lockers don't change often, and
// the seed script creates them all. No screen in the client calls this; it's
// here for adding one by hand if the building ever changes.
app.post("/lockers", async (req, res) => {
  const { number, gender } = req.body;
  if (!number || !gender) {
    return res.status(400).json({ error: "number and gender are required" });
  }
  const locker = await prisma.locker.create({ data: { number, gender } });
  res.status(201).json(locker);
});

// ===========================================================================
// ---- Visits + billing ----
//
// The heart of the app: a guest's stay from the moment they walk in to the
// moment they pay. A VISIT ties together the person, their locker, their BILL
// (the tab) and their kitchen ORDERS.
//
// THE VISIT PASS SYSTEM shows up throughout this section, and its two halves
// are opposites that are easy to confuse:
//
//   visitCredits > 0  on a menu item — buying it ADDS passes to the guest's
//                     balance. A 10-visit pack has visitCredits: 10.
//   redeemsPass       on a menu item — choosing it SPENDS one of their passes
//                     instead of charging money.
//
// And the timing is deliberately lopsided: buying a pack credits the balance
// IMMEDIATELY, but a redeemed pass is only deducted at CHECK-OUT. So a guest
// mid-visit still shows the pass they're currently using as unspent.
// ===========================================================================

// Everyone currently in the building, with their guest record, locker, tab and
// kitchen orders all nested in. This single query is the "state of the floor"
// and is what the dashboard, the till and the kitchen all refetch whenever a
// live update arrives.
app.get("/visits/active", async (_req, res) => {
  const visits = await prisma.visit.findMany({
    // Takeout orders are created already closed, so `checkOutAt` alone keeps
    // them out. Naming the kind as well says so out loud, and would still hold
    // if takeout ever learned to stay open.
    where: { checkOutAt: null, kind: "STAY" },
    include: {
      customer: true,
      locker: true,
      // Who's paying for the entry, when it isn't the guest. The till and the
      // checkout screen both name them, so it has to travel with the visit.
      passUsedCustomer: true,
      bill: { include: { lineItems: true } },
      orders: { include: { items: true }, orderBy: { createdAt: "desc" } },
    },
    orderBy: { checkInAt: "desc" },
  });
  res.json(visits);
});

// ---------------------------------------------------------------------------
// CAN THIS SPONSOR TAKE ON ONE MORE GUEST?
//
// A sponsored visit spends the SPONSOR's pass, and — like every pass here —
// not until check-out. So between checking in and leaving, a guest is holding
// a claim on a pass that hasn't been taken yet.
//
// That's why "do they have at least one?" isn't enough. A sponsor with one
// pass could otherwise be picked for two guests: both check-ins would see a
// balance of 1, and both would deduct at check-out, leaving them at −1. So the
// question is really "do they have more passes than guests already relying on
// them?", which is what this counts.
//
// `exceptVisitId` is for re-picking a sponsor on a visit that already has one:
// without it the visit would be counted against itself and refuse.
// ---------------------------------------------------------------------------
async function sponsorRefusal(sponsorId: number, exceptVisitId?: number) {
  const sponsor = await prisma.customer.findUnique({ where: { id: sponsorId } });
  if (!sponsor) return "That customer no longer exists";

  const outstanding = await prisma.visit.count({
    where: {
      passUsedCustomerId: sponsorId,
      checkOutAt: null,
      ...(exceptVisitId ? { id: { not: exceptVisitId } } : {}),
    },
  });

  if (sponsor.visitPassBalance > outstanding) return null; // fine, carry on

  const who = `${sponsor.firstName} ${sponsor.lastName}`;
  return outstanding === 0
    ? `${who} has no passes left.`
    : `${who} has ${sponsor.visitPassBalance} pass${sponsor.visitPassBalance === 1 ? "" : "es"} ` +
      `and ${outstanding} guest${outstanding === 1 ? " is" : "s are"} already checked in on them.`;
}

// CHECK IN — a guest walks in. Called from client/src/CustomerDirectory.tsx.
//
// Four things happen: the locker is claimed, the visit is opened, a bill is
// started, and the entry charge is put on it automatically.
//
// The validation below matters more than it looks: two terminals can be
// staring at the same free locker at the same moment, so the client's checks
// are only a courtesy and these are the ones that count.
app.post("/check-in", async (req, res) => {
  const { customerId, lockerId, passSponsorId } = req.body;
  if (!lockerId) {
    return res.status(400).json({ error: "Pick a locker before checking in" });
  }
  // Someone else is paying for this entry out of their pass balance. Checked
  // before anything is created, so a refusal leaves nothing half-done.
  if (passSponsorId) {
    const refusal = await sponsorRefusal(Number(passSponsorId));
    if (refusal) return res.status(409).json({ error: refusal });
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    return res.status(404).json({ error: "Customer not found" });
  }

  const locker = await prisma.locker.findUnique({ where: { id: lockerId } });
  if (!locker) {
    return res.status(404).json({ error: "Locker not found" });
  }
  if (locker.status !== "AVAILABLE") {
    return res.status(409).json({ error: `Locker ${locker.number} is not available` });
  }
  if (locker.gender !== customer.gender) {
    return res.status(409).json({ error: `Locker ${locker.number} is not in this customer's locker pool` });
  }

  // Claim the locker and open the visit as one indivisible step. A transaction
  // means both or neither: without it, a failure between the two could mark a
  // locker occupied by nobody, and it would stay unusable until someone
  // noticed and fixed it by hand.
  const [updatedLocker, newVisit] = await prisma.$transaction([
    prisma.locker.update({ where: { id: locker.id }, data: { status: "OCCUPIED" } }),
    prisma.visit.create({ data: { customerId: customer.id, lockerId: locker.id } }),
  ]);

  // Open their tab, stamped with today's house tax rate for the record.
  const settings = await getSettings();
  const bill = await prisma.bill.create({ data: { visitId: newVisit.id, taxRate: settings.taxRate } });

  // Pick the admission to auto-apply: a pass redemption if the customer has
  // passes banked, otherwise the configured default admission.
  // visitCredits: 0 keeps pass PACKS (items that sell credits) out of the search.
  // A sponsor overrides this. Without the `passSponsorId ||` the guest's own
  // balance would be checked first and quietly used instead — the sponsor
  // would be recorded but never charged.
  const passAdmission = (passSponsorId || customer.visitPassBalance >= 1)
    ? await prisma.menuItem.findFirst({
        where: { redeemsPass: true, visitCredits: 0, category: { isAdmission: true } },
      })
    : null;
  // No passes banked (or no pass-admission item configured) — fall back to the
  // ordinary entry charge set on the Menu screen. If neither exists, the guest
  // is checked in with an empty tab and staff pick an admission by hand.
  const admissionItem = passAdmission ??
    (settings.defaultAdmissionItemId
      ? await prisma.menuItem.findUnique({ where: { id: settings.defaultAdmissionItemId } })
      : null);
  // Put the entry charge on the tab, copying the name, price and tax rate as
  // they stand right now. From here on the charge is independent of the menu.
  const admissionLine = admissionItem
    ? await prisma.billLineItem.create({
        data: {
          billId: bill.id,
          description: admissionItem.name,
          amount: admissionItem.price,
          taxRate: admissionItem.taxRate,
          isAdmission: true,
        },
      })
    : null;
  // Mark the visit as pass-funded. The balance is NOT reduced here — that
  // happens at check-out, so a guest mid-visit still sees the pass they're
  // using as unspent.
  const checkedInVisit = passAdmission
    ? await prisma.visit.update({
        where: { id: newVisit.id },
        data: {
          redeemsPass: true,
          // Whose balance this will come out of at check-out. Null here means
          // the guest's own.
          passUsedCustomerId: passSponsorId ? Number(passSponsorId) : null,
        },
      })
    : newVisit;

  // Assemble the answer by hand from the pieces created above, rather than
  // re-reading it all back out of the database.
  const visit = {
    ...checkedInVisit,
    customer,
    locker: updatedLocker,
    bill: { ...bill, lineItems: admissionLine ? [admissionLine] : [] },
  };

  // Tell every terminal: the locker is now taken, and someone new is in.
  io.emit("locker:updated", updatedLocker);
  io.emit("visit:checked-in", visit);
  res.status(201).json(visit);
});

// Set (or replace) this visit's single admission charge
//
// A guest has exactly ONE entry charge, so this REPLACES rather than adds —
// which is why tapping an admission tile at the till skips the cart entirely.
// Used when someone arrives on a day rate and upgrades, or vice versa.
app.post("/visits/:visitId/set-admission", async (req, res) => {
  const visitId = Number(req.params.visitId);
  const { menuItemId, passSponsorId } = req.body;

  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: { bill: true, customer: true },
  });
  if (!visit || visit.checkOutAt || !visit.bill) {
    return res.status(404).json({ error: "Active visit not found" });
  }
  // A takeout order has no entry charge to swap, and no profile whose pass
  // balance could pay for one. It can't reach here anyway — it's checked out
  // from birth, so the line above turns it away — but saying it plainly is what
  // lets the pass check further down trust `visit.customer` exists.
  if (!visit.customer) {
    return res.status(400).json({ error: "A takeout order has no admission to set" });
  }

  const item = await prisma.menuItem.findUnique({
    where: { id: menuItemId },
    include: { category: true },
  });
  if (!item) {
    return res.status(404).json({ error: "Menu item not found" });
  }
  // A pass PACK lives in the admission category but is an ordinary sale — it
  // grants passes, it isn't an entry type. Allowing it here would wipe out the
  // guest's real entry charge and replace it with the pack.
  if (item.visitCredits > 0) {
    return res.status(400).json({
      error: `"${item.name}" sells ${item.visitCredits} visit passes — it can't be used as an admission type`,
    });
  }
  if (!item.category.isAdmission) {
    return res.status(400).json({ error: `"${item.name}" is not an admission type` });
  }
  // Whose pass pays. A sponsor is only meaningful on a pass admission — asking
  // for one alongside a cash entry is a mistake worth saying out loud rather
  // than silently ignoring.
  const sponsorId = passSponsorId ? Number(passSponsorId) : null;
  if (sponsorId && !item.redeemsPass) {
    return res.status(400).json({ error: `"${item.name}" isn't paid with a pass, so it can't be sponsored` });
  }
  if (sponsorId) {
    // This visit is excluded from the count — otherwise re-picking the same
    // sponsor for a visit that already has them would refuse itself.
    const refusal = await sponsorRefusal(sponsorId, visitId);
    if (refusal) return res.status(409).json({ error: refusal });
  } else if (item.redeemsPass && visit.customer.visitPassBalance < 1) {
    // Unsponsored pass admission — the guest's own balance has to cover it.
    return res.status(409).json({
      error: `${visit.customer.firstName} ${visit.customer.lastName} has no visit passes remaining`,
    });
  }

  // Swap the entry charge: remove whatever admission was there, add the new
  // one, and record whether this visit is now pass-funded — all as one step,
  // so there's no instant where the tab has no entry charge at all.
  const billId = visit.bill.id;
  await prisma.$transaction([
    prisma.billLineItem.deleteMany({ where: { billId, isAdmission: true } }),
    prisma.billLineItem.create({
      data: {
        billId,
        description: item.name,
        amount: item.price,
        taxRate: item.taxRate,
        isAdmission: true,
      },
    }),
    prisma.visit.update({
      where: { id: visitId },
      data: {
        redeemsPass: item.redeemsPass,
        // Always written, never left alone. Switching a sponsored visit to a
        // cash admission has to CLEAR the sponsor — otherwise they'd still be
        // charged at check-out for an entry they're no longer paying for.
        passUsedCustomerId: item.redeemsPass ? sponsorId : null,
      },
    }),
  ]);

  io.emit("bill:line-item-added", { billId });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// APPLY A DISCOUNT to a guest's tab. Employee discounts, mainly.
//
// requireAdmin is doing real work here. A staff member deciding their own
// discount is the exact thing this guards against — so an ordinary staff login
// can only get through by having a manager type their password, which mints
// the override token that requireAdmin accepts. Every one lands in the log.
//
// AND the figure is worked out HERE, not in the browser. The browser only says
// WHICH discount to apply. If it sent the amount instead, the manager's
// password would be protecting a number the staff member had already chosen —
// which would make the whole approval theatre.
//
// It reads charges already on the tab, so items sitting in an unconfirmed cart
// aren't counted: staff ring up first, then discount.
// ---------------------------------------------------------------------------
app.post("/visits/:visitId/apply-discount", requireAdmin, async (req, res) => {
  const visitId = Number(req.params.visitId);
  const { menuItemId } = req.body;

  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: { bill: { include: { lineItems: true } } },
  });
  if (!visit || visit.checkOutAt || !visit.bill) {
    return res.status(404).json({ error: "Active visit not found" });
  }
  // Once a bill is settled it's read-only — undoing it means a refund, the
  // same rule that stops charges being voided after payment.
  if (visit.bill.paidAt) {
    return res.status(409).json({ error: "That bill is already paid — a refund is the way back" });
  }

  const item = await prisma.menuItem.findUnique({ where: { id: menuItemId } });
  if (!item || !item.discountKind) {
    return res.status(400).json({ error: "That menu item isn't a discount" });
  }

  // What's on the tab right now. A second discount therefore works off the
  // already-discounted figure rather than the original, which is the sane
  // reading of "20% off" applied twice.
  const subtotal = visit.bill.lineItems.reduce((sum, li) => sum + li.amount, 0);
  const taxSoFar = visit.bill.lineItems.reduce((sum, li) => sum + li.amount * li.taxRate, 0);

  let off = item.discountKind === "PERCENT"
    ? subtotal * (item.discountValue / 100)
    : item.discountValue;

  // Never hand money back through a discount. A $50 discount on a $12 tab
  // takes it to zero, not to −$38.
  if (off > subtotal) off = subtotal;
  if (off <= 0) {
    return res.status(400).json({ error: "There's nothing on this tab to discount" });
  }

  // The discount carries the tab's BLENDED tax rate — the tax already on the
  // bill divided by its subtotal. That makes tax fall by exactly the same
  // proportion as the goods, which comes out right even when the tab mixes
  // rates: 20% off a tab of 13% food and 0% food removes 20% of the tax too,
  // not 13% of the discount.
  const blendedRate = subtotal > 0 ? taxSoFar / subtotal : 0;

  const line = await prisma.billLineItem.create({
    data: {
      billId: visit.bill.id,
      description: item.name,
      amount: -off,          // negative — this is the only thing that makes one
      taxRate: blendedRate,
    },
  });

  // Same shout every other charge makes, so open tabs update themselves on
  // every terminal without anything new to listen for.
  io.emit("bill:line-item-added", { visitId, line });
  res.status(201).json(line);
});

// What the cash discount WOULD be on this tab, if the guest paid cash right
// now. Changes nothing — it exists so the Checkout screen can show the discount
// and the real total while the staff member is still choosing how to be paid.
//
// The number comes from cashDiscountFor, the same function that writes the real
// charge at check-out. That is the point of this endpoint: the browser never
// works out the discount for itself, so the figure on screen and the figure in
// the till cannot drift apart.
//
// Answers null when the discount doesn't apply, which is most of the time.
app.get("/visits/:visitId/cash-discount", async (req, res) => {
  const visitId = Number(req.params.visitId);
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: { bill: { include: { lineItems: true } } },
  });
  if (!visit || visit.checkOutAt || !visit.bill) {
    return res.status(404).json({ error: "Active visit not found" });
  }
  // The cash discount is per-location now, so it's the location — not the
  // house settings — that carries the numbers cashDiscountFor needs.
  res.json(cashDiscountFor(visit.bill.lineItems, await currentLocation(req)));
});

// Flag a locker as broken, or return it to service.
//
// The guard is the whole point of this endpoint. A locker can only go
// AVAILABLE → MAINTENANCE and MAINTENANCE → AVAILABLE. In particular an
// OCCUPIED locker can never be flagged: doing so would leave a guest holding a
// key to a locker the system thinks is out of action, and check-out would then
// hand a broken locker back to the available pool. Staff move the guest first,
// which frees this locker, and then it can be flagged.
//
// The rule lives here rather than only in the browser because a stale page, a
// second terminal or a direct request could all try it otherwise.
app.post("/lockers/:lockerId/status", async (req, res) => {
  const lockerId = Number(req.params.lockerId);
  const { status, note } = req.body;

  if (status !== "AVAILABLE" && status !== "MAINTENANCE") {
    return res.status(400).json({ error: "Status must be AVAILABLE or MAINTENANCE" });
  }

  const locker = await prisma.locker.findUnique({ where: { id: lockerId } });
  if (!locker) {
    return res.status(404).json({ error: "Locker not found" });
  }

  if (status === "MAINTENANCE" && locker.status !== "AVAILABLE") {
    return res.status(409).json({
      error: locker.status === "OCCUPIED"
        ? `Locker ${locker.number} has a guest in it. Move them to another locker first, then flag this one.`
        : `Locker ${locker.number} is already out of service.`,
    });
  }
  if (status === "AVAILABLE" && locker.status !== "MAINTENANCE") {
    return res.status(409).json({
      error: `Locker ${locker.number} isn't out of service.`,
    });
  }

  const updated = await prisma.locker.update({
    where: { id: lockerId },
    data: {
      status,
      // Coming back into service clears the note, so it can never describe a
      // locker that's currently working.
      maintenanceNote: status === "MAINTENANCE" ? (note ?? null) : null,
    },
  });

  io.emit("locker:updated", updated);
  res.json(updated);
});

// ---- Tables ----------------------------------------------------------------

// The digits on the end of a table's name. "T7" → 7, "Patio 12" → 12, and
// anything with no number at all → -1 so it sorts to the front and is the last
// thing a shrink would ever remove.
//
// Sorting by the NAME as text puts T10 before T2, which is how the board has
// been showing them: T1, T10, T11 … T16, T2, T3. Lockers dodged this by being
// called M01–M60; tables were named T1–T16 without the padding. Sorting on the
// number rather than renaming the rows keeps live data untouched and still
// works if a table is ever called something like "Patio 3".
function tableNumberOf(name: string) {
  const digits = name.match(/(\d+)\s*$/);
  return digits ? Number(digits[1]) : -1;
}

// Every table and its status. No filtering — the board shows the whole lounge.
app.get("/tables", async (_req, res) => {
  const tables = await prisma.table.findMany();
  tables.sort((a, b) => tableNumberOf(a.number) - tableNumberOf(b.number) || a.number.localeCompare(b.number));
  res.json(tables);
});

// Seat a table, clear it, flag it out of use, or return it to service.
//
// The allowed moves:
//   AVAILABLE   → OCCUPIED      seating guests
//   AVAILABLE   → MAINTENANCE   taking it out of use
//   OCCUPIED    → AVAILABLE     clearing it
//   MAINTENANCE → AVAILABLE     back into use
//
// Everything else is refused. In particular an occupied table can't be flagged
// out of use directly — clear it first, the same rule lockers follow.
app.post("/tables/:tableId/status", async (req, res) => {
  const tableId = Number(req.params.tableId);
  const { status, note } = req.body;

  if (status !== "AVAILABLE" && status !== "OCCUPIED" && status !== "MAINTENANCE") {
    return res.status(400).json({ error: "Unknown table status" });
  }

  const table = await prisma.table.findUnique({ where: { id: tableId } });
  if (!table) {
    return res.status(404).json({ error: "Table not found" });
  }

  if (status !== "AVAILABLE" && table.status !== "AVAILABLE") {
    return res.status(409).json({
      error: table.status === "OCCUPIED"
        ? `Table ${table.number} is occupied. Clear it first.`
        : `Table ${table.number} is out of service.`,
    });
  }
  if (status === "AVAILABLE" && table.status === "AVAILABLE") {
    return res.status(409).json({ error: `Table ${table.number} is already free.` });
  }

  const updated = await prisma.table.update({
    where: { id: tableId },
    data: {
      status,
      // Only an occupied table has a clock running, and only an out-of-service
      // one has a reason. Both are cleared otherwise, so neither can outlive
      // the state it describes.
      occupiedSince: status === "OCCUPIED" ? new Date() : null,
      maintenanceNote: status === "MAINTENANCE" ? (note ?? null) : null,
    },
  });

  io.emit("table:updated", updated);
  res.json(updated);
});

// ---------------------------------------------------------------------------
// HOW MANY TABLES ARE THERE? Set the total and the lounge is made to match.
//
// Replaces editing the list in prisma/seed-tables.ts and re-running it, which
// was a developer job. Growing adds tables on the end; shrinking takes the
// highest-numbered ones away.
//
// Behind requireAdmin, so an ordinary staff login can only do this by having a
// manager type their password — and every use lands in the approvals log.
//
// Deleting a table is safe in a way that's worth stating: nothing in the
// schema points at Table, so removing one leaves nothing orphaned. That's the
// whole reason this can be a plain delete rather than a "hidden" flag.
// ---------------------------------------------------------------------------
app.put("/tables/count", requireAdmin, async (req, res) => {
  const total = Number(req.body.total);
  if (!Number.isInteger(total) || total < 0 || total > 200) {
    return res.status(400).json({ error: "Give a whole number of tables between 0 and 200" });
  }
  // Optional. New tables get this many seats; leaving it blank means the board
  // simply won't show a seat count for them.
  const seats = req.body.seats === undefined || req.body.seats === null || req.body.seats === ""
    ? null
    : Number(req.body.seats);
  if (seats !== null && (!Number.isInteger(seats) || seats < 0 || seats > 99)) {
    return res.status(400).json({ error: "Seats must be a whole number, or left blank" });
  }

  const tables = await prisma.table.findMany();
  const sorted = [...tables].sort((a, b) => tableNumberOf(a.number) - tableNumberOf(b.number));

  // ---- Shrinking: take the highest-numbered ones away ----
  if (total < sorted.length) {
    const doomed = sorted.slice(total);
    // Refuse the WHOLE operation if any of them is in use, rather than
    // skipping down to the next free one — that would quietly delete a table
    // the admin never intended to lose.
    const busy = doomed.filter((t) => t.status === "OCCUPIED");
    if (busy.length > 0) {
      const names = busy.map((t) => t.number).join(", ");
      return res.status(409).json({
        error: `${names} ${busy.length === 1 ? "is" : "are"} occupied. Clear ${busy.length === 1 ? "it" : "them"} first.`,
      });
    }
    await prisma.table.deleteMany({ where: { id: { in: doomed.map((t) => t.id) } } });
  }

  // ---- Growing: add on the end ----
  if (total > sorted.length) {
    // Counted from the highest NAME, not from how many there are. If T5 was
    // removed at some point there are 15 tables but the highest is still T16,
    // and numbering from the count would try to create a second T16.
    let next = sorted.reduce((high, t) => Math.max(high, tableNumberOf(t.number)), 0) + 1;
    const taken = new Set(tables.map((t) => t.number));
    const fresh: { number: string; seats: number | null }[] = [];
    while (fresh.length < total - sorted.length) {
      const number = `T${next}`;
      next++;
      if (taken.has(number)) continue; // belt and braces against an odd name
      fresh.push({ number, seats });
    }
    await prisma.table.createMany({ data: fresh });
  }

  // total === sorted.length falls through both blocks and changes nothing.
  io.emit("table:updated", {});
  const after = await prisma.table.count();
  res.json({ total: after });
});

// How many people ONE table takes. Setting the total above gives every new
// table the same seat count, which is fine when a lounge is uniform and no use
// when it isn't — a two-seater by the window next to a six-seater.
//
// Blank clears it, and the board then simply shows no seat count for that
// table, exactly as it does for one that never had one.
app.put("/tables/:tableId/seats", requireAdmin, async (req, res) => {
  const tableId = Number(req.params.tableId);
  const seats = req.body.seats === undefined || req.body.seats === null || req.body.seats === ""
    ? null
    : Number(req.body.seats);
  if (seats !== null && (!Number.isInteger(seats) || seats < 0 || seats > 99)) {
    return res.status(400).json({ error: "Seats must be a whole number, or left blank" });
  }

  const table = await prisma.table.findUnique({ where: { id: tableId } });
  if (!table) return res.status(404).json({ error: "Table not found" });

  // Deliberately allowed whatever the table is doing. A seat count describes
  // the furniture, not the guests — correcting it while someone's sitting there
  // changes nothing about their meal.
  const updated = await prisma.table.update({ where: { id: tableId }, data: { seats } });
  io.emit("table:updated", updated);
  res.json(updated);
});

// Confirm a pending order: every item hits the bill, kitchen items join ONE
// kitchen order, pass credits apply — all in a single transaction.
//
// THE BUSIEST ENDPOINT IN THE APP. Called from both client/src/PointOfSale.tsx
// (the till's "Add to tab") and client/src/StationBoard.tsx (the counter composer),
// which is why an order placed either way behaves identically.
//
// The client sends one entry per unit — three teas arrive as three entries,
// not "tea ×3" — because that's how bills and kitchen tickets count things.
app.post("/visits/:visitId/confirm-order", async (req, res) => {
  const visitId = Number(req.params.visitId);
  const { items } = req.body;
  // Optional. Which table in the lounge to run the food out to, when the guest
  // isn't waiting at their locker. Null for the great majority of orders.
  const tableId = req.body.tableId ? Number(req.body.tableId) : null;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "No items to confirm" });
  }
  for (const it of items) {
    if (!it || !it.name || typeof it.amount !== "number") {
      return res.status(400).json({ error: "Each item needs a name and an amount" });
    }
  }

  const visit = await prisma.visit.findUnique({ where: { id: visitId }, include: { bill: true } });
  if (!visit || visit.checkOutAt || !visit.bill) {
    return res.status(404).json({ error: "Active visit not found" });
  }
  // A table only makes sense for someone sitting in the building. Takeout is
  // paid at the counter and walks out, so it never reaches here anyway — this
  // says so out loud rather than relying on that.
  if (tableId !== null && visit.kind === "TAKEOUT") {
    return res.status(400).json({ error: "A takeout order isn't sitting at a table" });
  }
  let table = null;
  if (tableId !== null) {
    table = await prisma.table.findUnique({ where: { id: tableId } });
    if (!table) return res.status(404).json({ error: "Table not found" });
    // Occupied is fine — two friends on separate tabs can share a table, which
    // is ordinary at a bathhouse. Out of service is not: nobody should be sent
    // to run food to a table that isn't there.
    if (table.status === "MAINTENANCE") {
      return res.status(409).json({ error: `Table ${table.number} is out of service` });
    }
  }
  const billId = visit.bill.id;
  // Pulled out as its own value rather than read off `visit` later, because the
  // pass-credit step at the bottom runs inside a transaction callback and
  // TypeScript stops trusting `visit.customerId` once it's in there.
  const customerId = visit.customerId;
  if (customerId === null) {
    return res.status(400).json({ error: "This order has no customer to bill" });
  }

  // Which of these get made to order, and how many passes this order grants in
  // total (usually zero — only pass packs have any).
  //
  // `isKitchen` has always meant "this prints a ticket", not "this goes to the
  // kitchen" — that reading only ever worked because there was one board. It
  // still answers WHETHER; `station` below answers WHERE.
  const kitchenItems = items.filter((i: { isKitchen?: boolean }) => i.isKitchen);
  const passCredits = items.reduce(
    (sum: number, i: { visitCredits?: number }) => sum + (Number(i.visitCredits) || 0),
    0
  );

  // Everything below happens as one all-or-nothing step. This form of
  // transaction takes a function, which allows the branching below — the
  // simpler list form used elsewhere can't make decisions mid-way.
  const updatedCustomer = await prisma.$transaction(async (tx) => {
    // 1. Put every item on the tab. Note the name, price and tax rate are
    //    COPIED as plain values rather than linked to the menu item — that's
    //    what makes an old receipt still correct after a price change.
    for (const it of items) {
      await tx.billLineItem.create({
        data: {
          billId,
          description: it.name,
          amount: it.amount,
          taxRate: Number(it.taxRate) || 0,
          visitCreditsGranted: Number(it.visitCredits) || 0,
        },
      });
    }

    // 2. Send the food to the kitchen and the drinks to the bar. TWO SEPARATE
    //    TICKETS, always — neither board ever shows the other's items, which is
    //    why this is a loop over boards rather than one card with a mixed list.
    //    A burger and an orange juice make two cards, and the guest gets each
    //    as it's ready instead of the drink going warm waiting for the grill.
    for (const station of ["KITCHEN", "BAR"] as const) {
      // Anything the browser didn't label, or labelled with something we don't
      // recognise, counts as kitchen. See stationFor above for why that
      // direction and not the other.
      const forStation = kitchenItems.filter(
        (i: { station?: string }) => (i.station === "BAR" ? "BAR" : "KITCHEN") === station
      );
      if (forStation.length === 0) continue;
      // Joins the guest's un-started ticket only if it's going to the SAME
      // place, on the SAME board. A second round for a different table starts
      // its own card — otherwise the cook would hold one ticket naming two
      // destinations and have to guess which half goes where.
      //
      // `station` in here is not optional. Leave it out and the first round of
      // drinks joins the QUEUED food card and lands on the cook's board —
      // silently, and only for guests who ordered food first.
      let order = await tx.order.findFirst({
        where: { visitId, status: "QUEUED", tableId, station },
      });
      if (!order) {
        order = await tx.order.create({ data: { visitId, tableId, station } });
      }
      for (const it of forStation) {
        await tx.orderItem.create({
          data: { orderId: order.id, name: it.name, note: it.note || null },
        });
      }
    }

    // Somebody is sitting there, so the board should say so. Deliberately
    // OUTSIDE the loop above: it has to happen once, not once per board, and it
    // has to happen for a round of drinks with no food in it — a guest at table
    // 4 with a beer is a guest at table 4. Only nudges a free table; an
    // occupied one is already right, and this never touches one that's out of
    // service because that was refused above.
    if (kitchenItems.length > 0 && table && table.status === "AVAILABLE") {
      await tx.table.update({
        where: { id: table.id },
        data: { status: "OCCUPIED", occupiedSince: new Date() },
      });
    }

    // 3. Credit any passes bought. This one IS immediate, unlike spending a
    //    pass, which waits until check-out — so a guest can buy a 10-pack and
    //    have their next entry come off it straight away.
    if (passCredits > 0) {
      return tx.customer.update({
        where: { id: customerId },
        data: { visitPassBalance: { increment: passCredits } },
      });
    }
    return null;
  });

  // Tell everyone what changed — only what actually did.
  io.emit("bill:line-item-added", { billId });
  if (kitchenItems.length > 0) io.emit("orders:changed", {});
  if (updatedCustomer) io.emit("customer:updated", updatedCustomer);
  res.status(201).json({ ok: true });
});

// Remove a confirmed line item from an UNPAID bill — admin only.
//
// The "void one" button on the Checkout screen. It removes ONE charge, and has
// to clean up after it: if that item was already with the kitchen, the ticket
// needs to know too.
//
// Three refusals, all deliberate:
//   - already paid      → that's a refund, not a void
//   - the entry charge  → swap the admission type instead
//   - a spent pass pack → the passes are already gone; can't unsell them
app.delete("/bills/:billId/line-items/:lineItemId", requireAdmin, async (req, res) => {
  const billId = Number(req.params.billId);
  const lineItemId = Number(req.params.lineItemId);

  const lineItem = await prisma.billLineItem.findUnique({
    where: { id: lineItemId },
    include: { bill: { include: { visit: { include: { customer: true } } } } },
  });
  if (!lineItem || lineItem.billId !== billId) {
    return res.status(404).json({ error: "Line item not found" });
  }
  if (lineItem.bill.paidAt) {
    return res.status(400).json({ error: "This bill is already paid — use a refund instead" });
  }
  if (lineItem.isAdmission) {
    return res.status(400).json({ error: "Swap the admission type instead of removing it" });
  }
  const customer = lineItem.bill.visit.customer;
  // A takeout bill is paid the instant it's created, so the "already paid"
  // refusal a few lines up turns it away before this point. The guard is here
  // because `customer` can now be empty in principle, and every line below this
  // is pass arithmetic that means nothing without somebody to do it to.
  if (!customer) {
    return res.status(400).json({ error: "This charge is on a takeout order — refund the whole bill instead" });
  }
  if (lineItem.visitCreditsGranted > 0 && customer.visitPassBalance < lineItem.visitCreditsGranted) {
    return res.status(409).json({
      error: "Some of those visit passes have already been used, so this sale can't be removed cleanly",
    });
  }

  const visitId = lineItem.bill.visitId;
  let removedKitchenItem = false;

  const updatedCustomer = await prisma.$transaction(async (tx) => {
    await tx.billLineItem.delete({ where: { id: lineItemId } });

    // Kitchen cleanup, matched to where the food is. Still QUEUED (nobody's
    // started it): the item silently disappears from the card. Already
    // IN_PROGRESS or READY: it's flagged CANCELED instead — the kitchen sees
    // the cancellation on the card and dismisses it themselves.
    const openKitchenOrders = await tx.order.findMany({
      where: { visitId, status: { not: "COMPLETE" } },
      include: { items: true },
      orderBy: { createdAt: "asc" },
    });
    for (const order of openKitchenOrders) {
      // Charges and ticket items are matched BY NAME — there's no id linking a
      // bill line to the thing being made. So voiding one of two identical teas
      // removes whichever is found first, which is fine because they're
      // indistinguishable anyway.
      //
      // This sweeps BOTH boards, which is what makes it still correct now that
      // a visit can hold a kitchen ticket and a bar ticket at once: a menu item
      // sits in exactly one category, a category has exactly one station, so a
      // given name only ever appears on one board and the loop simply skips the
      // other card. The one way to break that is two menu items with the SAME
      // NAME in categories that go to different boards — item names aren't
      // required to be unique, only category names are. There are no duplicate
      // names in the menu today; if you ever add a "Water" to both the food and
      // the drinks sections, voiding one could cancel the other.
      const match = order.items.find((i) => i.name === lineItem.description && !i.canceled);
      if (!match) continue;
      if (order.status === "QUEUED") {
        await tx.orderItem.delete({ where: { id: match.id } });
        // That was the ticket's only item, so the empty card goes too.
        if (order.items.length === 1) {
          await tx.order.delete({ where: { id: order.id } });
        }
      } else {
        await tx.orderItem.update({ where: { id: match.id }, data: { canceled: true } });
      }
      removedKitchenItem = true;
      break; // one bill line = one kitchen item
    }

    // Voiding a pass pack takes those passes back off the balance. The check
    // further up already refused if any had been used.
    if (lineItem.visitCreditsGranted > 0) {
      return tx.customer.update({
        where: { id: customer.id },
        data: { visitPassBalance: { decrement: lineItem.visitCreditsGranted } },
      });
    }
    return null;
  });

  io.emit("bill:line-item-added", { billId }); // same "this bill changed" signal the app already refreshes on
  if (removedKitchenItem) io.emit("orders:changed", {});
  if (updatedCustomer) io.emit("customer:updated", updatedCustomer);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CHANGE WHAT ONE CHARGE COSTS on an unpaid bill — admin only.
//
// The "Price" button next to a row on the Checkout screen. A drink on the
// house, something knocked down for a regular — the sort of thing that happens
// once and doesn't deserve a whole discount item set up in advance.
//
// ⚠️ THIS IS THE ONE PLACE A CHARGE'S PRICE CHANGES AFTER IT WAS RUNG UP.
//    Everywhere else in this app a charge is written once and never touched:
//    the name, price and tax rate are COPIED from the menu at the moment of
//    sale precisely so that editing the menu can never rewrite an old receipt.
//    This endpoint puts a deliberate hole in that. Everything below is about
//    keeping the hole small.
//
// requireAdmin for the same reason voiding has it: a staff member deciding on
// their own to make things free is exactly what it guards against. The label
// the browser sends to the approval prompt names the item and both prices, so
// the log says what was actually given away.
//
// It UPDATES the row rather than deleting and re-creating it, and that matters
// in three ways that are easy to miss:
//   - the kitchen is left alone. Voiding cancels the matching ticket item; a
//     comped drink is still being made, it just costs nothing now.
//   - `visitCreditsGranted` survives, so comping a pass pack doesn't silently
//     strip the passes it granted (the guest keeps them — see below).
//   - the id and createdAt survive, so the charge stays where it was on the
//     receipt, which is ordered by createdAt.
// ---------------------------------------------------------------------------
app.put("/bills/:billId/line-items/:lineItemId/price", requireAdmin, async (req, res) => {
  const billId = Number(req.params.billId);
  const lineItemId = Number(req.params.lineItemId);
  const { amount } = req.body;

  // The browser picks this number, unlike the discount endpoint where the
  // server works it out. That's unavoidable for a free-form price — so the
  // guard is that a manager approved a prompt naming this exact figure.
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: "A price has to be a number, and can't be less than zero" });
  }
  // Money is whole cents. A price arriving as 19.1023 — a slip of the finger,
  // or a browser that skipped its own rounding — would otherwise be stored
  // exactly as sent, print as $19.10 on every screen because they all format
  // to two places, and leave the tax and the total wrong by a fraction of a
  // cent that nobody can see, reconcile, or explain.
  const cents = Math.round(amount * 100) / 100;

  const lineItem = await prisma.billLineItem.findUnique({
    where: { id: lineItemId },
    include: { bill: true },
  });
  if (!lineItem || lineItem.billId !== billId) {
    return res.status(404).json({ error: "Line item not found" });
  }
  // The same rule that stops a charge being voided after payment, and it
  // matters more here than it looks. No bill stores its own total — every
  // figure on the Reports screen, the cash/card split, a customer's lifetime
  // spend and even the amount of a refund given weeks ago are all added up
  // from these rows on demand. Editing a paid bill would quietly rewrite
  // numbers a manager has already counted and written down.
  if (lineItem.bill.paidAt) {
    return res.status(400).json({ error: "This bill is already paid — use a refund instead" });
  }
  // The entry charge is changed by picking a different admission type at the
  // till, not here. Two reasons: re-tapping an admission tile deletes the
  // entry line and rebuilds it at the menu price, which would wipe an
  // adjustment without saying so; and the cash discount decides whether it
  // applies by comparing this exact figure against the house minimum.
  if (lineItem.isAdmission) {
    return res.status(400).json({ error: "Change the entry charge by picking a different admission type" });
  }

  // WHAT IT USED TO COST, remembered once. Adjusting the same charge again
  // keeps the first figure rather than the most recent one, so $6 → $3 → $1
  // still says it started at $6.
  //
  // And put back exactly, it forgets: setting a comped drink back to $6.00
  // clears the note entirely rather than leaving "was $6.00" on a charge that
  // now costs $6.00.
  const wasEverAdjusted = lineItem.originalAmount !== null;
  const trueOriginal = wasEverAdjusted ? lineItem.originalAmount : lineItem.amount;
  const backToNormal = cents === trueOriginal;

  const updated = await prisma.billLineItem.update({
    where: { id: lineItemId },
    data: {
      amount: cents,
      originalAmount: backToNormal ? null : trueOriginal,
    },
  });

  // Same shout every other charge makes. Nothing else needs telling: the food
  // is unaffected, and no passes changed hands.
  io.emit("bill:line-item-added", { billId });
  res.json(updated);
});

// Refund a PAID bill in full — admin only. Stamps it; never deletes.
//
// That's the important part: a refunded bill keeps every charge and gains a
// date and a reason. Nothing is erased, so a reprinted receipt still shows
// exactly what was sold and that the money went back. There's no partial
// refund — it's the whole bill or nothing.
app.post("/bills/:id/refund", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = req.body;

  const bill = await prisma.bill.findUnique({ where: { id } });
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  if (!bill.paidAt) {
    return res.status(400).json({ error: "This bill isn't paid yet — remove line items instead" });
  }
  // Already stamped — refuse rather than refunding twice. This is what makes
  // a double-click on the Reports screen harmless.
  if (bill.refundedAt) {
    return res.status(409).json({ error: "This bill was already refunded" });
  }

  const updated = await prisma.bill.update({
    where: { id },
    data: { refundedAt: new Date(), refundReason: reason || null },
  });
  io.emit("bill:refunded", updated);
  res.json(updated);
});

// ---------------------------------------------------------------------------
// ---- Reports & receipts ----
// The books, and the data behind a printed receipt.
// ---------------------------------------------------------------------------

// THE DAILY REPORT. ADMIN ONLY. The single biggest handler in the file, and
// the one place all the money arithmetic happens — client/src/Reports.tsx only
// displays what this works out.
//
// Answers one question: what came in on this day? Or with scope=all, ever.
// Everything is computed fresh on each request; nothing is cached or stored.
app.get("/reports/daily", requireAdmin, async (req, res) => {
  const allHistory = String(req.query.scope ?? "day") === "all";

  // Expect ?date=YYYY-MM-DD; default to today. Parsed by hand into local
  // year/month/day — new Date("2026-07-29") would read it as UTC midnight,
  // which shifts the day boundary by your timezone offset.
  const dateStr = String(req.query.date ?? "");
  let y: number, m: number, d: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    [y, m, d] = dateStr.split("-").map(Number);
  } else {
    const now = new Date();
    y = now.getFullYear();
    m = now.getMonth() + 1;
    d = now.getDate();
  }
  // The trading day runs from midnight to midnight. Asking for "day 32" is
  // fine — the date is worked out from the number, so it becomes the 1st of
  // the next month, and December rolls into January the same way. Months are
  // counted from 0 here, which is why it's `m - 1`.
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 1); // JS rolls month/year over automatically

  // In all-history mode the window is simply "has been paid at all".
  const paidWindow = allHistory ? { not: null } : { gte: start, lt: end };
  const refundWindow = allHistory ? { not: null } : { gte: start, lt: end };

  const paidBills = await prisma.bill.findMany({
    where: { paidAt: paidWindow },
    include: {
      lineItems: true,
      // passUsedCustomer so the report can name who sponsored an entry — the
      // audit trail if a customer ever queries their balance.
      visit: { include: { customer: true, locker: true, passUsedCustomer: true } },
    },
    orderBy: { paidAt: "desc" },
  });

  // Running totals, filled in by the loop below as it walks each bill.
  const byMethod: Record<string, number> = {};
  let subtotalAll = 0;
  let taxAll = 0;
  let totalAll = 0;
  let passesRedeemed = 0;

  // Add up each bill and, along the way, accumulate the day's figures. Note
  // tax is calculated per charge using its own frozen rate, so a day mixing
  // 13%, 5% and 0% items comes out right.
  const bills = paidBills.map((b) => {
    const subtotal = b.lineItems.reduce((sum, li) => sum + li.amount, 0);
    const tax = b.lineItems.reduce((sum, li) => sum + li.amount * li.taxRate, 0);
    const total = subtotal + tax;
    const method = b.paymentMethod ?? "UNKNOWN";
    byMethod[method] = (byMethod[method] ?? 0) + total;
    subtotalAll += subtotal;
    taxAll += tax;
    totalAll += total;
    if (b.visit.redeemsPass) passesRedeemed++;
    return {
      id: b.id,
      paidAt: b.paidAt,
      paymentMethod: method,
      subtotal,
      tax,
      total,
      // Takeout has no guest and no locker, so the two columns say what it was
      // instead. Reports.tsx displays these as plain text and never asks where
      // they came from, which is why that screen needs no changes at all.
      customer: b.visit.customer
        ? `${b.visit.customer.firstName} ${b.visit.customer.lastName}`
        : b.visit.takeoutName || "Takeout",
      locker: b.visit.locker ? b.visit.locker.number : `#${b.visit.takeoutNumber ?? "?"}`,
      redeemsPass: b.visit.redeemsPass,
      // Null unless someone else's balance paid for this entry. Named rather
      // than flagged, so a disputed balance can be traced to a person.
      passSponsor: b.visit.passUsedCustomer
        ? `${b.visit.passUsedCustomer.firstName} ${b.visit.passUsedCustomer.lastName}`
        : null,
      refunded: Boolean(b.refundedAt),
    };
  });

  // Best sellers — every charge is one unit, so counting line items counts
  // quantity. A refunded bill didn't really sell anything, so it's left out.
  const sellers = new Map<string, { name: string; qty: number; revenue: number }>();
  for (const b of paidBills) {
    if (b.refundedAt) continue;
    for (const li of b.lineItems) {
      // Skip discounts. A negative charge is the only way one is written, and
      // "best sellers" should list what was sold, not what was given away. The
      // day's total, net and tax all still include it — the money is right,
      // it just isn't a seller.
      if (li.amount < 0) continue;
      const row = sellers.get(li.description) ?? { name: li.description, qty: 0, revenue: 0 };
      row.qty += 1;
      row.revenue += li.amount;
      sellers.set(li.description, row);
    }
  }
  const topItems = Array.from(sellers.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8);

  // Refunds are bucketed by the day they were GIVEN (refundedAt), not the day
  // the bill was paid — yesterday's drawer count shouldn't change retroactively.
  const refundedBills = await prisma.bill.findMany({
    where: { refundedAt: refundWindow },
    include: { lineItems: true },
  });
  const refundsGiven = refundedBills.reduce((sum, b) => {
    return sum + b.lineItems.reduce((s, li) => s + li.amount * (1 + li.taxRate), 0);
  }, 0);

  // Most frequent visitors — always all-time, whatever date is selected.
  //
  // Worth knowing this is the expensive part of the report: it loads EVERY
  // customer with EVERY completed visit and EVERY charge, just to rank the top
  // eight. Fine at this size, but it's the first thing that would need
  // rethinking if the guest book grew large.
  const customers = await prisma.customer.findMany({
    include: {
      visits: {
        where: { checkOutAt: { not: null } },
        include: { bill: { include: { lineItems: true } } },
      },
    },
  });
  const frequentVisitors = customers
    .map((c) => {
      const spend = c.visits.reduce((sum, v) => {
        if (!v.bill || !v.bill.paidAt || v.bill.refundedAt) return sum;
        return sum + v.bill.lineItems.reduce((s, li) => s + li.amount * (1 + li.taxRate), 0);
      }, 0);
      return {
        id: c.id,
        name: `${c.firstName} ${c.lastName}`,
        visits: c.visits.length,
        spend,
      };
    })
    .filter((v) => v.visits > 0)
    .sort((a, b) => b.visits - a.visits || b.spend - a.spend)
    .slice(0, 8);

  res.json({
    scope: allHistory ? "all" : "day",
    date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    billCount: bills.length,
    passesRedeemed,
    subtotal: subtotalAll,
    tax: taxAll,
    // `total` includes refunded bills — they were still sales that happened.
    total: totalAll,
    byMethod,
    refundCount: refundedBills.length,
    refundsGiven,
    // `net` is the figure that actually matters: what was kept.
    net: totalAll - refundsGiven,
    topItems,
    frequentVisitors,
    // Only the 200 most recent bills are listed, to keep the response sane on
    // an all-history request. `truncated` tells the screen to say so — the
    // totals above still cover everything.
    bills: bills.slice(0, 200),
    truncated: bills.length > 200,
  });
});

// One bill with everything a receipt needs
// Used by client/src/Receipt.tsx (the printable page) and by the receipt
// overlay on the Reports screen. Not admin-only — staff print receipts.
app.get("/bills/:id", async (req, res) => {
  const id = Number(req.params.id);
  const bill = await prisma.bill.findUnique({
    where: { id },
    include: {
      lineItems: { orderBy: { createdAt: "asc" } },
      // passUsedCustomer so the receipt can name who sponsored the entry.
      visit: { include: { customer: true, locker: true, passUsedCustomer: true } },
    },
  });
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  res.json(bill);
});

// ---------------------------------------------------------------------------
// ---- Kitchen and bar ----
// The ticket boards, served to client/src/StationBoard.tsx — which draws the
// Kitchen screen and the Bar screen from the same code, told apart only by
// which station it asks for. Not admin-only; the cooks and the bar need it.
// Note there's no endpoint here for CREATING an order: tickets are born from
// /visits/:id/confirm-order above, so anything either board makes has always
// been charged for.
// ---------------------------------------------------------------------------

// Everything a board still owes, oldest first — so it reads as a queue.
// Completed orders are simply not sent, which is how a card disappears when a
// cook taps "Mark Picked Up".
//
// ?station=BAR narrows it to one board. Left off, it's every open ticket in the
// building, which is what the Home dashboard wants: it draws a row of counts
// per board AND the takeout list from this one request.
//
// An unrecognised station is REFUSED rather than ignored. Quietly falling back
// to "everything" on a typo'd ?station=BARR is how a bar screen ends up showing
// the cook's food, and how nobody finds out for a week.
app.get("/orders/open", async (req, res) => {
  const asked = req.query.station;
  const station = asked === "KITCHEN" || asked === "BAR" ? asked : undefined;
  if (asked !== undefined && station === undefined) {
    return res.status(400).json({ error: "Unknown station — expected KITCHEN or BAR" });
  }
  const orders = await prisma.order.findMany({
    where: { status: { not: "COMPLETE" }, ...(station ? { station } : {}) },
    // `table` so staff know where to run it — see ticketTag in StationBoard.tsx.
    include: { items: true, table: true, visit: { include: { customer: true, locker: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json(orders);
});

// Move a ticket along: QUEUED → IN_PROGRESS → READY → COMPLETE.
app.post("/orders/:id/status", async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body;
  // Only these four words are accepted. Without this check a typo or a
  // tampered request could put a ticket into a state nothing recognises,
  // leaving it stuck on the board forever.
  if (!["QUEUED", "IN_PROGRESS", "READY", "COMPLETE"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const order = await prisma.order.update({ where: { id }, data: { status } });
  io.emit("orders:changed", {});
  res.json(order);
});

// Dismiss a CANCELED item from a kitchen card (any signed-in terminal)
//
// The other half of the void flow: an admin pulls a charge, the item is
// flagged cancelled so the cook stops making it, and this is the cook
// acknowledging that and clearing it. Only cancelled items can be removed, so
// this can't be used to make a real order vanish.
app.delete("/order-items/:id", async (req, res) => {
  const id = Number(req.params.id);
  const item = await prisma.orderItem.findUnique({
    where: { id },
    include: { order: { include: { items: true } } },
  });
  if (!item) return res.status(404).json({ error: "Order item not found" });
  if (!item.canceled) {
    return res.status(400).json({ error: "Only canceled items can be dismissed from the kitchen" });
  }
  await prisma.orderItem.delete({ where: { id } });
  // That was the ticket's last item, so bin the empty card too. (The count is
  // from before the delete above, hence 1 rather than 0.)
  if (item.order.items.length === 1) {
    await prisma.order.delete({ where: { id: item.orderId } });
  }
  io.emit("orders:changed", {});
  res.json({ ok: true });
});

// ===========================================================================
// ---- Check-out ----
//
// THE END OF A VISIT, and the counterpart to /check-in above. Called from
// client/src/Checkout.tsx when staff press "Complete Checkout".
//
// One request does five things at once: end the visit, free the locker, stamp
// the bill paid, close any kitchen tickets still hanging around, and spend a
// pass if the stay was on one. All inside a transaction — a half-finished
// checkout would leave a locker held by someone who has already gone home.
//
// (It sits under the Kitchen banner in the original file, but it isn't a
// kitchen route.)
// ===========================================================================
app.post("/check-out", async (req, res) => {
  const { visitId, paymentMethod } = req.body;
  if (!paymentMethod) {
    return res.status(400).json({ error: "paymentMethod is required to check out" });
  }
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, include: { customer: true } });
  if (!visit || visit.checkOutAt) {
    return res.status(404).json({ error: "Active visit not found" });
  }

  // A takeout order was paid at the counter and closed on the spot: no locker
  // to hand back, nobody to sign out. Destructuring first, then checking, is
  // what convinces TypeScript these are real numbers inside the transaction
  // below — checking `visit.lockerId` directly wouldn't survive the closure.
  const { lockerId, customerId } = visit;
  if (visit.kind === "TAKEOUT" || lockerId === null || customerId === null || !visit.customer) {
    return res.status(400).json({
      error: "Takeout orders are paid at the counter — there's nothing to check out",
    });
  }

  // This stay was set up to be paid with a pass, but the balance has since hit
  // zero — most likely the pack they bought was voided. Refuse rather than
  // letting them leave without paying anything.
  // WHOSE pass is being spent. A sponsored visit takes it from whoever was
  // named at check-in; everything else takes it from the guest.
  const passPayerId = visit.passUsedCustomerId ?? customerId;
  if (visit.redeemsPass) {
    const payer = visit.passUsedCustomerId
      ? await prisma.customer.findUnique({ where: { id: visit.passUsedCustomerId } })
      : visit.customer;
    if (!payer || payer.visitPassBalance < 1) {
      const who = payer ? `${payer.firstName} ${payer.lastName}` : "the sponsor";
      return res.status(409).json({
        error: `This visit is set to use a pass, but ${who} has none remaining. Change their admission type.`,
      });
    }
  }

  // The cash discount is per-location, so the location carries the numbers the
  // discount rule reads at checkout below.
  const location = await currentLocation(req);

  const { updatedVisit, updatedLocker, updatedBill, updatedCustomer } = await prisma.$transaction(async (tx) => {
    // 1. End the visit. Stamping the time is what makes it stop being "active"
    //    and drop off every screen showing who's in the building.
    const updatedVisit = await tx.visit.update({
      where: { id: visitId },
      data: { checkOutAt: new Date() },
    });
    // 2. Put the locker back in the pool for the next guest.
    const updatedLocker = await tx.locker.update({
      where: { id: lockerId },
      data: { status: "AVAILABLE" },
    });

    // 2b. THE CASH DISCOUNT. This is the moment — and the only moment — that
    //     anything knows the guest is paying cash, so it's where the money
    //     comes off. See cashDiscountFor for the rule itself.
    //
    //     The tab is re-read HERE, inside the transaction, rather than trusted
    //     from earlier in the request. Bills change under an open Checkout
    //     screen all the time: the kitchen adds a drink, another terminal swaps
    //     the entry charge. What the discount is judged against has to be the
    //     tab as it stands at the instant of payment.
    //
    //     No "have we already done this?" check is needed. Checking out is
    //     refused on a visit that's already checked out, so this runs once.
    if (paymentMethod === "CASH") {
      const bill = await tx.bill.findUnique({
        where: { visitId },
        include: { lineItems: true },
      });
      const discount = bill ? cashDiscountFor(bill.lineItems, location) : null;
      if (bill && discount) {
        await tx.billLineItem.create({
          data: {
            billId: bill.id,
            description: discount.description,
            amount: discount.amount,
            taxRate: discount.taxRate,
            // NOT the entry charge, even though it's the entry charge this
            // comes off. Marking it as one would put two admissions on the
            // bill, and an admission swap deletes by that flag.
            isAdmission: false,
          },
        });
      }
    }

    // 3. Close the bill. From here it's read-only: charges can no longer be
    //    voided, and undoing it means a refund instead.
    const updatedBill = await tx.bill.update({
      where: { visitId },
      data: { paymentMethod, paidAt: new Date() },
      // The charges come back with it so the screen that just took the money
      // can show what was actually recorded, rather than the total it had
      // worked out before sending. Those two used to be the same thing; with a
      // discount applied here they aren't.
      include: { lineItems: true },
    });

    // 4. Clear any of this visit's unfinished kitchen orders off the kitchen screen
    //    — the guest has gone, so an uncollected drink is never coming back
    //    for. Without this the board would slowly fill with dead tickets.
    await tx.order.updateMany({
      where: { visitId, status: { not: "COMPLETE" } },
      data: { status: "COMPLETE" },
    });

    // 4b. Free any lounge table this guest was eating at. Their tickets are all
    //     closed by the line above, so the only thing that can still hold a
    //     table is SOMEBODY ELSE — two friends on separate tabs sharing one
    //     table is ordinary here, and the first to leave must not clear it out
    //     from under the second.
    const wasSeatedAt = await tx.order.findMany({
      where: { visitId, tableId: { not: null } },
      select: { tableId: true },
      distinct: ["tableId"],
    });
    for (const { tableId: usedTableId } of wasSeatedAt) {
      if (usedTableId === null) continue;
      const stillInUse = await tx.order.count({
        where: {
          tableId: usedTableId,
          status: { not: "COMPLETE" },
          visit: { checkOutAt: null },
        },
      });
      if (stillInUse === 0) {
        await tx.table.updateMany({
          // updateMany with the status in the WHERE so a table somebody has
          // since flagged out of service isn't quietly returned to the pool.
          where: { id: usedTableId, status: "OCCUPIED" },
          data: { status: "AVAILABLE", occupiedSince: null },
        });
      }
    }

    // 5. Spend one visit pass, if this visit was checked in on one
    //    THIS is where a pass is finally deducted — not at check-in. Buying
    //    passes credits immediately, but spending one waits until now.
    //    Sponsored visits take it from the sponsor, not the guest. Exactly one
    //    per visit — two friends on one sponsor check out separately and take
    //    one each, never one deduction covering both. `decrement` is applied by
    //    the database itself, so two simultaneous check-outs can't both read
    //    the same starting figure.
    const updatedCustomer = visit.redeemsPass
      ? await tx.customer.update({
          where: { id: passPayerId },
          data: { visitPassBalance: { decrement: 1 } },
        })
      : null;

    return { updatedVisit, updatedLocker, updatedBill, updatedCustomer };
  });

  // Announce all of it. Within a second the dashboard's headcount drops, the
  // locker dial gains one, and the guest disappears from the till's grid on
  // every terminal in the building.
  io.emit("visit:checked-out", updatedVisit);
  io.emit("locker:updated", updatedLocker);
  io.emit("bill:paid", updatedBill);
  io.emit("orders:changed", {});
  if (updatedCustomer) io.emit("customer:updated", updatedCustomer);
  res.json({ visit: updatedVisit, bill: updatedBill });
});

// ---------------------------------------------------------------------------
// ---- Takeout ----
//
// A counter sale to somebody who isn't staying. No locker, no profile, no entry
// charge — just food, paid for on the spot.
//
// THE WHOLE SALE IS ONE REQUEST, which is the difference between this and every
// other way something gets sold here. A staying guest builds a tab over hours
// and settles at the end; a takeout customer is standing at the counter with
// their wallet out. So this opens the visit, writes the charges, marks the bill
// paid and sends the ticket to the kitchen in one transaction.
//
// Paying FIRST is the point. The kitchen never starts cooking for somebody who
// might walk off, and there's no such thing as an abandoned takeout tab to
// clean up at close.
//
// Called from client/src/PointOfSale.tsx.
// ---------------------------------------------------------------------------
app.post("/takeout", async (req, res) => {
  const { items, paymentMethod, name } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Nothing to sell" });
  }
  for (const it of items) {
    if (!it || !it.name || typeof it.amount !== "number") {
      return res.status(400).json({ error: "Each item needs a name and an amount" });
    }
    // A pass pack ADDS passes to a customer's balance, and a takeout order has
    // no customer to add them to. Without this the passes would simply
    // evaporate — sold, paid for, and credited to nobody.
    if (Number(it.visitCredits) > 0) {
      return res.status(400).json({
        error: `"${it.name}" sells visit passes, which need a customer profile — it can't go on a takeout order`,
      });
    }
  }
  // Only the two methods the buttons offer. The enum also allows GIFT_CARD and
  // VISIT_PASS, and neither makes sense standing at a counter with no profile.
  if (paymentMethod !== "CASH" && paymentMethod !== "CARD") {
    return res.status(400).json({ error: "Takeout must be paid by cash or card" });
  }

  const settings = await getSettings();

  // Ticket numbers restart every morning, so "order 4" means today's fourth.
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { visit, bill, sentToKitchen } = await prisma.$transaction(async (tx) => {
    // The highest number handed out today, plus one.
    const last = await tx.visit.findFirst({
      where: { kind: "TAKEOUT", checkInAt: { gte: startOfDay } },
      orderBy: { takeoutNumber: "desc" },
      select: { takeoutNumber: true },
    });
    const takeoutNumber = (last?.takeoutNumber ?? 0) + 1;

    // 1. Open the visit and close it in the same breath. `checkOutAt` being set
    //    from the start is what keeps this off /visits/active — and therefore
    //    off the dashboard headcount, the till's guest grid and the locker
    //    dials, none of which needed a single line changed for this feature.
    const visit = await tx.visit.create({
      data: {
        kind: "TAKEOUT",
        takeoutNumber,
        takeoutName: typeof name === "string" && name.trim() ? name.trim() : null,
        checkOutAt: new Date(),
      },
    });

    // 2. The bill, born already settled.
    const bill = await tx.bill.create({
      data: {
        visitId: visit.id,
        taxRate: settings.taxRate,
        paymentMethod,
        paidAt: new Date(),
      },
    });

    // 3. Every charge, one row per unit — same as everywhere else in this app.
    //    Note `taxRate` is copied off the item exactly as it is for a staying
    //    guest: a takeout coffee is taxed at the coffee's rate, full stop.
    for (const it of items) {
      await tx.billLineItem.create({
        data: {
          billId: bill.id,
          description: it.name,
          amount: it.amount,
          taxRate: Number(it.taxRate) || 0,
        },
      });
    }

    // 4. Send the food and the drinks. Unlike confirm-order there's no hunting
    //    for an existing QUEUED ticket to join — this visit is one second old
    //    and has never had an order before, so each board gets at most one
    //    brand-new card. A takeout burger and coffee still make two: the cook
    //    and the bar work in parallel, and the counter calls the number once
    //    both are up.
    const kitchenItems = items.filter((i: { isKitchen?: boolean }) => i.isKitchen);
    for (const station of ["KITCHEN", "BAR"] as const) {
      const forStation = kitchenItems.filter(
        (i: { station?: string }) => (i.station === "BAR" ? "BAR" : "KITCHEN") === station
      );
      if (forStation.length === 0) continue;
      const order = await tx.order.create({ data: { visitId: visit.id, station } });
      for (const it of forStation) {
        await tx.orderItem.create({
          data: { orderId: order.id, name: it.name, note: it.note || null },
        });
      }
    }

    return { visit, bill, sentToKitchen: kitchenItems.length > 0 };
  });

  // A takeout order of nothing but a bottle of water makes no ticket, so
  // there's nothing for the kitchen or the dashboard to hear about.
  if (sentToKitchen) io.emit("orders:changed", {});
  io.emit("bill:paid", bill);
  res.status(201).json({ visit, bill });
});

// ---------------------------------------------------------------------------
// Live connections.
//
// This is the entire client→server socket handling: a log line. Terminals only
// LISTEN — they never send anything down the socket, and every change they
// want to make goes through the ordinary endpoints above. The socket is one
// direction only: the server shouting "something changed" to everyone.
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
  console.log("A terminal connected:", socket.id);
});

// Start listening. 4000 is what client/.env.development points the client at
// while you work, so changing it here means changing it there too. In
// production nothing needs to know the number: the client is served by this
// same server, so the browser uses whatever address the page came from.
const port = process.env.PORT || 4000;
httpServer.listen(port, () => console.log(`Server running on http://localhost:${port}`));