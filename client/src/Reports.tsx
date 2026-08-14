// ============================================================================
// REPORTS — the day's takings. ADMIN ONLY.
//
// WHAT IT IS
//   The books. Pick a day (or "all time") and it shows what came in: how many
//   bills, the subtotal, the tax, the split between cash and card, refunds,
//   best-selling items and most frequent guests. Every closed bill is listed,
//   and each can be re-opened as a receipt or refunded.
//
//   All the adding up happens on the SERVER. This screen only displays what
//   it's handed — which is why there's so little arithmetic here compared to
//   the Checkout screen.
//
// WHERE IT'S USED
//   The "/reports" route in client/src/main.tsx. Nothing imports it.
//   The sidebar in Shell.tsx only shows the link to admins, but typing the
//   address still loads the page — so it checks the role again itself, and
//   the server refuses the data regardless. Three layers, and only the last
//   one actually protects anything.
//
//   It's the only main screen with NO live connection. Yesterday's takings
//   don't change while you look at them, so there's nothing to listen for.
//
// WHAT IT TALKS TO   (all in server/src/index.ts)
//   GET  /reports/daily?date=…&scope=…  → the whole report in one go
//   GET  /bills/:id                     → fill the receipt overlay
//   POST /bills/:id/refund              → refund a whole bill
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { authFetch } from "./authFetch.ts";
import { useOverride } from "./OverrideProvider.tsx";
import { useDialog } from "./DialogProvider.tsx";

// One closed bill in the day's list.
type BillRow = {
  id: number;
  paidAt: string;
  paymentMethod: string;
  subtotal: number;
  tax: number;
  total: number;
  customer: string;
  locker: string;
  redeemsPass: boolean;
  // Whose pass paid, when it wasn't the guest's own. Null otherwise. This is
  // the audit trail if a customer ever queries their balance.
  passSponsor: string | null;
  refunded: boolean;
};
type TopItem = { name: string; qty: number; revenue: number };
type Visitor = { id: number; name: string; visits: number; spend: number };

// One manager approval, as the audit log shows it. `usedAt` being null on an
// ACTION row means a manager typed their password and the thing then didn't
// happen — a cancelled confirm, a network drop, or second thoughts.
type OverrideRow = {
  id: number;
  action: string;
  scope: string;
  approvedBy: string;
  requestedBy: string;
  createdAt: string;
  usedAt: string | null;
};

// The server's whole answer, in one object. Worth knowing:
//   total  — everything taken, refunds included
//   net    — total minus refunds; the figure that actually matters
//   truncated — the list of bills is capped at 200, and this says it was cut
type Report = {
  scope: string;
  date: string;
  billCount: number;
  passesRedeemed: number;
  subtotal: number;
  tax: number;
  total: number;
  byMethod: Record<string, number>;
  refundCount: number;
  refundsGiven: number;
  net: number;
  topItems: TopItem[];
  frequentVisitors: Visitor[];
  bills: BillRow[];
  truncated: boolean;
};

type ReceiptLine = { id: number; description: string; amount: number; taxRate: number; isAdmission: boolean };
type ReceiptBill = {
  id: number;
  taxRate: number;
  paidAt: string | null;
  paymentMethod: string | null;
  refundedAt: string | null;
  refundReason: string | null;
  lineItems: ReceiptLine[];
  visit: {
    checkInAt: string;
    takeoutNumber: number | null;
    takeoutName: string | null;
    customer: { firstName: string; lastName: string } | null;
    locker: { number: string } | null;
  };
};

