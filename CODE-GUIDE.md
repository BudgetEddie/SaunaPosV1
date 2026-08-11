# Code Guide — how this app is built

This is a plain-English companion to the code. It explains the *tools and vocabulary* once, so
the comments in the actual files can get on with explaining *this bathhouse's rules* instead of
re-teaching what a "component" is every time.

You don't need to read this front to back. Skim part 1, read part 2 once, and use parts 3–5 as
a reference when a comment sends you here.

---

## 1. The three pieces

Banya #3's till isn't one program — it's three, talking to each other.

```
   ┌───────────────────┐        ┌───────────────────┐        ┌──────────────┐
   │   THE CLIENT      │  asks  │   THE SERVER      │ asks   │ THE DATABASE │
   │  (client/ folder) │ ─────► │ (server/ folder)  │ ─────► │  (Postgres)  │
   │                   │ ◄───── │                   │ ◄───── │              │
   │ Runs in the front │ answer │ Runs on the shop  │ answer │ Runs in      │
   │ desk's browser.   │        │ computer.         │        │ Docker.      │
   │ Everything you    │        │ Every rule about  │        │ The actual   │
   │ can see and tap.  │        │ money and lockers.│        │ saved facts. │
   └───────────────────┘        └───────────────────┘        └──────────────┘
```

**The client** is what staff look at — the buttons, the menu tiles, the bill. It's written in
React and lives in `client/src/`. It knows how things should *look*, and almost nothing about
the rules. It can't be trusted: anyone can open a browser's developer tools and fiddle with it.

**The server** is the referee. It's the single file `server/src/index.ts`, and it decides
everything that actually matters — is this locker free, is this person allowed to see the sales
report, what does this bill add up to. The client can only *ask*; the server decides.

**The database** is the filing cabinet: customers, visits, bills, lockers. It only stores things.
Its shape is described in `server/prisma/schema.prisma`.

**Why split them up?** Because there are several front-desk terminals and one truth. If each
terminal kept its own list of who's in which locker, they'd disagree within minutes. Instead
every terminal asks the same server, and the server is the only thing that writes to the
database.

---

## 2. How a tap becomes a saved fact

Worth reading once — this single trace explains the whole architecture. Here's what happens when
staff add a tea to a guest's tab.

**1. The tap.** Staff tap the "Green Tea" tile in `client/src/PointOfSale.tsx`. Nothing is sent
anywhere yet — the tea goes into the on-screen "cart", which exists only in that browser. Staff
can still change their mind.

**2. The send.** Staff tap "Add 1 item to tab". Now `PointOfSale.tsx` makes a **request**: a
message over the network to the server, saying *POST /visits/42/confirm-order* with the tea
attached. ("POST" means "here's something to record"; "GET" means "just tell me something".)

**3. The check.** The server (`server/src/index.ts`) receives it. First it checks the request
carries a valid **token** proving someone is signed in (see the glossary). Then it applies the
rules: which bill does visit 42 have, is this a kitchen item that needs a cooking ticket.

**4. The write.** The server tells Prisma to save two things: a charge on the bill, and an item
on a kitchen ticket. Prisma turns that into database language. The tea now exists as a fact.

**5. The broadcast.** Here's the part that makes it feel live. The server shouts a message to
*every* connected terminal at once — `"orders:changed"` — over a **WebSocket** (glossary again).

**6. The reaction.** The kitchen screen, `client/src/Kitchen.tsx`, is listening for exactly that
shout. On hearing it, it ignores the message's contents entirely and simply re-asks the server
"what are all the open orders?" A second later the tea appears on the kitchen board — on a
different computer, with nobody touching it.

That last step is the pattern used *everywhere* in this app, and it's worth stating plainly:

> **The socket message is a doorbell, not a delivery.** It never carries the new data. It just
> says "something changed" and the screen goes and fetches a fresh copy of everything.

It's not the most efficient design, but it's very hard to get wrong — no screen can drift out of
sync, because no screen ever tries to patch itself up. It just reloads.

---

## 3. Glossary

Terms in rough order of how often you'll hit them.

**Component** — a reusable piece of screen, written as a function that returns what it should
look like. `Checkout` is a component. So is the little `Chip` that draws a coloured pill. Each
file in `client/src/` that ends in `.tsx` is essentially one component.

