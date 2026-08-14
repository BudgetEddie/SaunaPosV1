// ============================================================================
// A TICKET BOARD — the cooks' screen, and the bar's screen.
//
// WHAT IT IS
//   ONE screen used TWICE. main.tsx mounts it at "/kitchen" telling it
//   station="KITCHEN", and again at "/bar" telling it station="BAR". Same
//   code, same look; each asks the server only for its own tickets and each
//   composer offers only its own half of the menu.
//
//   That's deliberate, and it's the reason there's no Bar.tsx sitting next to
//   this file. Two copies of 700 lines means every future tweak has to be made
//   twice from memory, and the first one that gets missed is the day the two
//   boards stop matching. One file, two mountings, one place to fix.
//
//   Three columns that a ticket moves through left to right:
//     Queue  →  Prep  →  Ready  →  (gone)
//   Each card is one guest's order for THIS board, showing their locker number
//   so it can be delivered. Tapping the button pushes it to the next column.
//   A guest who orders a burger and a beer has two cards — one here, one on
//   the other board — and each moves at its own pace.
//
//   It also has a "New Order" composer, for orders taken at the counter rather
//   than at the till. That sends to exactly the same place the till does, so
//   the charge lands on the guest's tab either way.
//
// WHERE IT'S USED
//   The "/kitchen" and "/bar" routes in client/src/main.tsx. Nothing else
//   imports it. Home.tsx shows a summary of both boards and links to each.
//
// WHAT IT TALKS TO   (all in server/src/index.ts)
//   GET    /orders/open?station=…    → the three columns, this board's only
//   GET    /visits/active            → guest search in the composer
//   GET    /categories               → the menu, filtered to this board's items
//   GET    /login-roster             → the "on shift" avatars
//   POST   /orders/:id/status        → move a ticket to the next column
//   DELETE /order-items/:id          → dismiss a canceled item
//   POST   /visits/:id/confirm-order → the composer (same as PointOfSale uses)
// ============================================================================

import { useEffect, useState, type FormEvent } from "react";
import { io } from "socket.io-client";
import { authFetch } from "./authFetch.ts";
import { type Category, type Visit } from "./types.ts";
import { useDialog } from "./DialogProvider.tsx";

// The live line to the server. This screen depends on it more than any other —
// it's how an order rung up at the front desk appears here seconds later
// without anyone touching this computer.
const socket = io("http://localhost:4000");

// `canceled` is the important one. An item pulled from a bill isn't deleted
// from a ticket that's already being cooked — it's flagged, so the cook can
// see it was cancelled and stop making it, then dismiss the card themselves.
type OrderItemRow = { id: number; name: string; note: string | null; canceled: boolean };
type KitchenOrder = {
  id: number;
  status: string;
  createdAt: string;
  items: OrderItemRow[];
  // Where to run it, when the guest is sitting in the lounge instead of waiting
  // at their locker. Null on most tickets, and always null for takeout.
  table: { number: string } | null;
  visit: {
    id: number;
    // STAY or TAKEOUT. A takeout ticket has no customer and no locker — it's
    // called out by number instead, and it's going in a bag rather than being
    // carried to a bench.
    kind: string;
    takeoutNumber: number | null;
    takeoutName: string | null;
    customer: { firstName: string; lastName: string; notes: string | null } | null;
    locker: { number: string } | null;
  };
};
type RosterEntry = { username: string; displayName: string; role: string };
type CartLine = { qty: number; note: string; name: string; price: number; taxRate: number; sendsToKitchen: boolean };
type Cart = Record<number, CartLine>;

// Which board this is. Passed in by main.tsx, once per route.
export type Station = "KITCHEN" | "BAR";

// Everything that differs between the two boards, in one place — same idea as
// COLUMNS below. If you find yourself writing `station === "BAR" ? …` anywhere
// else in this file, it probably belongs up here instead.
const STATIONS: Record<Station, { title: string; empty: string; noteHint: string }> = {
  KITCHEN: {
    title: "Kitchen",
    empty: "No kitchen sections yet — set a menu section to the kitchen on the Menu page first.",
    noteHint: "Add a note (temp, allergy, prep…)",
  },
  BAR: {
    title: "Bar",
    empty: "No bar sections yet — send a menu section to the bar on the Menu page first.",
    noteHint: "Add a note (no ice, extra lime…)",
  },
};

