// ============================================================================
// THE TILL — where things get sold.
//
// WHAT IT IS
//   The busiest screen in the app, with three states:
//     1. A grid of everyone currently checked in.
//     2. That guest's order screen: menu tiles on the left, a running cart on
//        the right, and their open tab across the top.
//     3. Checkout, which takes over the whole page (see below).
//
//   The important idea: the CART is not the TAB. Tapping menu tiles fills a
//   cart that exists only in this browser — nothing is charged and the kitchen
//   hears nothing. Pressing "Add to tab" is the moment it becomes real.
//
// WHERE IT'S USED
//   The "/pos" route in client/src/main.tsx.
//   It renders Checkout.tsx itself — Checkout has no address of its own, so
//   this file is its only parent.
//   CustomerDirectory.tsx sends people here as "/pos?locker=M07", which opens
//   that guest's order screen directly.
//
// WHAT IT TALKS TO   (all in server/src/index.ts)
//   GET  /visits/active                → the guest grid
//   GET  /lockers                      → the "Move locker…" dropdown
//   GET  /categories                   → the menu
//   GET  /settings                     → default tax rate, for custom charges
//   POST /visits/:id/set-admission     → swap the entry charge
//   POST /visits/:id/confirm-order     → cart becomes charges + kitchen ticket
//   POST /visits/:id/change-locker     → move a guest to a different locker
// ============================================================================

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { io } from "socket.io-client";
import { authFetch } from "./authFetch.ts";
import { useOverride } from "./OverrideProvider.tsx";
import { useDialog } from "./DialogProvider.tsx";
import { SponsorPicker } from "./SponsorPicker.tsx";
import Checkout from "./Checkout.tsx";
import { type Category, type Locker, type MenuItem, type Visit } from "./types.ts";

// The live line to the server, opened once when the app starts.
const socket = io("http://localhost:4000");

// One line in the cart. `qty` is what the − / + buttons change; when the order
// is confirmed the line is expanded back into `qty` separate charges, which is
// how the bill and the kitchen ticket have always counted things.
type CartLine = {
  id: string;
  name: string;
  price: number;
  isKitchen: boolean;
  // WHICH BOARD this makes a ticket on — "KITCHEN" or "BAR". Null on anything
  // that makes no ticket at all (a towel, a discount, a custom charge).
  station: string | null;
  visitCredits: number;
  taxRate: number;
  note: string;
  qty: number;
};
// The whole cart: a lookup table from a made-up key to a line. Keys are
// prefixed by kind — "m12" for menu item 12, "c" plus a random string for a
// one-off custom charge — so tapping the same tea twice finds the existing
// line and bumps it, while two separate custom charges never collide.
type Cart = Record<string, CartLine>;

const PANEL: React.CSSProperties = {
  background: "#fffdf9",
  border: "1px solid rgba(43,38,32,.08)",
  borderRadius: 16,
  boxShadow: "0 1px 2px rgba(43,38,32,.04)",
};
const LABEL: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: 1.4,
  textTransform: "uppercase",
  color: "#a89a86",
};
const MICRO: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "#b8ab97",
};
const BTN_GHOST: React.CSSProperties = {
  padding: "10px 16px", border: "1.5px solid #d8cebc", borderRadius: 11, background: "#fffdf9",
  color: "#5f5340", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: "pointer",
};

// ---------------------------------------------------------------------------
// The two halves of an order screen, pulled out so the guest till and the
// takeout counter can share them rather than drifting apart. Neither knows
// which screen it's on: they take what to show and what to call when tapped,
// and that's all.
// ---------------------------------------------------------------------------