**JSX** — the HTML-looking markup inside those functions. `<div>Hello</div>` in the middle of
JavaScript. It's not really HTML; it's a description of what to draw, which React turns into
real screen elements.

**Props** — the values you hand a component when you use it, like arguments to a recipe.
`<Checkout visit={someVisit} onBack={...} />` passes it two props. Props flow **downwards only**
— a parent tells a child what to show; a child can't reach up and change its parent. When a
child needs to tell its parent something, the parent passes down a *function* for the child to
call (that's what `onBack` and `onDone` are).

**State** (`useState`) — a component's memory. `const [query, setQuery] = useState("")` means
"remember a search box's contents, starting empty". You get the current value (`query`) and the
only legal way to change it (`setQuery`). **Changing state redraws the screen** — that's the
whole point, and it's why you never just assign to a variable and expect the display to update.

**Re-render / redraw** — React re-running a component's function to work out what the screen
should look like now. Happens automatically whenever state changes.

**`useEffect`** — "do something that isn't drawing." Fetching from the server, starting a timer,
subscribing to socket messages. The `[]` at the end means "just once, when this screen first
opens". Whatever you `return` from inside it is the tidy-up, which runs when the screen closes —
that's how the socket subscriptions get cancelled so they don't pile up.

**`useRef`** — a box that survives redraws but does *not* trigger one when changed. Used for
things the screen doesn't display: timer handles, or "which bill rows have I already seen".

**`useMemo`** — "work this out once and keep the answer" — for a calculation you don't want
repeated on every redraw.

**`fetch` / `async` / `await`** — `fetch` asks another computer for something. That takes time,
so it's *asynchronous*: the code doesn't freeze while waiting. `await` means "pause this
function here until the answer arrives", and any function using `await` must be marked `async`.
In this app you'll almost always see `authFetch` rather than raw `fetch` — same thing, with the
sign-in token attached automatically.

**Endpoint / route** — one thing the server can be asked, named by a method and a path, like
`POST /check-in` or `GET /lockers`. All 32 of them live in `server/src/index.ts`.

**Token (JWT)** — the wristband you get at sign-in. When staff log in, the server hands back a
long scrambled string. Every later request carries it, and the server checks it. It's *signed*,
so it can't be forged, but it's *not* secret-checked against the database on each use — which
means a token stays valid for its full 12 hours even if the account changes. The browser keeps
it in `localStorage`.

**`localStorage`** — a small notepad the browser keeps between visits, per site. This app stores
exactly two things in it: `token` (the wristband) and `user` (who's signed in). Signing out is
just erasing them.

**Prisma / ORM** — a translator between normal code and the database. Instead of writing database
language by hand, the server writes `prisma.customer.findMany(...)` and Prisma turns it into the
real query. The shapes it works with are defined in `schema.prisma`.

**Migration** — a recorded change to the database's shape ("add a `refundedAt` column"). They
live in `server/prisma/migrations/`, numbered by date, and running them in order rebuilds the
database from scratch. Never edit an old one — it has already run.

**Transaction** — "all of these changes, or none of them." Checking someone in means marking a
locker taken *and* creating a visit. If the second half failed on its own you'd have a locker
that's occupied by nobody. Wrapping both in a transaction makes that impossible.

**WebSocket / Socket.IO** — an open phone line between server and browser, as opposed to a
request which is a single letter. It lets the server speak first. That's how one terminal's
actions show up on another's screen. Socket.IO is the library that manages it.

**TypeScript / types** — JavaScript with labels on things. `price: number` means "this is a
number, not text". The labels are checked before the app runs and then thrown away, so they
cost nothing at runtime; they exist to catch typos and wrong assumptions early. Shared labels
live in `client/src/types.ts`.

---

## 4. Where everything lives

### The client — `client/src/`

| File | What it is |
|---|---|
| `main.tsx` | The starting pistol. Lists which URL shows which screen. |
| `Shell.tsx` | The frame around every screen: the dark sidebar, and the sign-in gate. |
| `Login.tsx` | The sign-in page, steam animation and all. |
| `authFetch.ts` | The one helper that talks to the server with the token attached. |
| `types.ts` | Shared descriptions of the data the server sends back. |
| `Home.tsx` | The dashboard — locker dials, who's in, kitchen counts. |
| `CustomerDirectory.tsx` | Search customers, edit them, check them in. |
| `PointOfSale.tsx` | The till: pick a guest, build an order, add it to their tab. |
| `Checkout.tsx` | Settle the tab and take payment. Lives inside Point of Sale. |
| `Kitchen.tsx` | The cooks' ticket board. |
| `Reports.tsx` | Sales figures and refunds. Admin only. |
| `MenuPage.tsx` | Edit the menu — categories, items, prices, photos. Admin only. |
| `Receipt.tsx` | A printable receipt, opened in its own tab. |
| `index.css` | The only stylesheet that's actually loaded. |
| `App.css` | **Unused.** Leftover starter file. Ignore it. |

### The server — `server/`

| File | What it is |
|---|---|
| `src/index.ts` | The entire backend. All 32 endpoints, the sign-in check, the live broadcasts. |
| `prisma/schema.prisma` | The database's shape — every table and field. |
| `prisma/seed.ts` | Sets up the 120 lockers. **Erases visits, bills and kitchen orders** — first-time setup only. Refuses to run once the database has any visits, unless given `--force-wipe`. |
| `prisma/seed-users.ts` | Creates the staff logins. Also how you reset a forgotten password. |
| `prisma/fix-menu.ts` | A one-time repair script that has already been run. Kept as history. |
| `prisma/migrations/` | The dated history of every database shape change. |

### Everything else

| File | What it is |
|---|---|
| `docker-compose.yml` | Starts the Postgres database in a container. |
| `client/vite.config.ts` | Build settings for the client. |
| `client/index.html` | The bare page React gets injected into. |
| `*/package.json` | Each half's dependency list and its `npm run` commands. |
| `*/tsconfig*.json` | TypeScript's strictness settings. |

---

## 5. Running it

Three things must be running at once, each in its own terminal window.

```bash
# 1. The database (from the project root)
docker compose up -d

# 2. The server — restarts itself whenever you save a file
cd server && npm run dev

# 3. The client
cd client && npm run dev
```

Then open the address the client prints, usually <http://localhost:5173>.

| What | Where |
|---|---|
| Client (what you look at) | http://localhost:5173 |
| Server (what it asks) | http://localhost:4000 |
| Database | localhost:5432 |

**First-time setup**, once the database is up:

```bash
cd server
npx prisma migrate deploy    # build the tables
npx ts-node prisma/seed.ts   # create the 120 lockers — WIPES visits, bills and kitchen orders
npx ts-node prisma/seed-users.ts   # create the staff logins
```

Edit the passwords at the top of `seed-users.ts` before running it. Re-running that one file is
also how you reset a password later — it's safe to run repeatedly, unlike `seed.ts`.

`seed.ts` protects itself: on a database that already has visits in it, it prints what it found
and refuses to do anything. That refusal is the expected outcome on any till that has been used,
and it's *not* a fault to work around — it means you're pointed at a database with real trading
history on it. If wiping really is what you want, on your own machine or a fresh install, say so
in as many words:

```bash
npx ts-node prisma/seed.ts --force-wipe
```

**If the server won't start**, check `server/.env` exists and has `DATABASE_URL` and
`JWT_SECRET`. It's deliberately kept out of version control, so it won't be there after a fresh
clone — the server prints a specific message and stops if `JWT_SECRET` is missing.

---

## 6. Two things worth knowing before you change anything

**Money is stored as ordinary decimal numbers, not whole cents.** `19.99` is stored as `19.99`.
This is simple to read but computers are famously imprecise with decimal fractions — adding
enough of them can produce `40.870000000000005`. It's never been a visible problem here because
every displayed figure is rounded to two places at the last moment, but it's the kind of thing
worth knowing before writing anything new that deals in totals.

**Tax is recorded per line, frozen at the moment of sale.** There's a house default rate, and
each menu item can override it, but what actually counts is the rate copied onto the charge when
it was rung up. That's deliberate: a receipt printed next year must show the tax that was charged
on the day, not today's rate. It also means one bill can legitimately mix 13%, 5% and 0% items,
so the "tax rate" shown on a receipt is worked backwards from the totals rather than looked up.