// The board, described as data rather than written out three times. Each entry
// says which tickets it holds, what its button says, and where that button
// sends them. The three columns on screen are drawn by looping over this.
//
// Both boards use the SAME three words on purpose. "Prep" is a shade odd for
// pouring a drink, but these three also name the tiles on the Home dashboard
// and line up with the server's four status words — and a cook covering the
// bar shouldn't have to learn a second vocabulary for the same screen.
//
// "Mark Picked Up" moves a ticket to COMPLETE, which isn't a column — the
// server stops sending completed orders, so the card simply disappears.
const COLUMNS = [
  { status: "QUEUED", label: "Queue", dot: "#a89a86", next: "IN_PROGRESS", action: "Start Prep", bg: "#7a6a53", ink: "#fff", border: "none" },
  { status: "IN_PROGRESS", label: "Prep", dot: "#7a6a53", next: "READY", action: "Mark Ready", bg: "#5f7a5a", ink: "#fff", border: "none" },
  { status: "READY", label: "Ready", dot: "#5f7a5a", next: "COMPLETE", action: "Mark Picked Up", bg: "#fffdf9", ink: "#6b6152", border: "1.5px solid #d8cebc" },
];

const LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "#a89a86",
};

function money(n: number) {
  // Discounts are negative, and "$-5.00" reads like a typo. Put the minus in
  // front of the whole thing — "−$5.00" — the way a receipt would.
  return n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}
function initials(first: string, last: string) {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}
function nameInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  return initials(parts[0] ?? "", parts[1] ?? "");
}

// What to write at the top of a ticket. A guest gets their name; a takeout order
// gets whatever the counter typed, or just "Takeout" if they typed nothing.
function ticketName(visit: KitchenOrder["visit"]) {
  if (visit.customer) return `${visit.customer.firstName} ${visit.customer.lastName}`;
  return visit.takeoutName?.trim() || "Takeout";
}
// And the line under it — WHERE this food is going. A table wins when there is
// one: a guest sitting in the lounge is somewhere specific, whereas their
// locker number only says which bench to look near. Falls back to the locker,
// then to the number called out for takeout.
function ticketTag(order: KitchenOrder) {
  if (order.table) return `Table ${order.table.number}`;
  return order.visit.locker ? order.visit.locker.number : `#${order.visit.takeoutNumber ?? "?"}`;
}

function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

// Two teas with the same note are one line; two teas where one is "extra hot"
// stay apart, because the cook needs to see both instructions.
function groupOrderItems(items: OrderItemRow[]) {
  const rows = new Map<string, { key: string; name: string; note: string | null; count: number }>();
  for (const item of items) {
    const key = `${item.name}|${item.note ?? ""}`;
    const row = rows.get(key);
    if (row) row.count += 1;
    else rows.set(key, { key, name: item.name, note: item.note, count: 1 });
  }
  return Array.from(rows.values());
}