// The left half — the category chips and the grid of tiles.
function MenuBoard({ categories, activeCategoryId, onCategory, cart, currentAdmission, onPick, onSponsor }: {
  categories: Category[];
  activeCategoryId: number | null;
  onCategory: (id: number | null) => void;
  cart: Cart;
  // The entry charge already on the tab, so the matching tile can say "applied".
  // Always null on a takeout order — there's no admission to have applied.
  currentAdmission: { description: string } | null;
  onPick: (item: MenuItem, category: Category) => void;
  // "Pay for this entry from someone else's pass." Absent on the takeout
  // board, where there's no guest and no pass to spend.
  onSponsor?: (item: MenuItem) => void;
}) {
  // Show every category, or just the one whose filter chip is selected.
  const shownCategories = activeCategoryId === null
    ? categories
    : categories.filter((c) => c.id === activeCategoryId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {[{ id: null as number | null, name: "All" }, ...categories].map((c) => {
          const on = c.id === activeCategoryId;
          return (
            <div
              key={c.id ?? "all"}
              onClick={() => onCategory(c.id)}
              style={{ padding: "9px 16px", borderRadius: 11, border: `1.5px solid ${on ? "#7a6a53" : "#d8cebc"}`, background: on ? "#7a6a53" : "#fffdf9", color: on ? "#fffdf9" : "#5f5340", fontSize: 13, fontWeight: 800, cursor: "pointer" }}
            >
              {c.name}
            </div>
          );
        })}
      </div>

      {shownCategories.map((category) => (
        <div key={category.id} style={{ ...PANEL, padding: "16px 18px" }}>
          <div style={{ ...LABEL, marginBottom: 12 }}>
            {category.name}
            {category.isAdmission && (
              <span style={{ color: "#b8ab97", letterSpacing: .6, marginLeft: 8 }}>
                · swaps the entry charge
              </span>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {/* Only items marked available — that's the "86 it" switch
                on the Menu screen, for when the kitchen runs out. */}
            {category.items.filter((item) => item.available).map((item) => {
              const isSwap = category.isAdmission && item.visitCredits === 0;
              const qty = cart[`m${item.id}`]?.qty ?? 0;
              // An entry charge is matched by NAME, since the tab stores
              // the description rather than a link back to the menu.
              const applied = isSwap && currentAdmission?.description === item.name;
              // A tile is highlighted either because it's in the cart or
              // because it's the entry charge already on the tab.
              const lit = qty > 0 || applied;
              return (
                <div
                  key={item.id}
                  className="pos-tile"
                  onClick={() => onPick(item, category)}
                  title={item.description ?? ""}
                  style={{ border: `1.5px solid ${lit ? "#7a6a53" : "rgba(43,38,32,.09)"}`, background: lit ? "#f7f3ea" : "#fffdf9", borderRadius: 13, padding: "12px 13px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 6, minHeight: 80, justifyContent: "space-between" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    {item.imageData && (
                      <img src={item.imageData} alt="" style={{ width: 34, height: 34, flex: "none", borderRadius: 8, objectFit: "cover" }} />
                    )}
                    <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.25 }}>{item.name}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    {/* A discount has no price. Show what it takes off instead,
                        so staff can tell a 20% tile from a $5 one at a glance. */}
                    <span style={{ fontSize: 13, fontWeight: 800, color: item.discountKind ? "#8f3f28" : "#7a6a53" }}>
                      {item.discountKind
                        ? item.discountKind === "PERCENT"
                          ? `${item.discountValue}% off`
                          : `−${money(item.discountValue)}`
                        : money(item.price)}
                    </span>
                    {/* So nobody stands waiting on a kitchen that isn't cooking
                        this. Only appears where it's a surprise: a food or drink
                        tile that won't print a ticket. */}
                    {category.isKitchen && !item.sendsToKitchen && (
                      <span style={{ fontSize: 10, fontWeight: 800, color: "#8a7f6d", background: "#efe8db", borderRadius: 20, padding: "2px 7px", letterSpacing: 0.3 }}>
                        self-serve
                      </span>
                    )}
                    {qty > 0 && (
                      <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", background: "#7a6a53", borderRadius: 20, padding: "2px 9px" }}>
                        {qty}
                      </span>
                    )}
                    {applied && (
                      <span style={{ fontSize: 10.5, fontWeight: 800, color: "#3f5540", background: "#dfeada", borderRadius: 20, padding: "2px 9px" }}>
                        applied
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {category.items.length === 0 && (
              <div style={{ fontSize: 13, color: "#a89a86", fontWeight: 600 }}>Nothing in this category yet.</div>
            )}
          </div>

          {/* SPONSORED PASS. Sits under the admission tiles rather than being
              one of them, because it isn't a different kind of entry — it's the
              same pass admission, paid out of a different person's balance.
              Making it a tile would have meant a second menu item that behaved
              identically, and staff having to know which was which.
              Only shown where a pass admission actually exists to sponsor. */}
          {category.isAdmission && onSponsor && (() => {
            const passItem = category.items.find((i) => i.available && i.redeemsPass && i.visitCredits === 0);
            if (!passItem) return null;
            return (
              <div
                onClick={() => onSponsor(passItem)}
                style={{ marginTop: 10, padding: "10px 13px", border: "1.5px dashed #d8cebc", borderRadius: 11, cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: "#7a6a53", textAlign: "center" }}
              >
                Sponsored pass — use someone else's balance…
              </div>
            );
          })()}
        </div>
      ))}
    </div>
  );
}

// The right half — the running cart, its quantity steppers and its totals.
// Everything BELOW the total line is passed in as `children`, because that's the
// only part the two screens disagree about: the guest till adds to a tab and
// walks to checkout, the takeout counter takes the money there and then.
function CartPanel({ lines, onBump, onNote, onClear, subtotal, tax, children }: {
  lines: CartLine[];
  onBump: (line: Omit<CartLine, "qty">, delta: number) => void;
  onNote: (id: string, note: string) => void;
  onClear: () => void;
  subtotal: number;
  tax: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ ...PANEL, overflow: "hidden", position: "sticky", top: 20 }}>
      <div style={{ padding: "15px 18px", borderBottom: "1px solid rgba(43,38,32,.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={LABEL}>This order</div>
        {lines.length > 0 && (
          <div onClick={onClear} style={{ fontSize: 11.5, fontWeight: 700, color: "#a89a86", cursor: "pointer" }}>
            Clear
          </div>
        )}
      </div>

      {lines.length === 0 && (
        <div style={{ padding: "30px 20px", textAlign: "center", fontSize: 13.5, fontWeight: 600, color: "#b8ab97" }}>
          Tap menu items to build the order.
        </div>
      )}

      {lines.map((line) => (
        <div key={line.id} style={{ padding: "11px 16px", borderBottom: "1px solid rgba(43,38,32,.05)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.2 }}>{line.name}</div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a89a86" }}>
                {money(line.price)} each{line.isKitchen ? (line.station === "BAR" ? " · bar" : " · kitchen") : ""}
                {line.visitCredits > 0 ? ` · +${line.visitCredits} passes` : ""}
              </div>
            </div>
            <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 7 }}>
              <div
                onClick={() => onBump(line, -1)}
                style={{ width: 24, height: 24, borderRadius: 7, border: "1.5px solid #d8cebc", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, color: "#7a6a53", cursor: "pointer", lineHeight: 1 }}
              >
                −
              </div>
              <div style={{ minWidth: 16, textAlign: "center", fontSize: 13.5, fontWeight: 800 }}>{line.qty}</div>
              <div
                onClick={() => onBump(line, 1)}
                style={{ width: 24, height: 24, borderRadius: 7, border: "1.5px solid #d8cebc", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, color: "#7a6a53", cursor: "pointer", lineHeight: 1 }}
              >
                +
              </div>
            </div>
            <div style={{ flex: "none", width: 56, textAlign: "right", fontSize: 13.5, fontWeight: 800 }}>
              {money(line.price * line.qty)}
            </div>
          </div>
          {/* Only things somebody makes get a note box — there's nothing to
              tell anyone about a towel. The note travels with the item onto
              the ticket, and the wording follows the board it's headed for. */}
          {line.isKitchen && (
            <input
              className="cd-in"
              placeholder={line.station === "BAR" ? "Note for the bar (no ice, extra lime…)" : "Note for the kitchen (temp, allergy, prep…)"}
              value={line.note}
              onChange={(e) => onNote(line.id, e.target.value)}
              style={{ marginTop: 8, fontSize: 12.5 }}
            />
          )}
        </div>
      ))}

      <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "#6b6152" }}>
          <span>Subtotal</span><span>{money(subtotal)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "#6b6152" }}>
          <span>Tax</span><span>{money(tax)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, fontWeight: 800, paddingTop: 8, borderTop: "1px solid rgba(43,38,32,.08)" }}>
          <span>Order total</span><span>{money(subtotal + tax)}</span>
        </div>

        {children}
      </div>
    </div>
  );
}

function money(n: number) {
  // Discounts are negative, and "$-5.00" reads like a typo. Put the minus in
  // front of the whole thing — "−$5.00" — the way a receipt would.
  return n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}
