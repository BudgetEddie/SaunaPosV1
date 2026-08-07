// ============================================================================
// THE DASHBOARD — the front page, at a glance.
//
// WHAT IT IS
//   Read-only. It changes nothing: it shows how many lockers are free in each
//   pool, who's currently in the building, how long they've been here, and
//   what the kitchen has on. Every button on it is a link somewhere else.
//
// WHERE IT'S USED
//   The "/" route in client/src/main.tsx. Nothing imports it.
//   It links out to /customers (Check In, New Customer), /pos and /kitchen.
//
// WHAT IT TALKS TO   (all in server/src/index.ts)
//   GET /visits/active  → who's in the building
//   GET /lockers        → the two capacity dials
//   GET /orders/open    → the kitchen counts
//   GET /login-roster   → the "on shift" avatars
// ============================================================================

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { io } from "socket.io-client";
import { authFetch, type LoggedInUser } from "./authFetch.ts";

// Open a live line to the server, so this screen finds out when something
// changes on another terminal. Note this sits OUTSIDE the component, at the
// top of the file, so the connection is made once when the app starts and
// stays open — not one per redraw.
const socket = io("http://localhost:4000");

// This screen describes its own slimmed-down shapes rather than importing the
// full ones from types.ts, because it only displays a handful of fields.
type Visit = {
  id: number;
  checkInAt: string;
  customer: { firstName: string; lastName: string; gender: string; notes: string | null };
  locker: { number: string };
};
type Locker = { id: number; gender: string; status: string };
// Home used to need nothing but the status, for the three kitchen counters. The
// takeout tab needs the ticket itself, so this now describes more of what
// /orders/open was already sending.
type Order = {
  id: number;
  status: string;
  createdAt: string;
  items: { id: number; name: string; canceled: boolean }[];
  visit: { kind: string; takeoutNumber: number | null; takeoutName: string | null };
};
type RosterEntry = { username: string; displayName: string; role: string };

