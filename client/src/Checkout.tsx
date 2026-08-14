// ============================================================================
// CHECKOUT — settle the tab, take the money, release the locker.
//
// WHAT IT IS
//   The last step of a visit. It shows the itemised bill, takes a payment
//   method, and on "Complete Checkout" closes everything out at once: the
//   visit ends, the locker goes back in the pool, and the bill is stamped
//   paid. Then it swaps to a green confirmation with a receipt button.
//
// WHERE IT'S USED
//   Rendered by client/src/PointOfSale.tsx, which is its ONLY parent — it has
//   no address of its own. That's deliberate: staying inside /pos keeps the
//   sidebar's "Point of Sale" tab highlighted, so staff never feel like
//   they've left the till.
//
//   It receives three things from PointOfSale:
//     visit  — the guest and their tab
//     onBack — go back to the order screen
//     onDone — finished; close this and return to the guest grid
//
//   It has no socket connection of its own, yet the bill still updates live.
//   That's because PointOfSale re-reads the visit from its own live list on
//   every update and hands the fresh copy back down.
//
// WHAT IT TALKS TO   (all in server/src/index.ts)
//   GET    /login-roster                      → the "on shift" avatars
//   DELETE /bills/:billId/line-items/:id      → void one charge (admin only)
//   POST   /check-out                         → close the visit and take payment
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { authFetch } from "./authFetch.ts";
import { useOverride } from "./OverrideProvider.tsx";
import { useDialog } from "./DialogProvider.tsx";
import { type BillLineItem, type Visit } from "./types.ts";

type RosterEntry = { username: string; displayName: string; role: string };

// A snapshot taken at the moment of payment, for the green confirmation
// screen. It has to be a copy: the instant checkout succeeds the guest stops
// being "active", so the live data behind this screen disappears.
type Paid = { total: number; method: string; name: string; locker: string; gender: string; billId: number };

// Three separate $6 teas on the bill are one "Tea ×3" row here. The underlying
// charge ids come along for the ride so voiding can delete exactly one of them.
type BillRow = {
  key: string;
  description: string;
  unit: number;
  qty: number;
  amount: number;
  isAdmission: boolean;
  // What these charges cost before staff adjusted the price, or null if
  // nobody has. Carried through so the row can say "was $6.00".
  originalAmount: number | null;
  ids: number[];
};

// Squash a bill's individual charges into readable rows.
//
// This is the exact reverse of what PointOfSale does when confirming an order:
// there, "Tea ×3" was fanned out into three separate charges. Here they're
// gathered back up for display. The charges themselves stay separate in the
// database — this is presentation only.
function groupBill(items: BillLineItem[]): BillRow[] {
  const rows = new Map<string, BillRow>();
  for (const item of items) {
    // Charges merge only if the name, the price AND the admission flag all
    // match. Two teas at different prices stay on separate rows, because they
    // were sold at different prices and the bill should say so.
    //
    // The old price is in the key too, so a tea comped down to $0 doesn't fold
    // in with one that was $0 all along — only one of those two has a story to
    // tell, and the row has to know which.
    const key = `${item.description}|${item.amount}|${item.isAdmission}|${item.originalAmount}`;
    const row = rows.get(key);
    if (row) {
      row.qty += 1;
      row.amount += item.amount;
      row.ids.push(item.id);
    } else {
      rows.set(key, {
        key,
        description: item.description,
        unit: item.amount,
        qty: 1,
        amount: item.amount,
        isAdmission: item.isAdmission,
        originalAmount: item.originalAmount,
        ids: [item.id],
      });
    }
  }
  return Array.from(rows.values());
}

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
function fmtDuration(iso: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}
function poolName(gender: string) {
  return gender === "MALE" ? "men's" : "women's";
}