function initials(first: string, last: string) {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}
function sinceLabel(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDuration(iso: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

// The "open tab" figure on the guest cards and the order screen header.
//
// This is a quick estimate: it applies one rate to the whole bill. The
// Checkout screen instead adds up each charge's own frozen rate, so on a bill
// mixing rates the two differ by pennies. Checkout is the one that's binding —
// this is just a number to glance at across the room.
function billTotal(visit: Visit) {
  const subtotal = visit.bill.lineItems.reduce((sum, item) => sum + item.amount, 0);
  const tax = subtotal * visit.bill.taxRate;
  return { subtotal, tax, total: subtotal + tax };
}
// Anything anyone still owes this guest, across BOTH boards: tickets that
// aren't COMPLETE, not counting items an admin canceled.
function openKitchen(visit: Visit) {
  const orders = visit.orders
    .filter((o) => o.status !== "COMPLETE")
    .filter((o) => o.items.some((i) => !i.canceled));
  const count = orders.reduce((n, o) => n + o.items.filter((i) => !i.canceled).length, 0);
  // EVERY open ticket has to be ready, not ANY of them. A guest can now have a
  // kitchen ticket and a bar ticket at once, and with `some` the chip turned
  // green the moment the burger was up — so the desk would hand the guest their
  // food and send them away without the drink still being poured.
  const ready = orders.length > 0 && orders.every((o) => o.status === "READY");
  return { count, ready };
}
// The little coloured pills on a guest card: their notes (allergies, warnings)
// in red, and how much food they're waiting on — green once it's ready to
// collect, so the desk can tell them.
function chipsFor(visit: Visit) {
  const chips: { key: string; label: string; ink: string; bg: string }[] = [];
  const notes = visit.customer.notes;
  if (notes) {
    chips.push({
      key: "notes",
      label: notes.length > 34 ? `${notes.slice(0, 34)}…` : notes,
      ink: "#8f3f28",
      bg: "#f7e4dc",
    });
  }
  const kitchen = openKitchen(visit);
  if (kitchen.count > 0) {
    chips.push(
      kitchen.ready
        ? { key: "kitchen", label: `Order ready · ${kitchen.count}`, ink: "#3f5540", bg: "#dfeada" }
        // Not "In kitchen" any more — the count can include drinks the bar is
        // pouring, and this one chip covers both boards.
        : { key: "kitchen", label: `Being made · ${kitchen.count}`, ink: "#7a6a53", bg: "#efe7d9" }
    );
  }
  return chips;
}

function Chip({ label, ink, bg }: { label: string; ink: string; bg: string }) {
  return (
    <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: .4, color: ink, background: bg, padding: "3px 9px", borderRadius: 20 }}>
      {label}
    </span>
  );
}