// A check-in time → "2h 05m in the building". Recalculated on every redraw,
// which is why the timer further down exists.
function fmtDuration(iso: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function sinceLabel(iso: string) {
  return `since ${new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

// "Good morning" / "Good afternoon" / "Good evening", by the computer's clock.
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

// How each kitchen stage reads on the takeout tab. COMPLETE isn't here because
// the server stops sending an order once it's picked up — it just vanishes.
const ORDER_STATUS: Record<string, { label: string; ink: string; bg: string }> = {
  QUEUED: { label: "In queue", ink: "#6b6152", bg: "#f3ede2" },
  IN_PROGRESS: { label: "Being made", ink: "#7a5a3a", bg: "#f0e4d4" },
  READY: { label: "Ready to collect", ink: "#3f5540", bg: "#e2eadb" },
};

function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

function initials(name: string) {
  return name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

// One locker-capacity dial — the ring of 48 little marks with a number in the
// middle. Used twice: once for the men's pool, once for the women's.
//
// There's no chart library here. The ring is 48 short lines drawn one at a
// time around a circle, and "how full are we" is expressed by how many of them
// are painted dark. When every locker is taken the whole ring turns red and
// the number is replaced by the word FULL.
function Dial({ free, total, label }: { free: number; total: number; label: string }) {
  const full = total > 0 && free === 0;
  const occupied = total - free;
  const TICKS = 48;
  // How many marks to light up — 30 of 60 lockers occupied lights 24 of 48.
  // The `total > 0` guard avoids dividing by zero before the lockers load.
  const lit = total > 0 ? Math.round((occupied / total) * TICKS) : 0;
  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 18, display: "flex", gap: 16, alignItems: "center", flex: 1, minWidth: 250, border: full ? "1.5px solid #b5563a" : "1.5px solid transparent" }}>
      <svg viewBox="0 0 120 120" style={{ width: 104, height: 104, flexShrink: 0 }}>
        {/* Draw the 48 marks. For each one: work out its angle around the
            circle (starting at 12 o'clock), then use sine and cosine to turn
            that angle into two points — one 43 units from the centre, one 54
            units out — and draw a line between them. That's a tick mark
            pointing outwards. Marks below the `lit` count are painted dark. */}
        {Array.from({ length: TICKS }, (_, i) => {
          const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
          const x1 = 60 + Math.cos(a) * 43, y1 = 60 + Math.sin(a) * 43;
          const x2 = 60 + Math.cos(a) * 54, y2 = 60 + Math.sin(a) * 54;
          return (
            <line
              key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={full ? "#b5563a" : i < lit ? "#7a6a53" : "#e6dfd1"}
              strokeWidth={3}
              strokeLinecap="round"
            />
          );
        })}
        <text x="60" y="60" textAnchor="middle" fontSize={full ? 19 : 27} fontWeight={800} fill={full ? "#b5563a" : "#2b2620"} fontFamily="inherit">
          {full ? "FULL" : free}
        </text>
        <text x="60" y="77" textAnchor="middle" fontSize={8.5} letterSpacing={1.4} fill="#8a7f6d" fontFamily="inherit">
          {full ? `${total} / ${total}` : "AVAILABLE"}
        </text>
      </svg>
      <div>
        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: ".16em", color: "#8a7f6d" }}>{label}</div>
        <div style={{ fontSize: 21, fontWeight: 800, color: full ? "#b5563a" : "#2b2620" }}>
          {full ? "Full" : `${free} free`}
        </div>
        <div style={{ fontSize: 12.5, color: "#8a7f6d" }}>{occupied} occupied · {total} total</div>
      </div>
    </div>
  );
}

// A plain white rounded panel. `children` is whatever you put between the
// <Card> tags — that's how a component wraps other content.
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: "#fff", borderRadius: 14, padding: 18, ...style }}>{children}</div>;
}

const CARD_LABEL: React.CSSProperties = { fontSize: 11.5, fontWeight: 800, letterSpacing: ".16em", color: "#8a7f6d", marginBottom: 10 };

function Home() {
  // Everything this screen displays, each starting as an empty list until the
  // server answers. Changing any of these redraws the page.
  const [visits, setVisits] = useState<Visit[]>([]);
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  // Which half of the main card is showing. Guests in the building, or orders
  // waiting at the counter.
  const [tab, setTab] = useState<"guests" | "takeout">("guests");

  // A deliberately unused value. The empty slot before the comma means "I
  // don't care what the number is" — we only ever want the side effect of
  // CHANGING it, which forces a redraw. A timer below bumps it once a minute
  // so the clock in the header and the "2h 05m" durations tick forward on
  // their own. The same trick appears in PointOfSale, Checkout and Kitchen.
  const [, setTick] = useState(0); // bumping this re-renders the clock + durations

  // Who's signed in, for the greeting. Read straight from the browser's
  // notepad — see Shell.tsx, which is what put it there.
  const user: LoggedInUser | null = JSON.parse(localStorage.getItem("user") ?? "null");

  // Ask the server for all three lists at once. They're independent, so they
  // don't wait for each other — whichever answers first redraws its bit.
  const loadAll = () => {
    authFetch(`/visits/active`).then((r) => r.json()).then(setVisits);
    authFetch(`/lockers`).then((r) => r.json()).then(setLockers);
    authFetch(`/orders/open`).then((r) => r.json()).then(setOrders);
  };

  // Runs once, when the dashboard opens. The `[]` at the end is what means
  // "once, not on every redraw".
  useEffect(() => {
    loadAll();
    // The staff list is fetched separately because it never changes during a
    // shift — no need to re-fetch it every time something happens.
    authFetch(`/login-roster`).then((r) => r.json()).then(setRoster);

    // Live updates. Each of these is something that could happen on ANOTHER
    // terminal — someone checked a guest in at the other desk, the kitchen
    // marked an order ready. Notice every one of them runs the same `refresh`
    // and none of them look at what the message contains: the message is only
    // a doorbell saying "something changed", and the answer is always to go
    // and fetch fresh copies. That's the pattern used across the whole app.
    const refresh = () => loadAll();
    socket.on("visit:checked-in", refresh);
    socket.on("visit:checked-out", refresh);
    socket.on("visit:locker-changed", refresh);
    socket.on("locker:updated", refresh);
    socket.on("orders:changed", refresh);
    socket.on("bill:line-item-added", refresh);

    // Redraw once a minute so the durations don't go stale.
    const timer = setInterval(() => setTick((t) => t + 1), 60000);

    // The tidy-up. React runs this when you navigate away from the dashboard.
    // Without it, every visit to this page would add another set of listeners
    // on the same shared connection, and the fetches would multiply.
    return () => {
      socket.off("visit:checked-in", refresh);
      socket.off("visit:checked-out", refresh);
      socket.off("visit:locker-changed", refresh);
      socket.off("locker:updated", refresh);
      socket.off("orders:changed", refresh);
      socket.off("bill:line-item-added", refresh);
      clearInterval(timer);
    };
  }, []);

  // Count lockers in one pool — either all of them, or only the free ones.
  const count = (g: string, status?: string) =>
    lockers.filter((l) => l.gender === g && (!status || l.status === status)).length;
  const freeM = count("MALE", "AVAILABLE"), totalM = count("MALE");
  const freeF = count("FEMALE", "AVAILABLE"), totalF = count("FEMALE");

  // Split the headcount by gender for the little two-tone bar.
  const menIn = visits.filter((v) => v.customer.gender === "MALE").length;
  const womenIn = visits.length - menIn;

  const kitchenCount = (s: string) => orders.filter((o) => o.status === s).length;
  // Open takeout orders, oldest first — the same list the kitchen is looking
  // at, filtered down to the ones nobody is sitting in the building waiting for.
  const takeoutOrders = orders
    .filter((o) => o.visit.kind === "TAKEOUT")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Build the red "at capacity" banner text — empty when there's room, which
  // is how the banner knows to hide itself.
  const fullPools = [
    ...(totalM > 0 && freeM === 0 ? [`Men at capacity (${totalM}/${totalM})`] : []),
    ...(totalF > 0 && freeF === 0 ? [`Women at capacity (${totalF}/${totalF})`] : []),
  ];

  const now = new Date();

  return (
    <div style={{ padding: "18px 26px 30px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>
            {greeting()}, {user?.displayName ?? "there"}
          </h1>
          <div style={{ color: "#8a7f6d", fontSize: 13, marginTop: 2 }}>
            {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
            {" · "}
            {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "#8a7f6d" }}>On shift</span>
          {roster.map((s) => (
            <span
              key={s.username}
              title={`${s.displayName} · ${s.role === "ADMIN" ? "Admin" : "Staff"}`}
              style={{ width: 30, height: 30, borderRadius: "50%", background: "#e6dfd1", color: "#5c5344", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}
            >
              {initials(s.displayName)}
            </span>
          ))}
          <Link
            to="/customers"
            style={{ background: "#4a4236", color: "#fffdf9", padding: "11px 22px", borderRadius: 10, textDecoration: "none", fontWeight: 700, fontSize: 14 }}
          >
            Check In
          </Link>
        </div>
      </div>

      {/* At-capacity banner */}
      {fullPools.length > 0 && (
        <div style={{ marginTop: 14, background: "#f6ded8", color: "#8f3b26", padding: "10px 16px", borderRadius: 10, fontWeight: 700, fontSize: 13.5 }}>
          ● {fullPools.join(" · ")}
        </div>
      )}

      {/* Main grid */}
      <div style={{ display: "flex", gap: 16, marginTop: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Left column */}
        <div style={{ flex: 2.2, minWidth: 460, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Dial free={freeM} total={totalM} label="MEN" />
            <Dial free={freeF} total={totalF} label="WOMEN" />
          </div>

          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 6 }}>
                {([
                  { id: "guests" as const, label: "GUESTS IN THE BATHS", n: visits.length },
                  { id: "takeout" as const, label: "TAKEOUT", n: takeoutOrders.length },
                ]).map((t) => {
                  const on = tab === t.id;
                  return (
                    <div
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      style={{ ...CARD_LABEL, marginBottom: 0, cursor: "pointer", padding: "6px 12px", borderRadius: 8, background: on ? "#f3ede2" : "transparent", color: on ? "#5c5344" : "#a89a86" }}
                    >
                      {t.label}
                      {t.n > 0 ? ` · ${t.n}` : ""}
                    </div>
                  );
                })}
              </div>
              <Link to="/pos" style={{ color: "#8f5340", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>
                See all →
              </Link>
            </div>
            {tab === "guests" ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  {["LOCKER", "GUEST", "DURATION", "NOTE"].map((h) => (
                    <th key={h} style={{ textAlign: "left", fontSize: 10.5, letterSpacing: ".12em", color: "#8a7f6d", padding: "8px 6px", borderBottom: "1px solid #eee7da" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Only the first 8, to keep the dashboard short — the
                    "See all →" link above goes to Point of Sale for the rest. */}
                {visits.slice(0, 8).map((v) => (
                  <tr key={v.id}>
                    <td style={{ padding: "10px 6px", borderBottom: "1px solid #f3ede2", fontWeight: 700, color: "#5c5344" }}>
                      {v.locker.number}
                    </td>
                    <td style={{ padding: "10px 6px", borderBottom: "1px solid #f3ede2" }}>
                      <div style={{ fontWeight: 700 }}>{v.customer.firstName} {v.customer.lastName}</div>
                      <div style={{ fontSize: 12, color: "#8a7f6d" }}>{sinceLabel(v.checkInAt)}</div>
                    </td>
                    <td style={{ padding: "10px 6px", borderBottom: "1px solid #f3ede2", fontWeight: 600 }}>
                      {fmtDuration(v.checkInAt)}
                    </td>
                    <td style={{ padding: "10px 6px", borderBottom: "1px solid #f3ede2" }}>
                      {v.customer.notes ? (
                        <span style={{ background: "#f6ded8", color: "#8f3b26", padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
                          {v.customer.notes}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {visits.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ padding: "16px 6px", color: "#8a7f6d" }}>Nobody checked in right now.</td>
                  </tr>
                )}
              </tbody>
            </table>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {takeoutOrders.map((o) => {
                  const stage = ORDER_STATUS[o.status] ?? { label: o.status, ink: "#6b6152", bg: "#f3ede2" };
                  // Items an admin pulled off the bill stay on the ticket in red
                  // for the cook's benefit, but there's no reason to list them here.
                  const active = o.items.filter((i) => !i.canceled);
                  const mins = minutesSince(o.createdAt);
                  return (
                    <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 6px", borderBottom: "1px solid #f3ede2" }}>
                      <div style={{ flex: "none", width: 46, textAlign: "center" }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: "#7a6a53", lineHeight: 1 }}>
                          {o.visit.takeoutNumber ?? "?"}
                        </div>
                        <div style={{ fontSize: 10, color: "#b8ab97", fontWeight: 700 }}>ORDER</div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>
                          {o.visit.takeoutName?.trim() || "No name given"}
                        </div>
                        <div style={{ fontSize: 12, color: "#8a7f6d", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {active.length} item{active.length === 1 ? "" : "s"}
                          {active.length > 0 ? ` · ${active.map((i) => i.name).join(", ")}` : ""}
                        </div>
                      </div>
                      <div style={{ flex: "none", fontSize: 12, fontWeight: 600, color: mins >= 15 ? "#8f3b26" : "#a89a86" }}>
                        {mins} min
                      </div>
                      <span style={{ flex: "none", fontSize: 11.5, fontWeight: 800, color: stage.ink, background: stage.bg, borderRadius: 20, padding: "5px 12px" }}>
                        {stage.label}
                      </span>
                    </div>
                  );
                })}
                {takeoutOrders.length === 0 && (
                  <div style={{ padding: "16px 6px", color: "#8a7f6d" }}>No takeout orders waiting.</div>
                )}
              </div>
            )}
          </Card>
        </div>

        {/* Right column */}
        <div style={{ flex: 1, minWidth: 240, display: "flex", flexDirection: "column", gap: 16 }}>
          <Link
            to="/customers"
            style={{ display: "block", textAlign: "center", background: "#fff", border: "1.5px solid #d8cfbd", borderRadius: 12, padding: "13px 0", textDecoration: "none", color: "#2b2620", fontWeight: 700, fontSize: 14 }}
          >
            New Customer
          </Link>

          <Card>
            <div style={CARD_LABEL}>CHECKED IN NOW</div>
            <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1 }}>{visits.length}</div>
            {/* The two-tone bar. There's no width calculation here — the two
                halves are just told to take up space in proportion to the two
                headcounts, and the browser works out the split. The tiny
                0.0001 is a floor: a count of zero would make the browser fall
                back to a default width rather than vanishing, so this gives it
                a number that's technically above zero but invisible. */}
            <div style={{ display: "flex", gap: 4, marginTop: 12 }}>
              <div style={{ height: 7, borderRadius: 4, background: "#4a4236", flex: Math.max(menIn, 0.0001) }} />
              <div style={{ height: 7, borderRadius: 4, background: "#cfc4ae", flex: Math.max(womenIn, 0.0001) }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#8a7f6d", marginTop: 6 }}>
              <span>{menIn} men</span>
              <span>{womenIn} women</span>
            </div>
          </Card>

          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={CARD_LABEL}>KITCHEN</div>
              <Link to="/kitchen" style={{ color: "#8f5340", textDecoration: "none", fontWeight: 700 }}>→</Link>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { label: "QUEUE", n: kitchenCount("QUEUED"), bg: "#f3ede2" },
                { label: "PREP", n: kitchenCount("IN_PROGRESS"), bg: "#f0e4d4" },
                { label: "READY", n: kitchenCount("READY"), bg: "#e2eadb" },
              ].map((t) => (
                <div key={t.label} style={{ flex: 1, background: t.bg, borderRadius: 10, padding: "12px 0", textAlign: "center" }}>
                  <div style={{ fontSize: 20, fontWeight: 800 }}>{t.n}</div>
                  <div style={{ fontSize: 10, letterSpacing: ".1em", color: "#8a7f6d", fontWeight: 700 }}>{t.label}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default Home;