function StationBoard({ station }: { station: Station }) {
  const dialog = useDialog();
  // Everything about this board that isn't the same as the other one.
  const s = STATIONS[station];
  const [orders, setOrders] = useState<KitchenOrder[]>([]);   // the board
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);          // guests, for the composer
  const [categories, setCategories] = useState<Category[]>([]);

  // ---- the "New Order" composer ----
  const [composerOpen, setComposerOpen] = useState(false);
  const [guestQuery, setGuestQuery] = useState("");           // guest search box
  const [guestVisitId, setGuestVisitId] = useState<number | null>(null);
  const [cart, setCart] = useState<Cart>({});

  // Redrawn every 20 seconds so the "waiting 6 min" clocks on each ticket
  // creep upward. Faster than the other screens because a cook watching a
  // ticket age wants it accurate.
  const [, setTick] = useState(0);

  // Only THIS board's tickets. The server does the filtering rather than the
  // browser, so a bar terminal in the lounge never holds the whole floor's
  // guest names, locker numbers and allergy notes just to show four drinks.
  const loadOrders = () =>
    authFetch(`/orders/open?station=${station}`).then((r) => r.json()).then(setOrders);
  const loadVisits = () => authFetch(`/visits/active`).then((r) => r.json()).then(setVisits);
  const loadMenu = () => authFetch(`/categories`).then((r) => r.json()).then(setCategories);

  useEffect(() => {
    loadOrders();
    loadVisits();
    loadMenu();
    authFetch(`/login-roster`).then((r) => r.json()).then(setRoster);

    // "orders:changed" is the one that matters here — it fires whenever an
    // order is rung up at the till, advanced on another screen, or cancelled.
    // As everywhere, the message itself is ignored; it just means "refetch the
    // board". It's one doorbell for both boards, so the kitchen does a wasted
    // refetch when a drink is poured. That costs one query and is invisible;
    // per-board doorbells would mean every endpoint that changes a ticket has
    // to work out which board it belongs to, and the void endpoint can't
    // easily tell.
    const refresh = () => { loadOrders(); loadVisits(); };
    socket.on("orders:changed", refresh);
    socket.on("visit:checked-in", loadVisits);
    socket.on("visit:checked-out", loadVisits);
    socket.on("menu:updated", loadMenu);

    // The ticket clocks tick themselves; nothing is fetched for this.
    const timer = setInterval(() => setTick((t) => t + 1), 20000);
    return () => {
      socket.off("orders:changed", refresh);
      socket.off("visit:checked-in", loadVisits);
      socket.off("visit:checked-out", loadVisits);
      socket.off("menu:updated", loadMenu);
      clearInterval(timer);
    };
    // `station` is listed so that if this screen is ever reached in a way that
    // swaps the board without rebuilding it from scratch, the fetch above
    // starts asking for the other one. Today the two routes are separate
    // elements so React tears one down and builds the other, and this never
    // fires twice — but leaving it empty would mean a board silently stuck
    // fetching the station it opened with, with no error to notice.
  }, [station]);

  // Push a ticket one column to the right. The server broadcasts the change,
  // so every other board and the dashboard update too.
  const advance = async (order: KitchenOrder, status: string) => {
    await authFetch(`/orders/${order.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    loadOrders();
  };

  // The cook acknowledging a cancelled item and clearing it off the card. The
  // server refuses to remove anything that wasn't actually cancelled, so this
  // can't be used to make a real order disappear. If it was the last item on
  // the ticket, the whole card goes with it.
  const dismissCanceled = async (itemId: number) => {
    await authFetch(`/order-items/${itemId}`, { method: "DELETE" });
    loadOrders();
  };

  const closeComposer = () => {
    setComposerOpen(false);
    setGuestQuery("");
    setGuestVisitId(null);
    setCart({});
  };

  const bump = (item: { id: number; name: string; price: number; taxRate: number; sendsToKitchen: boolean }, delta: number) => {
    setCart((prev) => {
      const next = { ...prev };
      const line = next[item.id];
      const qty = (line?.qty ?? 0) + delta;
      if (qty <= 0) delete next[item.id];
      else next[item.id] = { qty, note: line?.note ?? "", name: item.name, price: item.price, taxRate: item.taxRate, sendsToKitchen: item.sendsToKitchen };
      return next;
    });
  };

  const setNote = (id: number, note: string) => {
    setCart((prev) => {
      const line = prev[id];
      if (!line) return prev;
      return { ...prev, [id]: { ...line, note } };
    });
  };

  // Send the composer's order. This hits the exact same address the till uses,
  // so a coffee ordered at the kitchen counter lands on the guest's tab just
  // as if it had been rung up at the front desk — they pay for it at checkout
  // either way. That's why the kitchen needs to pick a guest first.
  const submitOrder = async (e: FormEvent) => {
    e.preventDefault();
    if (!guestVisitId || cartLines.length === 0) return;
    // Same fan-out as the till: "Tea ×3" becomes three separate entries,
    // because that's one row per drink on the bill and three things to make.
    const items = cartLines.flatMap((line) =>
      Array.from({ length: line.qty }, () => ({
        name: line.name,
        amount: line.price,
        // Always true here — everything orderable from this screen is food or
        // drink, so it always produces a ticket.
        // WAS `true`, which was safe only while everything on this screen went
        // to the kitchen. A self-serve drink handed over the counter is a sale,
        // not a ticket the kitchen writes to itself.
        isKitchen: line.sendsToKitchen,
        // WHICH BOARD it prints on. Always this screen's own — the composer
        // only ever shows this board's sections, so there's nothing else it
        // could be.
        station,
        visitCredits: 0,
        taxRate: line.taxRate,
        note: line.note,
      }))
    );
    const res = await authFetch(`/visits/${guestVisitId}/confirm-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      const { error } = await res.json();
      await dialog.say(error, { title: "That didn't work" });
      return;
    }
    closeComposer();
    loadOrders();
  };

  const cartLines = Object.values(cart);
  const cartQty = cartLines.reduce((n, l) => n + l.qty, 0);
  const cartTotal = cartLines.reduce((sum, l) => sum + l.price * l.qty, 0);

  // Guest search inside the composer. Only checked-in guests can be searched —
  // an order has to attach to an open visit, since that's what carries the tab.
  // Capped at 6 results to keep the dropdown short.
  const chosen = visits.find((v) => v.id === guestVisitId) ?? null;
  const gq = guestQuery.trim().toLowerCase();
  const guestResults = gq
    ? visits.filter((v) =>
        `${v.customer.firstName} ${v.customer.lastName} ${v.locker.number}`.toLowerCase().includes(gq)
      ).slice(0, 6)
    : [];

  // Only sections that print a ticket, AND print it on THIS board. No point
  // offering towels here, and no point offering the cook a beer.
  //
  // Both halves matter. `isKitchen` is still "does this make a ticket at all",
  // so it's what keeps merchandise out; `station` then picks the board. Keeping
  // both means a stray station value on a towel section can never leak it here.
  const stationCategories = categories.filter((c) => c.isKitchen && c.station === station);
  const now = new Date();

  return (
    // THE BOARD FILLS THE SCREEN, exactly once. The page itself never scrolls;
    // only the inside of a column does. That's what lets the columns grow to
    // whatever height the screen has instead of stopping at a fixed size and
    // leaving the bottom of a wall-mounted monitor empty.
    //
    // The three parts below — header, board, columns — each need their share of
    // this: `flex: none` on the header keeps it its natural size, `flex: 1` and
    // `minHeight: 0` on the board let it take everything left over. Without the
    // minHeight a flex child refuses to shrink below its contents, which is the
    // usual reason a layout like this scrolls the whole page instead.
    <div style={{ background: "#f4efe7", height: "100vh", overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
      {/* header — trimmed a little, since every pixel here is one the cooks
          don't get for tickets. */}
      <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 22px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800 }}>{s.title}</div>
            <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600 }}>
              {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
              {" · "}
              {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, background: "#f0ebe1", padding: "6px 12px", borderRadius: 20 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#5f7a5a", animation: "pulseDot 1.8s ease-in-out infinite" }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: "#6b6152" }}>
              Live · {orders.length} open order{orders.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600 }}>On shift</div>
            <div style={{ display: "flex" }}>
              {roster.map((s) => (
                <div
                  key={s.username}
                  title={`${s.displayName} · ${s.role === "ADMIN" ? "Admin" : "Staff"}`}
                  style={{ width: 28, height: 28, borderRadius: "50%", background: "#efe7d9", border: "2px solid #fffdf9", marginLeft: -5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#7a6a53" }}
                >
                  {nameInitials(s.displayName)}
                </div>
              ))}
            </div>
          </div>
          <button
            onClick={() => setComposerOpen(true)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 20px", border: "none", borderRadius: 11, background: "#7a6a53", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: "pointer", boxShadow: "0 8px 18px -10px rgba(122,106,83,.85)" }}
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <line x1="7.5" y1="3" x2="7.5" y2="12" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
              <line x1="3" y1="7.5" x2="12" y2="7.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            New Order
          </button>
        </div>
      </div>

      {/* board */}
      {/* The three columns, drawn by looping over COLUMNS. Each one filters the
          same list of orders down to the ones at its stage. */}
      <div style={{ flex: 1, minHeight: 0, padding: "14px 22px 18px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, alignItems: "stretch" }}>
        {COLUMNS.map((col) => {
          const cards = orders.filter((o) => o.status === col.status);
          // A BUSY COLUMN GOES TWO CARDS WIDE. During a rush nearly everything
          // piles into Queue while Prep and Ready sit empty, so the one column
          // that matters was being squeezed into a third of the screen.
          //
          // `auto-fill` with a minimum width is what makes this safe: two cards
          // appear only where there's genuinely room for both, so a narrower
          // screen quietly stays one-up rather than crushing them. Below the
          // threshold it stays one-up too — a quiet board shouldn't have its
          // cards shrink for no reason.
          const twoUp = cards.length >= 5;
          return (
            <div key={col.status} style={{ background: "#efe9df", border: "1px solid rgba(43,38,32,.06)", borderRadius: 16, padding: 10, display: "flex", flexDirection: "column", gap: 9, minHeight: 0 }}>
              <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 3px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: col.dot }} />
                  <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 1.6, textTransform: "uppercase", color: "#6b6152" }}>
                    {col.label}
                  </span>
                </div>
                <div style={{ minWidth: 24, textAlign: "center", fontSize: 12, fontWeight: 800, color: "#6b6152", background: "#fffdf9", border: "1px solid rgba(43,38,32,.08)", padding: "2px 9px", borderRadius: 20 }}>
                  {cards.length}
                </div>
              </div>

              <div
                className="k-col"
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                  display: "grid",
                  gridTemplateColumns: twoUp ? "repeat(auto-fill, minmax(190px, 1fr))" : "1fr",
                  // alignContent so cards keep their own heights and stack from
                  // the top; without it a grid stretches its rows to fill.
                  alignContent: "start",
                  gap: 9,
                }}
              >
                {cards.map((order) => {
                  // How long this ticket has been waiting. Past 15 minutes the
                  // badge turns red — a nudge, not a rule.
                  const mins = minutesSince(order.createdAt);
                  const late = mins >= 15;
                  // Split the ticket: things still to make, and things pulled
                  // from the bill. Cancelled items are shown separately in red
                  // rather than hidden, so a cook mid-preparation finds out.
                  const active = order.items.filter((i) => !i.canceled);
                  const canceled = order.items.filter((i) => i.canceled);
                  // Allergies and warnings from the guest's profile, surfaced
                  // here so the kitchen sees them without looking anyone up.
                  // Allergy warnings come off a profile, and takeout has none —
                  // so a takeout ticket never shows one. Worth knowing at the
                  // counter: if somebody mentions an allergy on a takeout order,
                  // it has to go in the item's note box or it won't be seen.
                  const notes = order.visit.customer?.notes ?? null;
                  return (
                    // The card's SPACING is what got tightened, not its type.
                    // What a cook reads across the room — the dish and how many
                    // — is the same size it always was; the padding, margins
                    // and the button around it are what shrank.
                    <div key={order.id} style={{ background: "#fffdf9", border: "1px solid rgba(43,38,32,.08)", borderRadius: 12, padding: "10px 11px", boxShadow: "0 1px 2px rgba(43,38,32,.04)", minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 7 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <div style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.15 }}>
                              {ticketName(order.visit)}
                            </div>
                            {/* The cook needs to know at a glance that this one
                                goes in a bag on the counter, not out to a bench. */}
                            {order.visit.kind === "TAKEOUT" && (
                              <span style={{ flex: "none", fontSize: 9, fontWeight: 800, letterSpacing: .8, color: "#8f5340", background: "#f4e6dd", borderRadius: 20, padding: "1px 6px" }}>
                                TAKEOUT
                              </span>
                            )}
                          </div>
                          {/* Where it's going. Dropped to a plain line without
                              its pin icon — at two cards wide the icon cost
                              more room than it earned. */}
                          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#7a6a53", marginTop: 1 }}>
                            {ticketTag(order)}
                          </div>
                        </div>
                        {/* The waiting badge loses its clock face and keeps the
                            number, which is the part anyone actually reads —
                            and it still turns red past fifteen minutes. */}
                        <div style={{ flex: "none", fontSize: 10.5, fontWeight: 800, color: late ? "#8f3f28" : "#a89a86", background: late ? "#f7e4dc" : "#f0ebe1", padding: "2px 7px", borderRadius: 20 }}>
                          {mins}m
                        </div>
                      </div>

                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                        {groupOrderItems(active).map((row) => (
                          <div key={row.key}>
                            {/* LEFT AT FULL SIZE ON PURPOSE. Everything else on
                                this card gave up room; the dish and the count
                                did not. */}
                            <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                              <span style={{ flex: "none", minWidth: 20, fontSize: 14, fontWeight: 800, color: "#7a6a53" }}>
                                {row.count}×
                              </span>
                              <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25 }}>{row.name}</span>
                            </div>
                            {row.note && (
                              <div style={{ fontSize: 11.5, color: "#a89a86", fontWeight: 600, marginLeft: 27, lineHeight: 1.3 }}>{row.note}</div>
                            )}
                          </div>
                        ))}
                      </div>

                      {canceled.length > 0 && (
                        <div style={{ marginTop: 8, background: "#f7e4dc", borderRadius: 9, padding: "7px 9px" }}>
                          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: .8, textTransform: "uppercase", color: "#8f3f28", marginBottom: 4 }}>
                            Order canceled
                          </div>
                          {canceled.map((item) => (
                            <div key={item.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 7, marginTop: 3 }}>
                              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#8f3f28", textDecoration: "line-through", minWidth: 0 }}>
                                {item.name}
                              </span>
                              <button
                                onClick={() => dismissCanceled(item.id)}
                                style={{ flex: "none", padding: "2px 8px", border: "1.5px solid #e8c3b4", borderRadius: 8, background: "#fffdf9", color: "#8f3f28", fontFamily: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* The allergy warning. Untouched — it's the one thing on
                          this card where missing it actually hurts somebody, so
                          it keeps its size and its red while everything around
                          it gave up room. */}
                      {notes && (
                        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#8f3f28", background: "#f7e4dc", padding: "4px 10px", borderRadius: 20, lineHeight: 1.35 }}>
                            {notes.length > 40 ? `${notes.slice(0, 40)}…` : notes}
                          </span>
                        </div>
                      )}

                      {/* No advance button on a ticket where everything has
                          been cancelled — there's nothing left to cook, so the
                          only sensible action is dismissing the items above. */}
                      {active.length > 0 && (
                        <button
                          onClick={() => advance(order, col.next)}
                          style={{ marginTop: 9, width: "100%", padding: "7px 8px", border: col.border, borderRadius: 9, background: col.bg, color: col.ink, fontFamily: "inherit", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}
                        >
                          {col.action}
                        </button>
                      )}
                    </div>
                  );
                })}

                {cards.length === 0 && (
                  // gridColumn 1/-1 so this sits across the whole column rather
                  // than squeezing into one half of a two-up grid.
                  <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: "22px 10px", fontSize: 13, fontWeight: 600, color: "#b8ab97" }}>
                    Nothing here right now
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* composer */}
      {/* The "New Order" panel, for orders taken at the kitchen counter. Two
          steps: find the guest (they must be checked in), then tap items.
          Sending it goes to the same place the till does, so the charge
          appears on their tab. */}
      {composerOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(43,38,32,.42)", padding: 34, zIndex: 30, animation: "fadeIn .18s ease" }}>
          <form
            onSubmit={submitOrder}
            style={{ width: 920, maxWidth: "100%", maxHeight: "100%", margin: "0 auto", background: "#f4efe7", borderRadius: 20, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 30px 70px -24px rgba(43,38,32,.7)", animation: "popIn .24s ease" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 24px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>New Order</div>
              <div
                onClick={closeComposer}
                style={{ width: 32, height: 32, borderRadius: 9, background: "#f0ebe1", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <line x1="3" y1="3" x2="11" y2="11" stroke="#6b6152" strokeWidth="2" strokeLinecap="round" />
                  <line x1="11" y1="3" x2="3" y2="11" stroke="#6b6152" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
            </div>

            {/* guest */}
            <div style={{ padding: "16px 24px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
              <div style={{ ...LABEL, marginBottom: 9 }}>Guest</div>
              {chosen ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f3f0e6", border: "1.5px solid #7a6a53", borderRadius: 12, padding: "11px 15px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 38, height: 38, borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#7a6a53" }}>
                      {initials(chosen.customer.firstName, chosen.customer.lastName)}
                    </div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 800 }}>
                        {chosen.customer.firstName} {chosen.customer.lastName}
                      </div>
                      <div style={{ fontSize: 12, color: "#7a6a53", fontWeight: 700 }}>{chosen.locker.number}</div>
                    </div>
                  </div>
                  <div
                    onClick={() => { setGuestVisitId(null); setGuestQuery(""); }}
                    style={{ fontSize: 12, fontWeight: 700, color: "#a89a86", cursor: "pointer", padding: "6px 10px", borderRadius: 9, background: "#fffdf9" }}
                  >
                    Change
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 11, background: "#f4efe7", border: "1.5px solid #d8cebc", borderRadius: 12, padding: "11px 15px" }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <circle cx="6.8" cy="6.8" r="4.8" stroke="#a89a86" strokeWidth="1.8" />
                      <line x1="10.3" y1="10.3" x2="14" y2="14" stroke="#a89a86" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                    <input
                      className="k-in"
                      placeholder="Search guest by name or locker (e.g. Aiko or W-14)"
                      value={guestQuery}
                      onChange={(e) => setGuestQuery(e.target.value)}
                    />
                  </div>
                  {guestResults.length > 0 && (
                    <div style={{ marginTop: 9, display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {guestResults.map((v) => (
                        <div
                          key={v.id}
                          onClick={() => { setGuestVisitId(v.id); setGuestQuery(""); }}
                          style={{ display: "flex", alignItems: "center", gap: 9, background: "#f4efe7", border: "1.5px solid #d8cebc", borderRadius: 11, padding: "8px 12px", cursor: "pointer" }}
                        >
                          <div style={{ width: 30, height: 30, borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "#7a6a53" }}>
                            {initials(v.customer.firstName, v.customer.lastName)}
                          </div>
                          <div>
                            <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                              {v.customer.firstName} {v.customer.lastName}
                            </div>
                            <div style={{ fontSize: 11, color: "#a89a86", fontWeight: 700 }}>{v.locker.number}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {gq !== "" && guestResults.length === 0 && (
                    <div style={{ marginTop: 9, fontSize: 13, fontWeight: 600, color: "#a89a86" }}>
                      Nobody checked in matches “{guestQuery}”.
                    </div>
                  )}
                </>
              )}
            </div>

            {/* menu */}
            <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
              {stationCategories.map((category) => (
                <div key={category.id}>
                  <div style={{ ...LABEL, marginBottom: 11 }}>{category.name}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11 }}>
                    {category.items.filter((item) => item.available).map((item) => {
                      const line = cart[item.id];
                      const qty = line?.qty ?? 0;
                      return (
                        <div
                          key={item.id}
                          style={{ background: "#fffdf9", border: `1.5px solid ${qty > 0 ? "#7a6a53" : "rgba(43,38,32,.08)"}`, borderRadius: 13, padding: "13px 14px" }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 14.5, fontWeight: 700, lineHeight: 1.2 }}>{item.name}</div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "#7a6a53", marginTop: 2 }}>{money(item.price)}</div>
                          </div>
                          <div style={{ marginTop: 11, display: "flex", alignItems: "center", gap: 12 }}>
                            <div
                              onClick={() => bump(item, -1)}
                              style={{ width: 30, height: 30, flex: "none", borderRadius: 9, border: "1.5px solid #d8cebc", background: "#fffdf9", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#6b6152", fontSize: 18, fontWeight: 800, lineHeight: 1 }}
                            >
                              −
                            </div>
                            <div style={{ minWidth: 20, textAlign: "center", fontSize: 16, fontWeight: 800, color: qty > 0 ? "#7a6a53" : "#c8b9a0" }}>
                              {qty}
                            </div>
                            <div
                              onClick={() => bump(item, 1)}
                              style={{ width: 30, height: 30, flex: "none", borderRadius: 9, border: "1.5px solid #d8cebc", background: "#fffdf9", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#6b6152", fontSize: 18, fontWeight: 800, lineHeight: 1 }}
                            >
                              +
                            </div>
                          </div>
                          {qty > 0 && (
                            <div style={{ marginTop: 10, background: "#f4efe7", borderRadius: 9, padding: "8px 11px" }}>
                              <input
                                className="k-in"
                                style={{ fontSize: 13 }}
                                placeholder={s.noteHint}
                                value={line?.note ?? ""}
                                onChange={(e) => setNote(item.id, e.target.value)}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {category.items.length === 0 && (
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#a89a86" }}>Nothing in this category yet.</div>
                    )}
                  </div>
                </div>
              ))}
              {stationCategories.length === 0 && (
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#a89a86" }}>
                  {s.empty}
                </div>
              )}
            </div>

            {/* footer */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px", background: "#fffdf9", borderTop: "1px solid rgba(43,38,32,.08)" }}>
              <div>
                <div style={LABEL}>This order</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#6b6152", marginTop: 2 }}>
                  {cartQty === 0 ? "No items yet" : `${cartQty} item${cartQty === 1 ? "" : "s"}`}
                  {" · "}
                  <span style={{ fontWeight: 800, color: "#2b2620" }}>{money(cartTotal)}</span>
                </div>
              </div>
              <button
                type="submit"
                disabled={!chosen || cartQty === 0}
                style={{ padding: "15px 30px", border: "none", borderRadius: 13, background: chosen && cartQty > 0 ? "#7a6a53" : "#d8cebc", color: chosen && cartQty > 0 ? "#fff" : "#fffdf9", fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: chosen && cartQty > 0 ? "pointer" : "not-allowed" }}
              >
                Submit to Queue
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default StationBoard;