const PANEL: React.CSSProperties = {
  background: "#fffdf9",
  border: "1px solid rgba(43,38,32,.08)",
  borderRadius: 16,
  boxShadow: "0 1px 2px rgba(43,38,32,.04)",
};
const LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1.5,
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
// Item · Qty · Amount · the buttons. The last column holds two of them while
// the screen is in adjusting mode, which is what sets its width.
const ROW = "1fr 60px 100px 152px";

// The two ways guests can pay at the desk. The database knows about gift cards
// and visit passes too, but those aren't chosen here — a pass is applied at
// check-in and shows as a note rather than a payment button.
const METHODS = [
  { id: "CASH", label: "Cash" },
  { id: "CARD", label: "Card" },
];

function Checkout({ visit, onBack, onDone }: { visit: Visit; onBack: () => void; onDone: () => void }) {
  const [method, setMethod] = useState("CARD");     // card is the common case
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [paid, setPaid] = useState<Paid | null>(null);   // null until money is taken
  const [adjusting, setAdjusting] = useState(false); // are the per-row buttons showing
  const [toast, setToast] = useState<string | null>(null);

  // Guards against a double-tap on "Complete Checkout" charging twice. It's
  // switched on before the request and off after, and the button obeys it.
  const [busy, setBusy] = useState(false);

  const [fresh, setFresh] = useState<number[]>([]);  // rows to flash green
  const [, setTick] = useState(0);                   // 30s clock, for the duration label

  // useRef is a box that survives redraws WITHOUT causing one. Handy for
  // things the screen doesn't display:
  //   seenIds — every charge id we've already shown, so a new arrival stands out
  //   the two timers — so a second one can cancel the first
  const seenIds = useRef<Set<number>>(new Set(visit.bill.lineItems.map((i) => i.id)));
  const freshTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);

  // Voiding a charge is admin-only. Staff see the button but get a polite
  // refusal; the server rejects it regardless of what this says.
  const user = JSON.parse(localStorage.getItem("user") ?? "null");
  // Still used, but only for wording now — it no longer decides who may void.
  // That question moved to the server, which accepts either an admin login or
  // a manager's approval.
  const isAdmin = user?.role === "ADMIN";
  const askOverride = useOverride();
  const dialog = useDialog();

  // Set while a void or a price change is mid-flight. The boxes are drawn by
  // the app now rather than by the browser; the browser's version froze
  // everything until answered, which quietly meant a second tap couldn't land.
  // It can now, and two taps on one row would void the same charge twice.
  //
  // One ref covers both actions on purpose — half-way through changing a price
  // is no time to also be voting on voiding something.
  const rowBusy = useRef(false);

  // THE MANAGER'S APPROVAL, held for as long as this screen is open.
  //
  // Asked for ONCE, when "Adjust an item" is tapped, rather than again for
  // every charge. A guest with four things to comp meant a manager standing at
  // the terminal typing their password four times; now they unlock the bill and
  // walk away. Same trick Reports and the Menu screen use to open themselves.
  //
  // Three possible values, and the middle one is what keeps the call sites
  // short: a long string means a manager approved it, "" means an admin is
  // signed in and needs no approval, and null means locked.
  const [approval, setApproval] = useState<string | null>(isAdmin ? "" : null);

  // The approval only lasts a few minutes on the server. When it lapses
  // mid-edit the screen locks itself again and says so, rather than silently
  // refusing every tap from then on.
  const lapsed = async (res: Response) => {
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 && body.needsOverride) {
      setApproval(isAdmin ? "" : null);
      setAdjusting(false);
      await dialog.say("That approval has run out. Tap Adjust an item to ask again.", {
        title: "Approval expired",
      });
      return true;
    }
    await dialog.say(body.error, { title: "That didn't work" });
    return false;
  };

  // Turning the mode on is where the password is asked for. Turning it off
  // deliberately KEEPS the approval: a staff member who taps Done and then
  // spots one more thing shouldn't have to fetch the manager back.
  const toggleAdjusting = async () => {
    if (adjusting) {
      setAdjusting(false);
      return;
    }
    if (approval === null) {
      const token = await askOverride(`Adjust charges on ${visit.customer.firstName}'s bill`, "PAGE");
      if (token === null) return; // cancelled — stay locked
      setApproval(token);
    }
    setAdjusting(true);
  };

  useEffect(() => {
    authFetch(`/login-roster`).then((r) => r.json()).then(setRoster);
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  // Runs after every render: anything on the bill we haven't seen before just
  // arrived (usually the kitchen, or another terminal) — flash it green.
  //
  // This is the one effect in the app with NO list in brackets at the end,
  // which is what makes it run every single time rather than once. That's
  // intentional: it needs to notice a new charge the instant the bill changes,
  // whatever caused the change. The `seenIds` box is what stops it flashing
  // the same row twice.
  //
  // Why it matters: staff can be standing at the till taking payment while a
  // waiter rings a drink through on another terminal. Without this, the total
  // would quietly change under their hands. The green flash makes it visible.
  useEffect(() => {
    const added = visit.bill.lineItems.filter((i) => !seenIds.current.has(i.id)).map((i) => i.id);
    visit.bill.lineItems.forEach((i) => seenIds.current.add(i.id));
    if (added.length === 0) return;
    setFresh(added);
    if (freshTimer.current) clearTimeout(freshTimer.current);
    freshTimer.current = window.setTimeout(() => setFresh([]), 2400);
  });

  // A message that slides up from the bottom and fades after a few seconds.
  // Clearing the previous timer first stops an earlier message from cutting a
  // later one short.
  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  };

  // What the guest would save by paying cash — or null if they'd save nothing,
  // which is the usual answer.
  //
  // The number comes from the server, and that's deliberate. It's the same
  // function that writes the real charge at check-out, so what the staff member
  // reads out and what lands on the bill cannot drift apart. Working it out
  // here from a copy of the rules is how this project once shipped a screen
  // full of charges at 0% tax.
  //
  // Nothing is written yet. Tapping Cash is not paying, so the discount stays a
  // preview until the money is actually taken.
  const [cashDiscount, setCashDiscount] = useState<{ description: string; amount: number; taxRate: number } | null>(null);

  // Re-asked whenever the charges change, not just once. The bill moves under
  // this screen all the time: the kitchen adds a drink, another terminal swaps
  // the entry charge for a pass — and a swap to a pass takes the discount away.
  const lineItemsKey = visit.bill.lineItems.map((i) => `${i.id}:${i.amount}`).join(",");
  useEffect(() => {
    let abandoned = false;
    authFetch(`/visits/${visit.id}/cash-discount`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!abandoned) setCashDiscount(d); })
      // A failed lookup shows no discount rather than a guessed one. The server
      // still applies the real thing at checkout either way.
      .catch(() => { if (!abandoned) setCashDiscount(null); });
    // Stops a slow reply from an old bill overwriting a newer one.
    return () => { abandoned = true; };
  }, [visit.id, lineItemsKey]);

  // Only cash earns it. Switching to Card puts the full price straight back,
  // with no round trip, because the figure was already fetched.
  const discount = method === "CASH" ? cashDiscount : null;

  // The figures being charged. This is the authoritative version: tax is added
  // up per charge using each one's own frozen rate, so a 0% massage and a 13%
  // sandwich on the same tab are both handled correctly. (The guest cards on
  // the previous screen use a rougher single-rate estimate.)
  //
  // The discount joins in as though it were already a charge — a negative one
  // carrying the entry charge's own tax rate — which is exactly what it becomes
  // a moment later. That's what keeps this total and the printed receipt equal.
  const rows = groupBill(visit.bill.lineItems);
  const subtotal =
    visit.bill.lineItems.reduce((sum, i) => sum + i.amount, 0) + (discount?.amount ?? 0);
  const tax =
    visit.bill.lineItems.reduce((sum, i) => sum + i.amount * i.taxRate, 0) +
    (discount ? discount.amount * discount.taxRate : 0);
  const total = subtotal + tax;

  // A charge counts as a kitchen item if the kitchen was ever sent something
  // by that name on this visit — that's what puts the "Kitchen" chip on the row.
  const kitchenNames = new Set(
    visit.orders.flatMap((o) => o.items.filter((i) => !i.canceled).map((i) => i.name))
  );

  // Remove ONE of a row — void a single mistaken tea from "Tea ×3", not all
  // three. This is why groupBill kept every underlying id: the row on screen
  // is a summary, but the deletion has to name one specific charge.
  //
  // The server refuses in several cases: an already-paid bill, the entry
  // charge, or a pass pack whose passes have already been used.
  const voidOne = async (row: BillRow) => {
    if (rowBusy.current) return;
    const id = row.ids[row.ids.length - 1]; // the most recently rung-up one
    rowBusy.current = true;
    try {
      const yes = await dialog.confirm(
        `Void one "${row.description}" (${money(row.unit)}) from this bill?`,
        { title: "Void a charge", confirmLabel: "Void one", danger: true }
      );
      if (!yes) return;
      // No password box here any more — the approval was given once, when this
      // screen was unlocked, and `approval` is it.
      const res = await authFetch(`/bills/${visit.bill.id}/line-items/${id}`, { method: "DELETE" }, approval);
      if (!res.ok) {
        await lapsed(res);
      } else if (approval) {
        // Only staff see this — an admin's approval is "" and needed none.
        showToast(`Voided ${row.description}`);
      }
    } finally {
      rowBusy.current = false;
    }
  };

  // Change what ONE charge costs — a drink on the house, something knocked
  // down for a regular. The kind of thing that happens once and doesn't
  // deserve a discount item set up in advance.
  //
  // Like voiding, this works on one charge rather than a whole row: comping
  // one of three teas leaves the other two at full price, and the row visibly
  // splits so staff can see what they've done.
  //
  // The server keeps the old price, refuses the entry charge, and refuses a
  // bill that's already been paid — which is why almost nothing is checked
  // here beyond what the staff member typed.
  const adjustPrice = async (row: BillRow) => {
    if (rowBusy.current) return;
    const id = row.ids[row.ids.length - 1]; // the most recently rung-up one
    rowBusy.current = true;
    try {
      const typed = await dialog.askText(`New price for one "${row.description}"`, {
        title: "Change a price",
        initial: row.unit.toFixed(2),
        placeholder: "0.00",
        confirmLabel: "Set price",
        // A number pad rather than letters, since this is only ever a price.
        inputMode: "decimal",
      });
      // null is Cancel. "" is the box left empty and Save pressed — a real
      // answer everywhere else in the app, but not a price, so it's turned
      // away separately rather than lumped in with cancelling.
      if (typed === null) return;
      // Rounded to whole cents. Without this a slip of the finger — "19.1023"
      // — is stored exactly as typed, shows as $19.10 everywhere because every
      // screen formats to two places, and quietly throws the tax and the total
      // out by a fraction of a cent that nobody can see or explain.
      const raw = Number(typed.trim());
      const next = Math.round(raw * 100) / 100;
      if (typed.trim() === "" || !Number.isFinite(raw)) {
        await dialog.say("Type a price, like 0 or 4.50.", { title: "That's not a price" });
        return;
      }
      if (raw < 0) {
        await dialog.say("A price can't be less than zero.", { title: "That's not a price" });
        return;
      }
      // Nothing to do.
      if (next === row.unit) return;

      // The manager approved unlocking this bill, not this particular price —
      // which is the trade for not making them stand here for every charge.
      const res = await authFetch(
        `/bills/${visit.bill.id}/line-items/${id}/price`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: next }),
        },
        approval
      );
      if (!res.ok) {
        await lapsed(res);
      } else if (approval) {
        // Only staff see this — an admin's approval is "" and needed none.
        showToast(`${row.description} now ${money(next)}`);
      }
    } finally {
      rowBusy.current = false;
    }
  };

  // THE BIG ONE. A single request ends the visit, frees the locker, stamps the
  // bill paid, force-closes any kitchen tickets still open, and spends a visit
  // pass if this stay was on one — all together on the server, so a failure
  // part-way can't leave a locker occupied by someone who's already left.
  const completeCheckout = async () => {
    // Someone double-tapped, or tapped again while waiting. Ignore it.
    if (busy) return;
    setBusy(true);
    const res = await authFetch(`/check-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitId: visit.id, paymentMethod: method }),
    });
    setBusy(false);
    if (!res.ok) {
      const { error } = await res.json();
      await dialog.say(error, { title: "That didn't work" });
      return;
    }
    // What was ACTUALLY charged, straight from the till, rather than the total
    // this screen worked out a moment ago. They agree in every ordinary case —
    // but the cash discount is added server-side during this very request, so
    // the bill coming back is the only thing that can be trusted to match the
    // receipt. Falls back to the screen's own figure if an older server sends
    // nothing back.
    const paidBill = await res.json().catch(() => null);
    const charged: { amount: number; taxRate: number }[] | null = paidBill?.bill?.lineItems ?? null;
    const chargedTotal = charged
      ? charged.reduce((sum, i) => sum + i.amount + i.amount * i.taxRate, 0)
      : total;
    // Paid. Freeze a copy of everything the confirmation screen needs, because
    // this guest is about to vanish from the live list of active visits.
    setPaid({
      total: chargedTotal,
      method: METHODS.find((m) => m.id === method)?.label ?? method,
      name: `${visit.customer.firstName} ${visit.customer.lastName}`,
      locker: visit.locker.number,
      gender: visit.customer.gender,
      billId: visit.bill.id,
    });
  };

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 26px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ width: 48, height: 48, flex: "none", borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "#7a6a53" }}>
          {initials(visit.customer.firstName, visit.customer.lastName)}
        </div>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <span style={{ fontSize: 19, fontWeight: 800 }}>
              {visit.customer.firstName} {visit.customer.lastName}
            </span>
            {visit.customer.notes && (
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: .5, color: "#8f3f28", background: "#f7e4dc", padding: "3px 9px", borderRadius: 20 }}>
                {visit.customer.notes.length > 34 ? `${visit.customer.notes.slice(0, 34)}…` : visit.customer.notes}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: "#a89a86", fontWeight: 600, marginTop: 2 }}>
            Locker <span style={{ color: "#7a6a53", fontWeight: 800 }}>{visit.locker.number}</span>
            {" · Checked in "}
            <span style={{ color: "#6b6152", fontWeight: 700 }}>{fmtDuration(visit.checkInAt)}</span>
            {" ago"}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
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
    </div>
  );

  // ---------------------------------------------------------------------------
  // AFTER PAYMENT — the green confirmation. Everything below this point in the
  // file is the "before payment" screen, which is now unreachable for this
  // visit; there is no way back, by design.
  // ---------------------------------------------------------------------------
  if (paid) {
    return (
      <div style={{ background: "#f4efe7", minHeight: "100vh" }}>
        {header}
        <div style={{ padding: "40px 26px" }}>
          <div style={{ width: 520, background: "#fffdf9", border: "1px solid #cfe0c8", borderRadius: 20, overflow: "hidden", boxShadow: "0 16px 36px -20px rgba(95,122,90,.6)", animation: "popIn .3s ease" }}>
            <div style={{ padding: "38px 30px", textAlign: "center", background: "#eef4ea", borderBottom: "1px solid #cfe0c8" }}>
              <div style={{ width: 66, height: 66, margin: "0 auto 16px", borderRadius: "50%", background: "#5f7a5a", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 10px 22px -10px rgba(95,122,90,.9)" }}>
                <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
                  <path d="M8 17.5l6 6L26 10" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div style={{ ...LABEL, fontSize: 13, color: "#5f7a5a" }}>Paid · {paid.method}</div>
              <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1.05, marginTop: 8 }}>{money(paid.total)}</div>
              <div style={{ fontSize: 14, color: "#6b6152", fontWeight: 600, marginTop: 6 }}>
                {paid.name} · checkout complete
              </div>
            </div>
            <div style={{ padding: "22px 30px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 11, background: "#f4efe7", borderRadius: 12, padding: "14px 16px" }}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <rect x="3" y="7.5" width="12" height="7.5" rx="1.6" stroke="#5f7a5a" strokeWidth="1.8" />
                  <path d="M9 7.5V5.5a2.2 2.2 0 00-4.4 0" stroke="#5f7a5a" strokeWidth="1.8" />
                  <circle cx="9" cy="11" r="1.1" fill="#5f7a5a" />
                </svg>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#3f5540" }}>
                  Locker {paid.locker} released back to the {poolName(paid.gender)} pool
                </span>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                {/* Opens Receipt.tsx at /receipt/<id> in a new browser tab.
                    It's a plain address rather than an import, which is why
                    nothing here mentions that file by name. */}
                <button
                  onClick={() => window.open(`/receipt/${paid.billId}`, "_blank")}
                  style={{ flex: 1, padding: 16, border: "1.5px solid #d8cebc", borderRadius: 13, background: "#fffdf9", color: "#5f5340", fontFamily: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer" }}
                >
                  Print receipt
                </button>
                <button
                  onClick={onDone}
                  style={{ flex: 1, padding: 16, border: "none", borderRadius: 13, background: "#7a6a53", color: "#fff", fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: "pointer" }}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: "#f4efe7", minHeight: "100vh", position: "relative" }}>
      {header}

      <div style={{ padding: "18px 26px 26px" }}>
        <div
          onClick={onBack}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: "#7a6a53", cursor: "pointer", width: "fit-content", marginBottom: 14 }}
        >
          ← Back to the order screen
        </div>

        <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
          {/* itemised bill */}
          <div style={{ ...PANEL, flex: 1, minWidth: 0, borderRadius: 18, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 22px", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
              <div style={{ ...LABEL, fontSize: 13 }}>Bill</div>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#5f7a5a", animation: "pulseDot 1.8s ease-in-out infinite" }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: "#a89a86" }}>Kitchen items sync live</span>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: ROW, gap: 12, padding: "11px 22px", borderBottom: "1px solid rgba(43,38,32,.05)" }}>
              <div style={MICRO}>Item</div>
              <div style={{ ...MICRO, textAlign: "center" }}>Qty</div>
              <div style={{ ...MICRO, textAlign: "right" }}>Amount</div>
              <div />
            </div>

            {/* One row per merged charge. The `animation` line is what flashes
                a row green when it has only just appeared — see the effect
                near the top of the file. */}
            {rows.map((row) => (
              <div
                key={row.key}
                style={{ display: "grid", gridTemplateColumns: ROW, gap: 12, alignItems: "center", padding: "14px 22px", borderBottom: "1px solid rgba(43,38,32,.05)", animation: row.ids.some((id) => fresh.includes(id)) ? "freshRow 2.4s ease" : undefined }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{row.description}</span>
                    {kitchenNames.has(row.description) && (
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: .5, textTransform: "uppercase", color: "#7a6a53", background: "#efe7d9", padding: "2px 7px", borderRadius: 20 }}>
                        Kitchen
                      </span>
                    )}
                    {row.isAdmission && (
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: .5, textTransform: "uppercase", color: "#6b6152", background: "#f0ebe1", padding: "2px 7px", borderRadius: 20 }}>
                        Admission
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600, marginTop: 2 }}>{money(row.unit)} each</div>
                </div>
                <div style={{ textAlign: "center", fontSize: 15, fontWeight: 700, color: "#6b6152" }}>{row.qty}</div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{money(row.amount)}</div>
                  {/* Only a charge somebody changed carries this. Without it a
                      comped drink looks exactly like one that was always free. */}
                  {row.originalAmount !== null && (
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: "#8f5340", marginTop: 2 }}>
                      was {money(row.originalAmount * row.qty)}
                    </div>
                  )}
                </div>
                {/* Both buttons appear together while adjusting mode is on, and
                    never on the entry charge — that's swapped on the order
                    screen rather than edited or deleted here. */}
                <div style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  {adjusting && !row.isAdmission && (
                    <>
                      <button
                        onClick={() => adjustPrice(row)}
                        style={{ padding: "5px 11px", border: "1.5px solid #d8cebc", borderRadius: 9, background: "#fffdf9", color: "#7a6a53", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                      >
                        Price
                      </button>
                      <button
                        onClick={() => voidOne(row)}
                        style={{ padding: "5px 11px", border: "1.5px solid #e0bfb2", borderRadius: 9, background: "#fffdf9", color: "#8f3f28", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                      >
                        Void
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}

            {/* The cash discount, sitting with the charges because that's where
                staff read the bill from — but greyed and labelled, because
                unlike everything above it this hasn't happened yet. It's added
                for real the moment Complete Checkout is pressed, and it
                disappears if they switch to Card. */}
            {discount && (
              <div
                style={{ display: "grid", gridTemplateColumns: ROW, gap: 12, alignItems: "center", padding: "14px 22px", borderBottom: "1px solid rgba(43,38,32,.05)", background: "#faf7f0" }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#3f5540" }}>{discount.description}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: .5, textTransform: "uppercase", color: "#3f5540", background: "#dfeada", padding: "2px 7px", borderRadius: 20 }}>
                      Paying cash
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600, marginTop: 2 }}>
                    Off the entry charge · applied when this is paid
                  </div>
                </div>
                <div style={{ textAlign: "center", fontSize: 15, fontWeight: 700, color: "#6b6152" }}>1</div>
                <div style={{ textAlign: "right", fontSize: 15, fontWeight: 700, color: "#3f5540" }}>{money(discount.amount)}</div>
                <div />
              </div>
            )}

            {rows.length === 0 && !discount && (
              <div style={{ padding: 30, textAlign: "center", fontSize: 14, fontWeight: 600, color: "#a89a86" }}>
                Nothing on this bill yet.
              </div>
            )}

            <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 11 }}>
              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline", gap: 40 }}>
                <span style={{ fontSize: 14, color: "#6b6152", fontWeight: 600 }}>Subtotal</span>
                <span style={{ width: 110, textAlign: "right", fontSize: 15, fontWeight: 700 }}>{money(subtotal)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline", gap: 40 }}>
                {/* The percentage is worked out backwards from the two totals,
                    because with mixed rates on one bill there's no single rate
                    to print. */}
                <span style={{ fontSize: 14, color: "#6b6152", fontWeight: 600 }}>
                  Tax {subtotal > 0 ? `(${((tax / subtotal) * 100).toFixed(2)}%)` : ""}
                </span>
                <span style={{ width: 110, textAlign: "right", fontSize: 15, fontWeight: 700 }}>{money(tax)}</span>
              </div>
              <div style={{ height: 1, background: "rgba(43,38,32,.1)", margin: "3px 0" }} />
              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline", gap: 40 }}>
                <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase" }}>Total</span>
                <span style={{ width: 150, textAlign: "right", fontSize: 34, fontWeight: 800, lineHeight: 1 }}>{money(total)}</span>
              </div>
            </div>
          </div>

          {/* payment + actions */}
          <div style={{ width: 400, flex: "none", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ ...PANEL, padding: 18 }}>
              <div style={{ ...LABEL, marginBottom: 12 }}>Payment method</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {METHODS.map((m) => {
                  const on = m.id === method;
                  return (
                    <div
                      key={m.id}
                      onClick={() => setMethod(m.id)}
                      style={{ textAlign: "center", padding: "13px 8px", borderRadius: 11, cursor: "pointer", fontSize: 13.5, fontWeight: 700, background: on ? "#7a6a53" : "#fffdf9", color: on ? "#fff" : "#6b6152", border: `1.5px solid ${on ? "#7a6a53" : "#d8cebc"}` }}
                    >
                      {m.label}
                    </div>
                  );
                })}
              </div>
              {visit.redeemsPass && (
                <div style={{ marginTop: 11, fontSize: 12, fontWeight: 600, color: "#6b6152", background: "#f4efe7", borderRadius: 10, padding: "10px 12px" }}>
                  Admission on this visit is being paid with a pass · {visit.customer.visitPassBalance} left before this checkout.
                </div>
              )}
            </div>

            <div style={{ ...PANEL, padding: 18 }}>
              <div style={{ ...LABEL, marginBottom: 12 }}>Adjustments</div>
              <button
                onClick={toggleAdjusting}
                style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 13, borderRadius: 11, border: `1.5px solid ${adjusting ? "#8f3f28" : "#d8cebc"}`, background: "#fffdf9", color: adjusting ? "#8f3f28" : "#6b6152", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <rect x="2.5" y="6" width="8" height="5.5" rx="1.3" stroke={adjusting ? "#8f3f28" : "#a89a86"} strokeWidth="1.5" />
                  <path d="M4.2 6V4.3a2.3 2.3 0 014.6 0V6" stroke={adjusting ? "#8f3f28" : "#a89a86"} strokeWidth="1.5" />
                </svg>
                {adjusting ? "Done adjusting" : "Adjust an item"}
              </button>
              <div style={{ fontSize: 11.5, color: "#b8ab97", fontWeight: 600, marginTop: 10, textAlign: "center" }}>
                {adjusting
                  ? approval
                    ? "Approved · change prices or remove charges freely"
                    : "Pick a row to change its price or remove one"
                  : isAdmin || approval
                    ? "Change a price or void a charge · refunds live on Reports"
                    : "A manager's password unlocks this bill once · refunds live on Reports"}
              </div>
            </div>

            <button
              onClick={completeCheckout}
              disabled={busy}
              style={{ width: "100%", padding: 20, border: "none", borderRadius: 16, background: "#7a6a53", color: "#fff", fontFamily: "inherit", fontSize: 18, fontWeight: 800, cursor: busy ? "default" : "pointer", boxShadow: "0 12px 26px -12px rgba(122,106,83,.9)", opacity: busy ? .7 : 1 }}
            >
              {busy ? "Completing…" : `Complete Checkout · ${money(total)}`}
            </button>
            <div style={{ textAlign: "center", fontSize: 12, color: "#a89a86", fontWeight: 600, marginTop: -4 }}>
              Releases locker {visit.locker.number} back to the pool
            </div>
          </div>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 26, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 11, background: "#3a332a", color: "#fffdf9", padding: "14px 20px", borderRadius: 13, boxShadow: "0 14px 30px -12px rgba(43,38,32,.7)", animation: "toastIn .22s ease", zIndex: 20 }}>
          <svg width="17" height="17" viewBox="0 0 17 17" fill="none">
            <rect x="3.5" y="8" width="10" height="6.5" rx="1.4" stroke="#e8c3b4" strokeWidth="1.7" />
            <path d="M5.7 8V5.9a2.8 2.8 0 015.6 0V8" stroke="#e8c3b4" strokeWidth="1.7" />
          </svg>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>{toast}</span>
        </div>
      )}
    </div>
  );
}

export default Checkout;