const PANEL: React.CSSProperties = {
  background: "#fffdf9",
  border: "1px solid rgba(43,38,32,.08)",
  borderRadius: 18,
  boxShadow: "0 1px 2px rgba(43,38,32,.04)",
};
const CAPS: React.CSSProperties = {
  fontSize: 12.5,
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
const BILL_COLS = "1fr 1.5fr .7fr 1fr 1fr 1.1fr";

function money(n: number) {
  // Discounts are negative, and "$-5.00" reads like a typo. Put the minus in
  // front of the whole thing — "−$5.00" — the way a receipt would.
  return n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}
function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return `${p[0]?.[0] ?? ""}${p[1]?.[0] ?? ""}`.toUpperCase();
}
// Today as "2026-08-04", built by hand from the local clock. Deliberately not
// using the built-in date-to-text conversion, which works in UTC and would
// hand back yesterday's date for anyone west of Greenwich late in the evening.
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Read a YYYY-MM-DD back at midday, so no timezone can nudge it to the day before.
// (Reading it at midnight, the default, leaves it one timezone shift away from
// slipping into the previous day. Midday leaves twelve hours of slack.)
function dayLabel(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function shortDay(iso: string) {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}
function methodLabel(method: string) {
  return method.charAt(0) + method.slice(1).toLowerCase().replace("_", " ");
}
// The bill stores one charge per unit; the receipt reads better grouped.
// (The same squashing Checkout.tsx does — see groupBill there. This version is
// simpler because nothing here can be voided, so it doesn't need to remember
// the individual charge ids.)
function groupLines(lines: ReceiptLine[]) {
  const rows = new Map<string, { key: string; name: string; qty: number; amount: number }>();
  for (const l of lines) {
    const key = `${l.description}|${l.amount}`;
    const row = rows.get(key);
    if (row) {
      row.qty += 1;
      row.amount += l.amount;
    } else {
      rows.set(key, { key, name: l.description, qty: 1, amount: l.amount });
    }
  }
  return Array.from(rows.values());
}

// One of the eight figure tiles across the top: a caption, a big number, and
// a smaller line of context underneath.
function Kpi({ label, value, note, ink }: { label: string; value: string; note: string; ink?: string }) {
  return (
    <div style={{ background: "#fffdf9", border: "1px solid rgba(43,38,32,.08)", borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 2px rgba(43,38,32,.04)" }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "#a89a86" }}>
        {label}
      </div>
      <div style={{ fontSize: 27, fontWeight: 800, lineHeight: 1.15, marginTop: 6, color: ink ?? "#2b2620" }}>{value}</div>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: "#b8ab97", marginTop: 3 }}>{note}</div>
    </div>
  );
}

function Reports() {
  const [date, setDate] = useState(todayStr());        // which day
  const [scope, setScope] = useState<"day" | "all">("day");  // one day or all time
  const [report, setReport] = useState<Report | null>(null);
  const [denied, setDenied] = useState(false);         // server said no
  const [approvals, setApprovals] = useState<OverrideRow[]>([]);  // the audit log
  const [receipt, setReceipt] = useState<ReceiptBill | null>(null);  // overlay

  const user = JSON.parse(localStorage.getItem("user") ?? "null");
  const isAdmin = user?.role === "ADMIN";
  const askOverride = useOverride();
  const dialog = useDialog();

  // Set while a refund is mid-flight, and this one really matters. The Refund
  // button only greys out once the refreshed report comes back saying the bill
  // is refunded, which is the very last thing to happen. Until then the button
  // is still live — and the boxes that used to hold everything up were the
  // browser's, which froze the page. Ours don't, so without this a double-tap
  // would hand the money back twice.
  const refunding = useRef(false);

  // The permission slip for this screen. "" means an admin who needs none, a
  // long string means a manager approved it, and null means still locked.
  //
  // This one is PAGE scope rather than single-use. Reports re-fetches every
  // time you change the date, and a single-use approval would die on the first
  // refresh — a password prompt per date change would be unusable.
  const [approval, setApproval] = useState<string | null>(isAdmin ? "" : null);

  const unlock = async () => {
    const token = await askOverride("Open Reports", "PAGE");
    if (token === null) return;
    setApproval(token);
    setDenied(false);
  };

  const load = () => {
    if (approval === null) return; // still locked; nothing to fetch yet
    authFetch(`/reports/daily?date=${date}&scope=${scope}`, {}, approval).then(async (r) => {
      // A refusal here now means one of two things: not an admin and never
      // approved, or the ten minutes lapsed. Either way the screen locks and
      // offers the prompt again rather than dead-ending.
      if (!r.ok) {
        setDenied(true);
        setApproval(isAdmin ? "" : null);
        return;
      }
      setDenied(false);
      setReport(await r.json());
    });

    // The approval log, admin-only on the server. A staff member who unlocked
    // this screen shouldn't get to read who approved what, so don't even ask.
    if (isAdmin) {
      authFetch(`/overrides`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setApprovals)
        .catch(() => setApprovals([]));
    }
  };

  // Re-fetch whenever the chosen day, the day/all-time switch, or the approval
  // changes. Adding `approval` is what makes the report appear the instant a
  // manager finishes typing.
  useEffect(() => {
    load();
    // The linter wants `load` listed here too. It's left out on purpose: `load`
    // is rebuilt on every redraw, so listing it would make this fetch on every
    // redraw as well, in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, scope, approval]);

  // Locked. Staff see this until a manager approves; it's a courtesy screen,
  // not the protection — the real refusal is the server's.
  if (approval === null || denied) {
    return (
      <div style={{ background: "#f4efe7", minHeight: "100vh", padding: "26px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Reports</h1>
        <p style={{ color: "#a89a86", fontWeight: 600, maxWidth: 380, lineHeight: 1.5 }}>
          {denied
            ? "That approval has run out. A manager can open it again."
            : "Reports needs a manager's approval to open."}
        </p>
        <button className="ov-btn ov-go" style={{ maxWidth: 220 }} onClick={unlock}>
          Ask a manager
        </button>
      </div>
    );
  }

  const openReceipt = async (billId: number) => {
    const res = await authFetch(`/bills/${billId}`);
    if (!res.ok) return;
    setReceipt(await res.json());
  };

  // Refund a whole bill. Nothing is deleted — the bill keeps every charge and
  // is stamped with the date and reason, so the paper trail survives. It's
  // all-or-nothing (there's no partial refund), can't be done twice, and only
  // works on a bill that was actually paid.
  const refund = async (bill: BillRow) => {
    if (refunding.current) return;
    refunding.current = true;
    try {
      // askText hands back null if Cancel was pressed, as opposed to "" for an
      // empty reason — so this check must be against null specifically. An
      // unexplained refund is allowed; an abandoned one is not.
      const reason = await dialog.askText(`Refund ${money(bill.total)} to ${bill.customer}?`, {
        title: "Refund a bill",
        placeholder: "Reason (optional)",
        confirmLabel: "Refund",
      });
      if (reason === null) return;
      // Asked for separately, even on an already-unlocked screen. Looking at
      // yesterday's takings and handing $80 back are not the same act, so the
      // screen's PAGE approval deliberately doesn't cover this.
      const token = await askOverride(`Refund ${money(bill.total)} to ${bill.customer}`);
      if (token === null) return;
      const res = await authFetch(`/bills/${bill.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      }, token);
      if (!res.ok) {
        const { error } = await res.json();
        await dialog.say(error, { title: "That didn't work" });
        return;
      }
      setReceipt(null);
      load();
    } finally {
      refunding.current = false;
    }
  };

  // The cash-vs-card split, for the drawer count at the end of the night.
  const card = report?.byMethod.CARD ?? 0;
  const cash = report?.byMethod.CASH ?? 0;
  const cardCount = report?.bills.filter((b) => b.paymentMethod === "CARD").length ?? 0;
  const cashCount = report?.bills.filter((b) => b.paymentMethod === "CASH").length ?? 0;
  // The blended tax rate for the day, worked out backwards. Because items can
  // carry different rates, this lands somewhere between them rather than on
  // any one configured rate.
  const effectiveTax = report && report.subtotal > 0 ? `${((report.tax / report.subtotal) * 100).toFixed(2)}%` : "—";
  // The best seller's revenue, used as the full-width mark for the bars in the
  // best-sellers list. Falls back to 1 so nothing divides by zero.
  // The longest bar in Best Sellers, which every other bar is measured against.
  // The `|| 1` is load-bearing: on a day where everything sold was comped to
  // $0 the top seller's revenue IS zero, and dividing by it would set every
  // bar to a width of "NaN%" — no error, the bars just silently vanish.
  const maxRevenue = (report && report.topItems.length > 0 ? report.topItems[0].revenue : 1) || 1;

  return (
    <div style={{ background: "#f4efe7", minHeight: "100vh" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 26px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800 }}>Reports</div>
          <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600 }}>
            {scope === "day" ? `${dayLabel(date)} · trading day` : "All trading days on record"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "inline-flex", background: "#e7e0d5", borderRadius: 11, padding: 3, gap: 3 }}>
            {([["day", "Selected day"], ["all", "All history"]] as const).map(([id, label]) => {
              const on = scope === id;
              return (
                <div
                  key={id}
                  onClick={() => setScope(id)}
                  style={{ padding: "8px 18px", borderRadius: 9, cursor: "pointer", fontSize: 13, fontWeight: 700, background: on ? "#fffdf9" : "transparent", color: on ? "#2b2620" : "#8a7d6a", boxShadow: on ? "0 1px 3px rgba(43,38,32,.12)" : "none" }}
                >
                  {label}
                </div>
              );
            })}
          </div>
          {/* Clicking anywhere in the box opens the calendar.
              A date input HAS a calendar built in, but the browser only opens it
              from the little icon at the right edge — clicking the text just puts
              a cursor in the day or month so you type over it. Most people never
              find the icon, so the field looks like it's type-only.
              `showPicker()` is the browser asking its own calendar to drop down.
              Guarded twice, because it can fail in two ordinary ways:
                ?.()   — older browsers don't have it. They keep the old
                         behaviour instead of crashing the screen.
                try    — it throws if the calendar is ALREADY open, which happens
                         when the click lands on the icon: that opens the picker
                         and then runs this too. Without the catch, every click
                         on the icon would put a red error in the console.
              Typing still works — this doesn't make the field read-only, and
              typing is still the quicker way to reach a date months back. */}
          <input
            className="rp-date"
            type="date"
            value={date}
            onClick={(e) => { try { e.currentTarget.showPicker?.(); } catch { /* no showPicker, or already open */ } }}
            onChange={(e) => { setDate(e.target.value); setScope("day"); }}
          />
        </div>
      </div>

      {!report ? (
        <div style={{ padding: 26, color: "#a89a86", fontWeight: 600 }}>Loading…</div>
      ) : (
        <div style={{ padding: "20px 26px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
          {/* KPIs */}
          {/* Eight figures at a glance. "Total taken" and "Net revenue" differ
              by exactly the refunds given — a refunded bill still counts as a
              sale that happened, it just has money going back out against it. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
            <Kpi label="Total taken" value={money(report.total)} note={`${report.billCount} bill${report.billCount === 1 ? "" : "s"} · before refunds`} />
            <Kpi label="Net revenue" value={money(report.net)} note="Total less refunds given" />
            <Kpi label="Tax collected" value={money(report.tax)} note={`${effectiveTax} · on ${money(report.subtotal)}`} />
            <Kpi label="Bills closed" value={String(report.billCount)} note={scope === "day" ? "On this date" : "All dates"} />
            <Kpi label="Card takings" value={money(card)} note={`${cardCount} payment${cardCount === 1 ? "" : "s"}`} />
            <Kpi label="Cash takings" value={money(cash)} note={`${cashCount} payment${cashCount === 1 ? "" : "s"}`} />
            <Kpi label="Passes redeemed" value={String(report.passesRedeemed)} note="Visit passes" ink="#5f7a5a" />
            <Kpi
              label="Refunds given"
              value={money(report.refundsGiven)}
              note={`${report.refundCount} bill${report.refundCount === 1 ? "" : "s"} refunded`}
              ink={report.refundsGiven > 0 ? "#8f3f28" : undefined}
            />
          </div>

          {/* closed bills */}
          <div style={{ ...PANEL, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "17px 22px", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
              <div style={CAPS}>Closed bills</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#7a6a53" }}>
                {report.bills.length} bill{report.bills.length === 1 ? "" : "s"}
                {report.truncated ? ` of ${report.billCount}` : ""}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: BILL_COLS, gap: 12, padding: "10px 22px", borderBottom: "1px solid rgba(43,38,32,.05)" }}>
              <div style={MICRO}>Time</div>
              <div style={MICRO}>Customer</div>
              <div style={MICRO}>Locker</div>
              <div style={MICRO}>Paid by</div>
              <div style={{ ...MICRO, textAlign: "right" }}>Total</div>
              <div />
            </div>

            {/* Every closed bill, newest first. A refunded one is struck
                through and its Refund button is dead — the server rejects a
                second refund anyway, so this just makes that visible. */}
            {report.bills.map((b) => (
              <div key={b.id} className="rp-row" style={{ display: "grid", gridTemplateColumns: BILL_COLS, gap: 12, alignItems: "center", padding: "12px 22px", borderBottom: "1px solid rgba(43,38,32,.05)" }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{timeLabel(b.paidAt)}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#b8ab97" }}>{shortDay(b.paidAt)}</div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, minWidth: 0 }}>{b.customer}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#7a6a53" }}>{b.locker}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#6b6152" }}>
                  {methodLabel(b.paymentMethod)}
                  {/* Name the sponsor rather than just saying "pass" — the
                      whole point is being able to trace a disputed balance
                      back to a person without opening the receipt. */}
                  {b.redeemsPass ? (b.passSponsor ? ` · pass from ${b.passSponsor}` : " · pass") : ""}
                </div>
                <div style={{ textAlign: "right", fontSize: 14, fontWeight: 800, color: b.refunded ? "#a89a86" : "#2b2620", textDecoration: b.refunded ? "line-through" : "none" }}>
                  {money(b.total)}
                </div>
                <div style={{ display: "flex", gap: 7, justifyContent: "flex-end" }}>
                  <button
                    onClick={() => openReceipt(b.id)}
                    style={{ fontSize: 11.5, fontWeight: 800, color: "#7a6a53", border: "1.5px solid #d8cebc", borderRadius: 8, padding: "5px 10px", cursor: "pointer", background: "#fffdf9", fontFamily: "inherit" }}
                  >
                    Receipt
                  </button>
                  <button
                    onClick={() => !b.refunded && refund(b)}
                    disabled={b.refunded}
                    style={{ fontSize: 11.5, fontWeight: 800, fontFamily: "inherit", color: b.refunded ? "#8f3f28" : "#6b6152", border: `1.5px solid ${b.refunded ? "#e6cfc6" : "#d8cebc"}`, background: b.refunded ? "#f7e4dc" : "#fffdf9", borderRadius: 8, padding: "5px 10px", cursor: b.refunded ? "default" : "pointer" }}
                  >
                    {b.refunded ? "Refunded" : "Refund"}
                  </button>
                </div>
              </div>
            ))}

            {report.bills.length === 0 && (
              <div style={{ padding: 30, textAlign: "center", fontSize: 14, fontWeight: 600, color: "#a89a86" }}>
                No bills closed {scope === "day" ? "on this date" : "yet"}.
              </div>
            )}
          </div>

          {/* best sellers + visitors */}
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18, alignItems: "start" }}>
            <div style={{ ...PANEL, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "17px 22px", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
                <div style={CAPS}>Best sellers</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#7a6a53" }}>By revenue · refunds excluded</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "26px 1fr 70px 90px", gap: 12, padding: "10px 22px", borderBottom: "1px solid rgba(43,38,32,.05)" }}>
                <div style={MICRO}>#</div>
                <div style={MICRO}>Item</div>
                <div style={{ ...MICRO, textAlign: "right" }}>Qty</div>
                <div style={{ ...MICRO, textAlign: "right" }}>Revenue</div>
              </div>
              {/* Ranked by revenue, not by count — one massage outranks a lot
                  of teas. Refunded bills are left out of this entirely, since
                  those sales were undone. The little bar under each name is
                  drawn as a percentage of the top seller's revenue. */}
              {report.topItems.map((item, i) => (
                <div key={item.name} style={{ display: "grid", gridTemplateColumns: "26px 1fr 70px 90px", gap: 12, alignItems: "center", padding: "12px 22px", borderBottom: "1px solid rgba(43,38,32,.05)" }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#c8b9a0" }}>{i + 1}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{item.name}</div>
                    <div style={{ height: 4, background: "#efe7d9", borderRadius: 3, marginTop: 6, overflow: "hidden" }}>
                      <div style={{ width: `${Math.round((item.revenue / maxRevenue) * 100)}%`, height: "100%", background: "#7a6a53", borderRadius: 3 }} />
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 13.5, fontWeight: 700, color: "#6b6152" }}>{item.qty}</div>
                  <div style={{ textAlign: "right", fontSize: 14, fontWeight: 800 }}>{money(item.revenue)}</div>
                </div>
              ))}
              {report.topItems.length === 0 && (
                <div style={{ padding: 26, textAlign: "center", fontSize: 13.5, fontWeight: 600, color: "#a89a86" }}>
                  Nothing sold {scope === "day" ? "on this date" : "yet"}.
                </div>
              )}
            </div>

            <div style={{ ...PANEL, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "17px 22px", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
                <div style={CAPS}>Most frequent visitors</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#7a6a53" }}>All time</div>
              </div>
              {/* Always all-time, whichever day is selected above — regulars
                  are regulars regardless of which day you're looking at. */}
              {report.frequentVisitors.map((v) => (
                <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 22px", borderBottom: "1px solid rgba(43,38,32,.05)" }}>
                  <div style={{ width: 34, height: 34, flex: "none", borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "#7a6a53" }}>
                    {initials(v.name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{v.name}</div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a89a86" }}>{money(v.spend)} lifetime</div>
                  </div>
                  <div style={{ flex: "none", textAlign: "right" }}>
                    <div style={{ fontSize: 15, fontWeight: 800 }}>{v.visits}</div>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: .5, textTransform: "uppercase", color: "#b8ab97" }}>visits</div>
                  </div>
                </div>
              ))}
              {report.frequentVisitors.length === 0 && (
                <div style={{ padding: 26, textAlign: "center", fontSize: 13.5, fontWeight: 600, color: "#a89a86" }}>
                  Nobody has completed a visit yet.
                </div>
              )}
            </div>
          </div>

          {/* Manager approvals — admin only. Every time a manager typed their
              password for a staff member, with what it was for. A row still
              reading NOT USED means the approval was granted and then nothing
              happened; the occasional one is normal, a pattern is worth
              asking about. */}
          {isAdmin && (
            <div style={{ ...PANEL, padding: 18 }}>
              <div style={{ ...CAPS, marginBottom: 12 }}>Manager approvals</div>
              {approvals.length === 0 && (
                <div style={{ fontSize: 13, color: "#a89a86", fontWeight: 600 }}>
                  Nothing approved yet.
                </div>
              )}
              {approvals.map((a) => (
                <div
                  key={a.id}
                  style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "9px 0", borderTop: "1px solid rgba(43,38,32,.07)" }}
                >
                  <div style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: "#2b2620" }}>
                    {a.action}
                    {a.scope === "ACTION" && !a.usedAt && (
                      <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 800, color: "#8f3f28" }}>
                        NOT USED
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#6b6152" }}>
                    {a.approvedBy} → {a.requestedBy}
                  </div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a89a86", width: 130, textAlign: "right" }}>
                    {new Date(a.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* receipt overlay */}
      {/* A read-only look at one bill, floating over the page. Clicking the
          dark backdrop closes it. */}
      {receipt && (
        <div
          onClick={() => setReceipt(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(43,38,32,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 30, zIndex: 50 }}
        >
          <div
            // Stop clicks inside the card from reaching the backdrop behind it,
            // which would otherwise close the receipt every time you touched it.
            onClick={(e) => e.stopPropagation()}
            style={{ width: 390, maxHeight: "100%", overflowY: "auto", background: "#fffdf9", borderRadius: 18, padding: "26px 26px 22px", boxShadow: "0 40px 80px -30px rgba(43,38,32,.6)" }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ ...CAPS, fontSize: 11 }}>Receipt #{receipt.id}</div>
                <div style={{ fontSize: 19, fontWeight: 800, marginTop: 4 }}>
                  {receipt.visit.customer
                    ? `${receipt.visit.customer.firstName} ${receipt.visit.customer.lastName}`
                    : receipt.visit.takeoutName || "Takeout"}
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#a89a86" }}>
                  {receipt.paidAt ? `${shortDay(receipt.paidAt)} · ${timeLabel(receipt.paidAt)} · ` : ""}
                  {receipt.visit.locker
                    ? `locker ${receipt.visit.locker.number}`
                    : `takeout #${receipt.visit.takeoutNumber ?? "?"}`}
                </div>
              </div>
              <div
                onClick={() => setReceipt(null)}
                style={{ flex: "none", fontSize: 18, fontWeight: 700, color: "#a89a86", cursor: "pointer", lineHeight: 1 }}
              >
                ×
              </div>
            </div>

            <div style={{ height: 1, background: "rgba(43,38,32,.09)", margin: "18px 0" }} />

            {groupLines(receipt.lineItems).map((l) => (
              <div key={l.key} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "6px 0" }}>
                <div style={{ width: 26, flex: "none", fontSize: 13, fontWeight: 800, color: "#7a6a53" }}>{l.qty}×</div>
                <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{l.name}</div>
                <div style={{ flex: "none", fontSize: 14, fontWeight: 700 }}>{money(l.amount)}</div>
              </div>
            ))}

            <div style={{ height: 1, background: "rgba(43,38,32,.09)", margin: "14px 0" }} />

            {(() => {
              const sub = receipt.lineItems.reduce((s, l) => s + l.amount, 0);
              const tax = receipt.lineItems.reduce((s, l) => s + l.amount * l.taxRate, 0);
              return (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "#6b6152", padding: "3px 0" }}>
                    <span>Subtotal</span><span>{money(sub)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "#6b6152", padding: "3px 0" }}>
                    <span>Tax</span><span>{money(tax)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 17, fontWeight: 800, paddingTop: 9, marginTop: 6, borderTop: "1px solid rgba(43,38,32,.09)" }}>
                    <span>Total</span><span>{money(sub + tax)}</span>
                  </div>
                </>
              );
            })()}

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 700, color: "#7a6a53", marginTop: 8 }}>
              <span>Paid by {receipt.paymentMethod ? methodLabel(receipt.paymentMethod).toLowerCase() : "—"}</span>
              <span style={{ color: receipt.refundedAt ? "#8f3f28" : "#7a6a53" }}>
                {receipt.refundedAt ? "Refunded" : "Closed"}
              </span>
            </div>
            {receipt.refundReason && (
              <div style={{ fontSize: 12, fontWeight: 600, color: "#8f3f28", marginTop: 4 }}>{receipt.refundReason}</div>
            )}

            {/* Opens Receipt.tsx at /receipt/<id> in a new tab, in the proper
                till-roll layout. Checkout.tsx has the same button. */}
            <button
              onClick={() => window.open(`/receipt/${receipt.id}`, "_blank")}
              style={{ marginTop: 16, width: "100%", padding: 13, border: "1.5px solid #d8cebc", borderRadius: 12, background: "#fffdf9", color: "#5f5340", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
            >
              Print this receipt
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Reports;