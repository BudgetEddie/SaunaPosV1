// ============================================================================
// THE KITCHEN BOARD — the cooks' screen.
//
// WHAT IT IS
//   Three columns that a ticket moves through left to right:
//     Queue  →  Prep  →  Ready  →  (gone)
//   Each card is one guest's order, showing their locker number so it can be
//   delivered. Tapping the button on a card pushes it to the next column.
//
//   It also has a "New Order" composer, for orders taken at the kitchen
//   counter rather than at the till. That sends to exactly the same place the
//   till does, so the charge lands on the guest's tab either way.
//
// WHERE IT'S USED
//   The "/kitchen" route in client/src/main.tsx. Nothing imports it.
//   Home.tsx shows a summary of these three columns and links here.
//
// WHAT IT TALKS TO   (all in server/src/index.ts)
//   GET    /orders/open              → the three columns
//   GET    /visits/active            → guest search in the composer
//   GET    /categories               → the menu, filtered to kitchen items
//   GET    /login-roster             → the "on shift" avatars
//   POST   /orders/:id/status        → move a ticket to the next column
//   DELETE /order-items/:id          → dismiss a canceled item
//   POST   /visits/:id/confirm-order → the composer (same as PointOfSale uses)
// ============================================================================

import { useEffect, useState, type FormEvent } from "react";
import { io } from "socket.io-client";
import { authFetch } from "./authFetch.ts";
import { type Category, type Visit } from "./types.ts";

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

// The board, described as data rather than written out three times. Each entry
// says which tickets it holds, what its button says, and where that button
// sends them. The three columns on screen are drawn by looping over this.
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

function Kitchen() {
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

  const loadOrders = () => authFetch(`/orders/open`).then((r) => r.json()).then(setOrders);
  const loadVisits = () => authFetch(`/visits/active`).then((r) => r.json()).then(setVisits);
  const loadMenu = () => authFetch(`/categories`).then((r) => r.json()).then(setCategories);

  useEffect(() => {
    loadOrders();
    loadVisits();
    loadMenu();
    authFetch(`/login-roster`).then((r) => r.json()).then(setRoster);

    // "orders:changed" is the one that matters here — it fires whenever an
    // order is rung up at the till, advanced on another kitchen screen, or
    // cancelled. As everywhere, the message itself is ignored; it just means
    // "refetch the board".
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
  }, []);

  // Push a ticket one column to the right. The server broadcasts the change,
  // so every other kitchen screen and the dashboard update too.
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
      alert(error);
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

  // Only categories that print a ticket. No point offering towels here.
  const kitchenCategories = categories.filter((c) => c.isKitchen);
  const now = new Date();

  return (
    <div style={{ background: "#f4efe7", minHeight: "100vh", position: "relative" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 26px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800 }}>Kitchen</div>
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
      <div style={{ padding: "22px 26px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18, alignItems: "start" }}>
        {COLUMNS.map((col) => {
          const cards = orders.filter((o) => o.status === col.status);
          return (
            <div key={col.status} style={{ background: "#efe9df", border: "1px solid rgba(43,38,32,.06)", borderRadius: 16, padding: 14, display: "flex", flexDirection: "column", gap: 12, minHeight: 520 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <div style={{ width: 9, height: 9, borderRadius: "50%", background: col.dot }} />
                  <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.8, textTransform: "uppercase", color: "#6b6152" }}>
                    {col.label}
                  </span>
                </div>
                <div style={{ minWidth: 24, textAlign: "center", fontSize: 12, fontWeight: 800, color: "#6b6152", background: "#fffdf9", border: "1px solid rgba(43,38,32,.08)", padding: "2px 9px", borderRadius: 20 }}>
                  {cards.length}
                </div>
              </div>

              <div className="k-col" style={{ display: "flex", flexDirection: "column", gap: 11, overflowY: "auto", maxHeight: 560 }}>
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
                    <div key={order.id} style={{ background: "#fffdf9", border: "1px solid rgba(43,38,32,.08)", borderRadius: 14, padding: 15, boxShadow: "0 1px 2px rgba(43,38,32,.04)" }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                            <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.2 }}>
                              {ticketName(order.visit)}
                            </div>
                            {/* The cook needs to know at a glance that this one
                                goes in a bag on the counter, not out to a bench. */}
                            {order.visit.kind === "TAKEOUT" && (
                              <span style={{ flex: "none", fontSize: 9.5, fontWeight: 800, letterSpacing: 1, color: "#8f5340", background: "#f4e6dd", borderRadius: 20, padding: "2px 8px" }}>
                                TAKEOUT
                              </span>
                            )}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 3 }}>
                            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                              <path d="M5.5 1C3.6 1 2 2.5 2 4.4c0 2.4 3.5 5.6 3.5 5.6S9 6.8 9 4.4C9 2.5 7.4 1 5.5 1z" stroke="#a89a86" strokeWidth="1.3" />
                              <circle cx="5.5" cy="4.3" r="1.1" fill="#a89a86" />
                            </svg>
                            <span style={{ fontSize: 12, fontWeight: 700, color: "#7a6a53" }}>{ticketTag(order)}</span>
                          </div>
                        </div>
                        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 800, color: late ? "#8f3f28" : "#a89a86", background: late ? "#f7e4dc" : "#f0ebe1", padding: "4px 9px", borderRadius: 20 }}>
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                            <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.3" />
                            <path d="M5 2.6V5l1.6 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {mins} min
                        </div>
                      </div>

                      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
                        {groupOrderItems(active).map((row) => (
                          <div key={row.key}>
                            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                              <span style={{ flex: "none", minWidth: 22, fontSize: 14, fontWeight: 800, color: "#7a6a53" }}>
                                {row.count}×
                              </span>
                              <span style={{ fontSize: 14, fontWeight: 600 }}>{row.name}</span>
                            </div>
                            {row.note && (
                              <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600, marginLeft: 30 }}>{row.note}</div>
                            )}
                          </div>
                        ))}
                      </div>

                      {canceled.length > 0 && (
                        <div style={{ marginTop: 11, background: "#f7e4dc", borderRadius: 10, padding: "9px 11px" }}>
                          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#8f3f28", marginBottom: 6 }}>
                            Order canceled
                          </div>
                          {canceled.map((item) => (
                            <div key={item.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: "#8f3f28", textDecoration: "line-through" }}>
                                {item.name}
                              </span>
                              <button
                                onClick={() => dismissCanceled(item.id)}
                                style={{ padding: "3px 10px", border: "1.5px solid #e8c3b4", borderRadius: 8, background: "#fffdf9", color: "#8f3f28", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {notes && (
                        <div style={{ marginTop: 11, display: "flex", flexWrap: "wrap", gap: 7 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#8f3f28", background: "#f7e4dc", padding: "4px 10px", borderRadius: 20 }}>
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
                          style={{ marginTop: 13, width: "100%", padding: 11, border: col.border, borderRadius: 11, background: col.bg, color: col.ink, fontFamily: "inherit", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}
                        >
                          {col.action}
                        </button>
                      )}
                    </div>
                  );
                })}

                {cards.length === 0 && (
                  <div style={{ textAlign: "center", padding: "26px 10px", fontSize: 13, fontWeight: 600, color: "#b8ab97" }}>
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
              {kitchenCategories.map((category) => (
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
                                placeholder="Add a note (temp, allergy, prep…)"
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
              {kitchenCategories.length === 0 && (
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#a89a86" }}>
                  No kitchen categories yet — mark a category as “kitchen” on the Menu page first.
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

export default Kitchen;