function PointOfSale() {
  // ---- what the server told us ----
  const [visits, setVisits] = useState<Visit[]>([]);        // everyone checked in
  const [lockers, setLockers] = useState<Locker[]>([]);     // for moving a guest
  const [categories, setCategories] = useState<Category[]>([]);  // the menu
  const [defaultTaxRate, setDefaultTaxRate] = useState(0.13);    // for custom charges

  // ---- what's on screen right now ----
  const [selectedVisitId, setSelectedVisitId] = useState<number | null>(null);
  const [checkoutVisit, setCheckoutVisit] = useState<Visit | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);      // guard, see below
  const [cart, setCart] = useState<Cart>({});               // the unconfirmed order
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null);
  const [justAdded, setJustAdded] = useState(false);        // the green "Added ✓" flash
  const [customOpen, setCustomOpen] = useState(false);      // the custom-charge form
  // ---- takeout ----
  // `takeoutOpen` is a fourth state for this screen, alongside the guest grid,
  // a guest's order screen and checkout. `done` holds the just-finished sale so
  // the counter can read the ticket number out loud before clearing it.
  const [takeoutOpen, setTakeoutOpen] = useState(false);
  const [takeoutName, setTakeoutName] = useState("");
  const [takeoutPaying, setTakeoutPaying] = useState(false);
  // Same idea as takeoutPaying, for the guest till: true while the add-to-tab
  // request is in the air, so a second tap can't send the order twice.
  //
  // TWO of them, and the ref is the one that actually guards. State is not
  // enough on its own: two taps in the same tick both run against the same
  // render, where `addingToTab` is still false — setAddingToTab schedules an
  // update, it doesn't change the value this closure already captured. A ref
  // changes the instant it's assigned, so the second call sees it. Tested: with
  // state alone, a double-tap still put two teas on the bill.
  //
  // The state is still needed — it's what re-renders the button into its
  // disabled "…" form. The ref can't do that; refs don't trigger a redraw.
  const addingToTabRef = useRef(false);
  const [addingToTab, setAddingToTab] = useState(false);
  const [takeoutDone, setTakeoutDone] = useState<{ number: number; total: number } | null>(null);
  const [customName, setCustomName] = useState("");
  const [customAmount, setCustomAmount] = useState("");
  const [newLockerId, setNewLockerId] = useState("");       // chosen in "Move locker…"

  // Bumped once a minute purely to redraw the "in for 2h 05m" labels.
  const [, setTick] = useState(0);

  // Read "?locker=M07" off the address. CustomerDirectory.tsx puts it there
  // when staff press "Check out {name}" — it's how one screen hands a specific
  // guest to this one. It also pre-fills the search box, so if the auto-open
  // below misses, staff still land on a filtered list.
  const [searchParams] = useSearchParams();
  const lockerParam = searchParams.get("locker") ?? "";
  const [query, setQuery] = useState(lockerParam);

  // Cards or a list. Cards read nicely at a handful of guests; on a busy day
  // they push everyone off the bottom of the screen and a list is far quicker
  // to scan.
  //
  // The choice is kept in localStorage, the small notepad the browser keeps per
  // site, so a terminal stays on whichever view it was left on — including
  // tomorrow. It's per terminal, so a busy front desk can sit on the list while
  // another screen keeps the cards. To make it always start on cards instead,
  // delete the localStorage lines and use useState<"cards" | "list">("cards").
  // Summons the manager-password box. Only discounts need it on this screen —
  // an admin gets "" straight back and is never prompted.
  const askOverride = useOverride();
  const dialog = useDialog();

  // Which pass-admission item the sponsor picker is open for. Null when it's
  // closed; holding the item means the pick can go straight to set-admission
  // without looking it up again.
  const [sponsorFor, setSponsorFor] = useState<MenuItem | null>(null);

  // Which lounge table this order is going to, if any. Optional and reset after
  // every confirm — staff answer it per order, not once per guest.
  const [orderTableId, setOrderTableId] = useState("");
  const [tables, setTables] = useState<{ id: number; number: string; status: string }[]>([]);

  const [view, setView] = useState<"cards" | "list">(
    () => (localStorage.getItem("posView") === "list" ? "list" : "cards")
  );
  const chooseView = (next: "cards" | "list") => {
    setView(next);
    localStorage.setItem("posView", next);
  };

  const loadVisits = () => authFetch(`/visits/active`).then((r) => r.json()).then(setVisits);
  const loadLockers = () => authFetch(`/lockers`).then((r) => r.json()).then(setLockers);
  const loadMenu = () => authFetch(`/categories`).then((r) => r.json()).then(setCategories);
  // For the "run it to a table" picker. Out-of-service tables are filtered out
  // in the dropdown below rather than here, so the list stays a plain mirror.
  const loadTables = () => authFetch(`/tables`).then((r) => r.json()).then(setTables);
  const loadSettings = () =>
    authFetch(`/settings`).then((r) => r.json()).then((s) => setDefaultTaxRate(s.taxRate));

  useEffect(() => {
    loadVisits();
    loadLockers();
    loadMenu();
    loadTables();
    loadSettings();

    // Live updates from other terminals. As everywhere in this app, the
    // message contents are ignored — each one just means "go and refetch".
    // The menu gets its own handler because it changes for different reasons
    // (an admin editing prices) than the floor does.
    const refresh = () => { loadVisits(); loadLockers(); };
    socket.on("visit:checked-in", refresh);
    socket.on("visit:checked-out", refresh);
    socket.on("visit:locker-changed", refresh);
    socket.on("locker:updated", refresh);
    socket.on("bill:line-item-added", refresh);
    socket.on("orders:changed", refresh);
    socket.on("customer:updated", refresh);
    socket.on("menu:updated", loadMenu);
    socket.on("table:updated", loadTables);

    const timer = setInterval(() => setTick((t) => t + 1), 60000);

    // Tidy-up when leaving the till, so listeners and the timer don't pile up.
    return () => {
      socket.off("visit:checked-in", refresh);
      socket.off("visit:checked-out", refresh);
      socket.off("visit:locker-changed", refresh);
      socket.off("locker:updated", refresh);
      socket.off("bill:line-item-added", refresh);
      socket.off("orders:changed", refresh);
      socket.off("customer:updated", refresh);
      socket.off("menu:updated", loadMenu);
      socket.off("table:updated", loadTables);
      clearInterval(timer);
    };
  }, []);

  // Arriving from the directory's "Check out {name}" button: ?locker=M07 opens
  // that guest's order screen directly, once, as soon as the visits land.
  //
  // It has to wait for the guest list, hence its own effect. The `autoOpened`
  // flag is what makes it fire exactly once — without it, every later refresh
  // of the guest list would drag staff back to that same guest, however far
  // they'd navigated away.
  useEffect(() => {
    if (autoOpened || !lockerParam || visits.length === 0) return;
    setAutoOpened(true);
    const match = visits.find((v) => v.locker.number.toLowerCase() === lockerParam.toLowerCase());
    if (match) {
      setSelectedVisitId(match.id);
      setQuery("");
    }
  }, [visits, lockerParam, autoOpened]);

  // Reading the guest out of the live list (instead of holding a copy) means
  // every socket update repaints them, and a checkout elsewhere drops us back
  // to the grid automatically.
  const selected = visits.find((v) => v.id === selectedVisitId) ?? null;
  // The checkout screen is the exception: once payment goes through the visit
  // stops being active, so we fall back to the copy we were holding.
  const liveCheckoutVisit = checkoutVisit
    ? (visits.find((v) => v.id === checkoutVisit.id) ?? checkoutVisit)
    : null;

  // Show whatever the server objected to, and report whether it worked.
  const showError = async (res: Response) => {
    if (!res.ok) {
      const { error } = await res.json();
      await dialog.say(error, { title: "That didn't work" });
    }
    return res.ok;
  };

  // Start a takeout order. Same clearing as opening a guest — a cart left over
  // from the last person must never turn into somebody else's charges.
  const openTakeout = () => {
    setSelectedVisitId(null);
    setTakeoutOpen(true);
    setCart({});
    setActiveCategoryId(null);
    setTakeoutName("");
    setTakeoutDone(null);
    setCustomOpen(false);
  };

  const closeTakeout = () => {
    setTakeoutOpen(false);
    setCart({});
    setTakeoutName("");
    setTakeoutDone(null);
  };

  // Open a guest's order screen with everything from the last one cleared —
  // an abandoned cart must never follow staff onto the next person's tab.
  const openGuest = (id: number) => {
    setSelectedVisitId(id);
    setCart({});
    setActiveCategoryId(null);
    setJustAdded(false);
    setCustomOpen(false);
    setNewLockerId("");
  };

  // Add or remove one of something. This single function powers the menu
  // tiles, the − button and the + button: tapping a tile is bump(+1).
  // Dropping to zero removes the line entirely rather than leaving a "0 ×".
  //
  // Note it builds a COPY of the cart rather than editing the existing one.
  // That's a React rule — it spots changes by comparing before and after, so
  // altering the original in place would leave the screen showing stale
  // numbers.
  const bump = (line: Omit<CartLine, "qty">, delta: number) => {
    setJustAdded(false);
    setCart((prev) => {
      const next = { ...prev };
      const existing = next[line.id];
      const qty = (existing?.qty ?? 0) + delta;
      if (qty <= 0) delete next[line.id];
      // Keep any note already typed against this line. Re-tapping a menu tile
      // arrives here with a freshly built line whose note is "" — without this,
      // a "no peanuts" typed a moment ago would be wiped, silently, with the
      // quantity going up as if nothing happened. The − and + buttons pass the
      // live cart line instead, so their note is already right and this line
      // changes nothing for them.
      else next[line.id] = { ...line, qty, note: line.note || existing?.note || "" };
      return next;
    });
  };

  // Attach a note to a kitchen line — "extra hot", "no onions".
  const setCartNote = (id: string, note: string) => {
    setCart((prev) => {
      const line = prev[id];
      if (!line) return prev;
      return { ...prev, [id]: { ...line, note } };
    });
  };

  // Tapping a menu tile. Two completely different outcomes:
  //
  //   Entry charges (admission) don't go in the cart at all. A guest has
  //   exactly one entry charge, decided at check-in, and picking a different
  //   one REPLACES it — so this goes straight to the server. That's why those
  //   tiles say "applied" instead of showing a quantity.
  //
  //   Everything else just goes in the cart.
  const pickItem = async (item: MenuItem, category: Category) => {
    // A DISCOUNT never goes in the cart. Like admission, it goes straight to
    // the server — and for a stronger reason: the server works out the figure
    // from the real bill. If the browser sent an amount, the manager's password
    // would be approving a number the staff member had already chosen.
    if (item.discountKind) {
      if (!selected) return;
      // The guest's name goes in the label so the approvals log reads
      // "Employee discount for Tob Lerone" rather than just "discount".
      const who = `${selected.customer.firstName} ${selected.customer.lastName}`;
      const token = await askOverride(`${item.name} for ${who}`);
      if (token === null) return; // manager cancelled
      await showError(await authFetch(`/visits/${selected.id}/apply-discount`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuItemId: item.id }),
      }, token));
      loadVisits();
      return;
    }
    // Pass packs live inside the Visit category but are ordinary sales — this
    // check has to come first, or selling one would overwrite the entry charge.
    if (item.visitCredits === 0 && category.isAdmission) {
      // No guest open means we're on the takeout screen, where admission tiles
      // aren't shown at all. Belt and braces.
      if (!selected) return;
      await showError(await authFetch(`/visits/${selected.id}/set-admission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuItemId: item.id }),
      }));
      return;
    }
    bump({
      id: `m${item.id}`,
      name: item.name,
      price: item.price,
      // BOTH have to be true. The category decides whether a ticket is printed
      // at all; the item can then opt out. Nothing can opt IN — a massage with
      // sendsToKitchen somehow true still has category.isKitchen === false and
      // stays off both boards.
      isKitchen: category.isKitchen && item.sendsToKitchen,
      // And if there IS a ticket, this is the board it goes to.
      station: category.station,
      visitCredits: item.visitCredits,
      taxRate: item.taxRate,
      note: "",
    }, 1);
  };

  // A one-off charge that isn't on the menu — a replacement towel, a damage
  // fee. It has no menu item behind it, so it's taxed at the house rate.
  const addCustomCharge = (e: FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(customAmount);
    if (!customName || Number.isNaN(amount)) return;
    bump({
      // A fresh random id every time, so two custom charges never merge into
      // one line the way two taps of the same menu tile do.
      id: `c${crypto.randomUUID()}`,
      name: customName,
      price: amount,
      isKitchen: false,
      // Nothing to make, so no board. A replacement towel isn't poured.
      station: null,
      visitCredits: 0,
      taxRate: defaultTaxRate,
      note: "",
    }, 1);
    setCustomName("");
    setCustomAmount("");
    setCustomOpen(false);
  };

  // THE MOMENT IT BECOMES REAL. Everything up to here has been local to this
  // browser; this turns the cart into actual charges on the tab and, for food
  // and drink, an actual ticket on the kitchen board.
  const confirmOrder = async () => {
    // addingToTabRef is the double-tap guard. Without it, two taps inside the
    // request's round trip both get through and every item lands on the bill
    // twice — real money, silently. It has to be the REF that's tested here,
    // not the state: see the note where the two are declared.
    if (!selected || cartLines.length === 0 || addingToTabRef.current) return;
    addingToTabRef.current = true;
    setAddingToTab(true);
    try {
      // The cart says "Tea ×3", but a bill has always been one row per drink,
      // and the kitchen needs three separate things to make. So each line is
      // fanned back out into `qty` copies of itself before sending.
      const items = cartLines.flatMap((line) =>
        Array.from({ length: line.qty }, () => ({
          name: line.name,
          amount: line.price,
          isKitchen: line.isKitchen,
          station: line.station,
          visitCredits: line.visitCredits,
          taxRate: line.taxRate,
          note: line.note,
        }))
      );
      const ok = await showError(await authFetch(`/visits/${selected.id}/confirm-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Optional. Sent only when staff picked somewhere to run it.
        body: JSON.stringify({ items, tableId: orderTableId ? Number(orderTableId) : null }),
      }));
      if (!ok) return;
      // Cleared after every order, not kept. The table is answered per order,
      // so leaving the last one selected would silently send the next round to
      // a table nobody chose.
      setOrderTableId("");
      // Empty the cart and flash the button green for a couple of seconds, so
      // there's visible confirmation the tab was actually updated.
      setCart({});
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 2200);
      // Refetch so the tab total updates immediately. The server also broadcasts
      // the change, so this screen often fetches twice — harmless, and it means
      // the total is right even if the broadcast is slow.
      loadVisits();
    } finally {
      // `finally` runs whether the request succeeded, failed, or returned early
      // at the `if (!ok)` line above. Releasing the guard anywhere else would
      // leave the button dead after one failed attempt.
      addingToTabRef.current = false;
      setAddingToTab(false);
    }
  };

  // THE TAKEOUT SALE. Everything happens in this one request: the visit, the
  // bill, the charges, the kitchen ticket and the payment.
  //
  // ⚠ The object built below goes straight into JSON.stringify, so TYPESCRIPT
  // DOES NOT CHECK IT. This is the third place in the app with that hazard —
  // confirmOrder here and submitOrder in StationBoard.tsx are the other two,
  // and a missing `taxRate` in one of them is how every charge once got saved
  // at 0% tax. If you ever add a field to a charge, add it in all three by eye.
  // A clean Problems panel proves nothing about these three objects.
  //
  // The two MenuPage bodies (saveCategory, addCategory) are unchecked in the
  // same way, so five in total. Where a miss can't be made harmless, the server
  // is written to fail the NOISY way — a `station` that never arrives sends the
  // ticket to the kitchen, which somebody sees, rather than to nowhere, which
  // nobody does.
  const payTakeout = async (paymentMethod: string) => {
    if (cartLines.length === 0 || takeoutPaying) return;
    setTakeoutPaying(true);
    // Same fan-out as the till: "Tea ×3" becomes three separate entries.
    const items = cartLines.flatMap((line) =>
      Array.from({ length: line.qty }, () => ({
        name: line.name,
        amount: line.price,
        isKitchen: line.isKitchen,
        station: line.station,
        visitCredits: line.visitCredits,
        taxRate: line.taxRate,
        note: line.note,
      }))
    );
    // Read the total BEFORE clearing the cart — it's what the receipt line on
    // the confirmation panel shows.
    const total = cartSubtotal + cartTax;
    const res = await authFetch(`/takeout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, paymentMethod, name: takeoutName }),
    });
    setTakeoutPaying(false);
    if (!res.ok) {
      const { error } = await res.json();
      await dialog.say(error, { title: "That didn't work" });
      return;
    }
    const { visit } = await res.json();
    setTakeoutDone({ number: visit.takeoutNumber, total });
    setCart({});
    setTakeoutName("");
  };

  // Move a guest to a different locker mid-visit. The server frees the old one
  // and claims the new one together, so a crash can't leave both occupied.
  const changeLocker = async () => {
    if (!selected || !newLockerId) return;
    await showError(await authFetch(`/visits/${selected.id}/change-locker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lockerId: Number(newLockerId) }),
    }));
    setNewLockerId("");
  };

  // Move on to payment — but refuse while there's an unconfirmed cart, since
  // walking into checkout would silently discard it and undercharge the guest.
  const goToCheckout = async () => {
    if (!selected) return;
    if (cartLines.length > 0) {
      await dialog.say("There's an unconfirmed order on screen — add it to the tab or clear it first.");
      return;
    }
    setCheckoutVisit(selected);
  };

  // The cart's running figures, recalculated on every redraw.
  const cartLines = Object.values(cart);
  const cartCount = cartLines.reduce((n, l) => n + l.qty, 0);
  const cartSubtotal = cartLines.reduce((sum, l) => sum + l.price * l.qty, 0);
  // Every line brings its own rate now — a 0% massage next to a 13% sandwich.
  const cartTax = cartLines.reduce((sum, l) => sum + l.price * l.qty * l.taxRate, 0);

  // Filter the guest grid by name or locker number, in the browser.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? visits.filter((v) =>
        `${v.customer.firstName} ${v.customer.lastName} ${v.locker.number}`.toLowerCase().includes(q)
      )
    : visits;

  // The list is ordered by locker instead, because that's what staff are
  // usually holding when they come to look someone up — a key tag, not a name.
  // Locker numbers are zero-padded (M01, not M1) precisely so plain text
  // sorting puts them in the right order; without the padding M10 would come
  // before M2. `slice()` first because sort() rearranges the array in place,
  // and this one is the state array every other screen is reading.
  const byLocker = filtered.slice().sort((a, b) => a.locker.number.localeCompare(b.locker.number));

  const now = new Date();

  // Checkout takes over the whole page — still inside the Point of Sale tab,
  // so the sidebar highlight doesn't move.
  if (liveCheckoutVisit) {
    return (
      <Checkout
        visit={liveCheckoutVisit}
        onBack={() => setCheckoutVisit(null)}
        onDone={() => {
          setCheckoutVisit(null);
          setSelectedVisitId(null);
          loadVisits();
          loadLockers();
        }}
      />
    );
  }

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 26px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 800 }}>Point of Sale</div>
        <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600 }}>
          {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          {" · "}
          {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, background: "#eef4ea", border: "1px solid #cfe0c8", borderRadius: 20, padding: "6px 13px" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#5f7a5a" }} />
          <span style={{ fontSize: 12, fontWeight: 800, color: "#3f5540" }}>{visits.length} checked in</span>
        </div>
        {!takeoutOpen && !selected && (
          <button
            onClick={openTakeout}
            style={{ padding: "10px 18px", border: "none", borderRadius: 11, background: "#7a6a53", color: "#fffdf9", fontFamily: "inherit", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}
          >
            Takeout order
          </button>
        )}
      </div>
    </div>
  );

  // ---------------------------------------------------------------------------
  // VIEW 1 — the grid of everyone checked in. Tap a card to open their tab.
  // ---------------------------------------------------------------------------
  const listView = (
    <div style={{ padding: "22px 26px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#fffdf9", border: "1.5px solid #d8cebc", borderRadius: 14, padding: "14px 18px" }}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ flex: "none" }}>
          <circle cx="7.5" cy="7.5" r="5.5" stroke="#a89a86" strokeWidth="2" />
          <line x1="11.6" y1="11.6" x2="16" y2="16" stroke="#a89a86" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          className="pos-search"
          placeholder="Search checked-in guests by name or locker number"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div style={{ flex: "none", fontSize: 12, fontWeight: 700, color: "#a89a86" }}>
          {filtered.length} of {visits.length}
        </div>

        {/* Cards or list. Same segmented control as the one on Reports, so it
            behaves the way staff already expect that shape to behave. */}
        <div style={{ flex: "none", display: "inline-flex", background: "#e7e0d5", borderRadius: 11, padding: 3, gap: 3 }}>
          {([["cards", "Cards"], ["list", "List"]] as const).map(([id, label]) => {
            const on = view === id;
            return (
              <div
                key={id}
                onClick={() => chooseView(id)}
                style={{ padding: "7px 15px", borderRadius: 9, cursor: "pointer", fontSize: 12.5, fontWeight: 700, background: on ? "#fffdf9" : "transparent", color: on ? "#2b2620" : "#8a7d6a", boxShadow: on ? "0 1px 3px rgba(43,38,32,.12)" : "none" }}
              >
                {label}
              </div>
            );
          })}
        </div>
      </div>

      {view === "list" && filtered.length > 0 && (
        <div style={{ background: "#fffdf9", border: "1px solid rgba(43,38,32,.08)", borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 2px rgba(43,38,32,.04)" }}>
          {/* Column headings. The widths are fixed so every row lines up and
              the eye can run straight down a single column — which is the
              whole reason for having a list rather than cards. */}
          <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 150px 1fr 132px 120px", gap: 14, alignItems: "center", padding: "11px 18px", borderBottom: "1px solid rgba(43,38,32,.08)", background: "#faf6ef" }}>
            <div style={MICRO}>Locker</div>
            <div style={MICRO}>Guest</div>
            <div style={MICRO}>In since</div>
            <div style={MICRO}>Notes</div>
            <div style={MICRO}>Kitchen</div>
            <div style={{ ...MICRO, textAlign: "right" }}>Open tab</div>
          </div>

          {byLocker.map((v) => {
            const { total } = billTotal(v);
            const chips = chipsFor(v);
            // Split them apart so each lands in its own column. The note is the
            // safety-critical one — an allergy — so it gets a fixed position on
            // every row rather than shifting about depending on what else is
            // showing.
            const noteChip = chips.find((c) => c.key === "notes");
            const kitchenChip = chips.find((c) => c.key === "kitchen");
            return (
              <div
                key={v.id}
                className="pos-row"
                onClick={() => openGuest(v.id)}
                style={{ display: "grid", gridTemplateColumns: "72px 1fr 150px 1fr 132px 120px", gap: 14, alignItems: "center", padding: "13px 18px", borderTop: "1px solid rgba(43,38,32,.06)", cursor: "pointer" }}
              >
                <div style={{ fontSize: 15, fontWeight: 800, color: "#7a6a53" }}>{v.locker.number}</div>
                <div style={{ minWidth: 0, fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {v.customer.firstName} {v.customer.lastName}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#a89a86" }}>
                  {sinceLabel(v.checkInAt)} · {fmtDuration(v.checkInAt)}
                </div>
                <div style={{ minWidth: 0 }}>
                  {noteChip && <Chip label={noteChip.label} ink={noteChip.ink} bg={noteChip.bg} />}
                </div>
                <div style={{ minWidth: 0 }}>
                  {kitchenChip && <Chip label={kitchenChip.label} ink={kitchenChip.ink} bg={kitchenChip.bg} />}
                </div>
                <div style={{ textAlign: "right", fontSize: 15, fontWeight: 800 }}>{money(total)}</div>
              </div>
            );
          })}
        </div>
      )}

      {view === "cards" && (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
        {filtered.map((v) => {
          const { total } = billTotal(v);
          return (
            <div
              key={v.id}
              className="pos-card"
              onClick={() => openGuest(v.id)}
              style={{ background: "#fffdf9", border: "1.5px solid rgba(43,38,32,.09)", borderRadius: 16, padding: "17px 18px", cursor: "pointer", boxShadow: "0 1px 2px rgba(43,38,32,.04)" }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 13 }}>
                <div style={{ width: 42, height: 42, flex: "none", borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#7a6a53" }}>
                  {initials(v.customer.firstName, v.customer.lastName)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.2 }}>
                    {v.customer.firstName} {v.customer.lastName}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#a89a86", marginTop: 2 }}>
                    In since {sinceLabel(v.checkInAt)} · {fmtDuration(v.checkInAt)}
                  </div>
                </div>
                <div style={{ flex: "none", textAlign: "right" }}>
                  <div style={MICRO}>Locker</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#7a6a53", lineHeight: 1.1 }}>{v.locker.number}</div>
                </div>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12, minHeight: 22 }}>
                {chipsFor(v).map((c) => (
                  <Chip key={c.key} label={c.label} ink={c.ink} bg={c.bg} />
                ))}
              </div>

              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(43,38,32,.07)" }}>
                <div>
                  <div style={MICRO}>Open tab</div>
                  <div style={{ fontSize: 19, fontWeight: 800 }}>{money(total)}</div>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "#7a6a53" }}>Add items →</div>
              </div>
            </div>
          );
        })}
      </div>
      )}

      {filtered.length === 0 && (
        <div style={{ padding: 34, textAlign: "center", fontSize: 14, fontWeight: 600, color: "#a89a86", background: "#fffdf9", border: "1px dashed #d8cebc", borderRadius: 16 }}>
          {query ? `No checked-in guest matches “${query}”.` : "Nobody is checked in right now."}
        </div>
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // VIEW 3 — takeout. The same board and cart as a guest's order screen, but
  // paid on the spot instead of added to a tab.
  //
  // Admission categories are filtered out entirely. That removes both the entry
  // charges (a takeout customer isn't coming in) and the pass packs that live
  // inside those categories (there's no profile to credit them to). The server
  // refuses pass packs too — this just means staff never see a tile that would
  // be rejected.
  // ---------------------------------------------------------------------------
  const takeoutView = !takeoutOpen ? null : (
    <div style={{ padding: "18px 26px 26px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        onClick={closeTakeout}
        style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: "#7a6a53", cursor: "pointer", width: "fit-content" }}
      >
        ← Back to guests
      </div>

      {/* The confirmation panel. It replaces the whole screen after payment so
          the number is impossible to miss, and it's the only way back out —
          which stops staff wandering off before reading it to the customer. */}
      {takeoutDone ? (
        <div style={{ ...PANEL, padding: "44px 30px", textAlign: "center" }}>
          <div style={{ ...LABEL, color: "#5f7a5a" }}>Paid · {money(takeoutDone.total)}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#6b6152", marginTop: 18 }}>Order number</div>
          <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1, color: "#7a6a53", marginTop: 6 }}>
            {takeoutDone.number}
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "#a89a86", marginTop: 14 }}>
            On the board now. Give this number to the customer.
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 26 }}>
            <button
              onClick={openTakeout}
              style={{ padding: "13px 26px", border: "none", borderRadius: 12, background: "#7a6a53", color: "#fffdf9", fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: "pointer" }}
            >
              Another takeout order
            </button>
            <button onClick={closeTakeout} style={BTN_GHOST}>Done</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 16, alignItems: "start" }}>
          <MenuBoard
            categories={categories.filter((c) => !c.isAdmission)}
            activeCategoryId={activeCategoryId}
            onCategory={setActiveCategoryId}
            cart={cart}
            currentAdmission={null}
            onPick={pickItem}
          />

          <CartPanel
            lines={cartLines}
            onBump={bump}
            onNote={setCartNote}
            onClear={() => setCart({})}
            subtotal={cartSubtotal}
            tax={cartTax}
          >
            <input
              className="cd-in"
              placeholder="Name for the order (optional)"
              value={takeoutName}
              onChange={(e) => setTakeoutName(e.target.value)}
              style={{ marginTop: 4 }}
            />
            <div style={{ fontSize: 11.5, fontWeight: 600, color: "#b8ab97", marginTop: -2 }}>
              Printed on the ticket next to the order number.
            </div>

            {/* No "add to tab" here — paying IS confirming. The kitchen hears
                nothing until one of these is pressed. */}
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              {["CASH", "CARD"].map((m) => (
                <button
                  key={m}
                  onClick={() => payTakeout(m)}
                  disabled={cartLines.length === 0 || takeoutPaying}
                  style={{ flex: 1, padding: 14, border: "none", borderRadius: 12, fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: cartLines.length === 0 || takeoutPaying ? "default" : "pointer", background: cartLines.length > 0 && !takeoutPaying ? "#7a6a53" : "#e2dacb", color: cartLines.length > 0 && !takeoutPaying ? "#fff" : "#b8ab97" }}
                >
                  {takeoutPaying ? "…" : m === "CASH" ? "Pay cash" : "Pay card"}
                </button>
              ))}
            </div>
          </CartPanel>
        </div>
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // VIEW 2 — one guest's order screen: menu on the left, cart on the right.
  // ---------------------------------------------------------------------------
  const orderView = !selected ? null : (() => {
    const visit = selected;
    const tab = billTotal(visit);
    // Which entry charge is currently on their tab — used to put the "applied"
    // badge on the matching admission tile.
    const currentAdmission = visit.bill.lineItems.find((li) => li.isAdmission) ?? null;
    // Only free lockers from this guest's own pool can be moved into.
    const availableLockers = lockers.filter(
      (l) => l.gender === visit.customer.gender && l.status === "AVAILABLE"
    );

    return (
      <div style={{ padding: "18px 26px 26px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          onClick={() => setSelectedVisitId(null)}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: "#7a6a53", cursor: "pointer", width: "fit-content" }}
        >
          ← All checked-in guests
        </div>

        {/* guest strip */}
        <div style={{ ...PANEL, display: "flex", alignItems: "center", gap: 14, padding: "16px 20px", flexWrap: "wrap" }}>
          <div style={{ width: 48, height: 48, flex: "none", borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "#7a6a53" }}>
            {initials(visit.customer.firstName, visit.customer.lastName)}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
              <div style={{ fontSize: 19, fontWeight: 800 }}>
                {visit.customer.firstName} {visit.customer.lastName}
              </div>
              {chipsFor(visit).map((c) => (
                <Chip key={c.key} label={c.label} ink={c.ink} bg={c.bg} />
              ))}
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "#a89a86", marginTop: 2 }}>
              Locker {visit.locker.number} · in since {sinceLabel(visit.checkInAt)} · {fmtDuration(visit.checkInAt)}
              {visit.redeemsPass ? " · on a pass" : ""}
              {visit.customer.visitPassBalance > 0 ? ` · ${visit.customer.visitPassBalance} passes left` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
            <select className="cd-in" value={newLockerId} onChange={(e) => setNewLockerId(e.target.value)} style={{ width: 150 }}>
              <option value="">Move locker…</option>
              {availableLockers.map((l) => (
                <option key={l.id} value={l.id}>{l.number}</option>
              ))}
            </select>
            <button onClick={changeLocker} style={BTN_GHOST}>Move</button>
          </div>
          <div style={{ flex: "none", textAlign: "right", minWidth: 110 }}>
            <div style={MICRO}>Open tab</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{money(tab.total)}</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 16, alignItems: "start" }}>
          {/* menu */}
          <MenuBoard
            categories={categories}
            activeCategoryId={activeCategoryId}
            onCategory={setActiveCategoryId}
            cart={cart}
            currentAdmission={currentAdmission}
            onPick={pickItem}
            // Only the guest till gets this — the takeout board above passes
            // no onSponsor, because a takeout order has no guest and no pass.
            onSponsor={(item) => setSponsorFor(item)}
          />

          {/* cart */}
          <CartPanel
            lines={cartLines}
            onBump={bump}
            onNote={setCartNote}
            onClear={() => setCart({})}
            subtotal={cartSubtotal}
            tax={cartTax}
          >
            {/* WHERE TO RUN IT. Optional, and only on the guest till — the
                takeout board above never renders this, because a takeout order
                is collected at the counter rather than carried anywhere.
                Only shown when the cart has something somebody has to make —
                a drink counts, so a round of beers can still be run to a table;
                a towel and a bottled water need no table. */}
            {cartLines.some((l) => l.isKitchen) && (
              <div style={{ marginTop: 8 }}>
                <div style={MICRO}>Run it to (optional)</div>
                <select
                  className="cd-in"
                  value={orderTableId}
                  onChange={(e) => setOrderTableId(e.target.value)}
                  style={{ width: "100%", marginTop: 5 }}
                >
                  <option value="">Their locker</option>
                  {/* Out-of-service tables are left out — the server refuses
                      them anyway, so offering one would only be a dead end. */}
                  {tables
                    .filter((t) => t.status !== "MAINTENANCE")
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        Table {t.number}{t.status === "OCCUPIED" ? " · in use" : ""}
                      </option>
                    ))}
                </select>
              </div>
            )}

            <button
              onClick={confirmOrder}
              disabled={cartLines.length === 0 || addingToTab}
              style={{ marginTop: 8, textAlign: "center", padding: 14, border: "none", borderRadius: 12, fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: cartLines.length === 0 || addingToTab ? "default" : "pointer", background: justAdded ? "#5f7a5a" : cartLines.length > 0 && !addingToTab ? "#7a6a53" : "#e2dacb", color: justAdded || (cartLines.length > 0 && !addingToTab) ? "#fff" : "#b8ab97" }}
            >
              {justAdded
                ? "Added to tab ✓"
                : addingToTab
                  ? "…"
                  : cartLines.length > 0
                    ? `Add ${cartCount} item${cartCount === 1 ? "" : "s"} to tab`
                    : "Add to tab"}
            </button>

            {customOpen ? (
              <form onSubmit={addCustomCharge} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <input className="cd-in" placeholder="Custom charge" value={customName} onChange={(e) => setCustomName(e.target.value)} />
                <input className="cd-in" placeholder="Amount" type="number" step="0.01" value={customAmount} onChange={(e) => setCustomAmount(e.target.value)} />
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="submit" style={{ ...BTN_GHOST, flex: 1 }}>Add to order</button>
                  <button type="button" onClick={() => setCustomOpen(false)} style={BTN_GHOST}>Cancel</button>
                </div>
              </form>
            ) : (
              <div
                onClick={() => setCustomOpen(true)}
                style={{ textAlign: "center", fontSize: 12.5, fontWeight: 700, color: "#a89a86", cursor: "pointer" }}
              >
                + Custom charge
              </div>
            )}

            <button
              onClick={goToCheckout}
              style={{ textAlign: "center", padding: 12, border: "1.5px solid #d8cebc", borderRadius: 12, background: "#fffdf9", color: "#5f5340", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}
            >
              Go to checkout →
            </button>
          </CartPanel>
        </div>
      </div>
    );
  })();

  // Header always; below it the order screen if a guest is open, else the grid.
  // (The third state, Checkout, returned earlier and never reaches this.)
  return (
    <div style={{ background: "#f4efe7", minHeight: "100vh" }}>
      {header}
      {takeoutOpen ? takeoutView : selected ? orderView : listView}

      {/* Picking a sponsor swaps the entry charge to the pass admission and
          records whose balance it comes from. Nothing is deducted here — that
          waits for check-out, same as every other pass. */}
      {sponsorFor && selected && (
        <SponsorPicker
          onCancel={() => setSponsorFor(null)}
          onPick={async (c) => {
            const item = sponsorFor;
            setSponsorFor(null);
            await showError(await authFetch(`/visits/${selected.id}/set-admission`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ menuItemId: item.id, passSponsorId: c.id }),
            }));
            loadVisits();
          }}
        />
      )}
    </div>
  );
}

export default PointOfSale;
