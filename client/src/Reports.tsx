import { useEffect, useState } from "react";
import { authFetch } from "./authFetch.ts";

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
  refunded: boolean;
};
type TopItem = { name: string; qty: number; revenue: number };
type Visitor = { id: number; name: string; visits: number; spend: number };
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

type ReceiptLine = { id: number; description: string; amount: number; isAdmission: boolean };
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
    customer: { firstName: string; lastName: string };
    locker: { number: string };
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
  return `$${n.toFixed(2)}`;
}
function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return `${p[0]?.[0] ?? ""}${p[1]?.[0] ?? ""}`.toUpperCase();
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Read a YYYY-MM-DD back at midday, so no timezone can nudge it to the day before.
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
  const [date, setDate] = useState(todayStr());
  const [scope, setScope] = useState<"day" | "all">("day");
  const [report, setReport] = useState<Report | null>(null);
  const [denied, setDenied] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptBill | null>(null);

  const user = JSON.parse(localStorage.getItem("user") ?? "null");
  const isAdmin = user?.role === "ADMIN";

  const load = () => {
    authFetch(`/reports/daily?date=${date}&scope=${scope}`).then(async (r) => {
      if (!r.ok) {
        setDenied(true);
        return;
      }
      setDenied(false);
      setReport(await r.json());
    });
  };

  useEffect(() => {
    if (!isAdmin) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, scope]);

  if (!isAdmin || denied) {
    return (
      <div style={{ background: "#f4efe7", minHeight: "100vh", padding: "26px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Reports</h1>
        <p style={{ color: "#a89a86", fontWeight: 600 }}>Only the admin login can view reports.</p>
      </div>
    );
  }

  const openReceipt = async (billId: number) => {
    const res = await authFetch(`/bills/${billId}`);
    if (!res.ok) return;
    setReceipt(await res.json());
  };

  const refund = async (bill: BillRow) => {
    const reason = prompt(`Refund ${money(bill.total)} to ${bill.customer}?\n\nReason:`);
    if (reason === null) return;
    const res = await authFetch(`/bills/${bill.id}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
      return;
    }
    setReceipt(null);
    load();
  };

  const card = report?.byMethod.CARD ?? 0;
  const cash = report?.byMethod.CASH ?? 0;
  const cardCount = report?.bills.filter((b) => b.paymentMethod === "CARD").length ?? 0;
  const cashCount = report?.bills.filter((b) => b.paymentMethod === "CASH").length ?? 0;
  const effectiveTax = report && report.subtotal > 0 ? `${((report.tax / report.subtotal) * 100).toFixed(2)}%` : "—";
  const maxRevenue = report && report.topItems.length > 0 ? report.topItems[0].revenue : 1;

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
          <input
            className="rp-date"
            type="date"
            value={date}
            onChange={(e) => { setDate(e.target.value); setScope("day"); }}
          />
        </div>
      </div>

      {!report ? (
        <div style={{ padding: 26, color: "#a89a86", fontWeight: 600 }}>Loading…</div>
      ) : (
        <div style={{ padding: "20px 26px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
          {/* KPIs */}
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
                  {b.redeemsPass ? " · pass" : ""}
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
        </div>
      )}

      {/* receipt overlay */}
      {receipt && (
        <div
          onClick={() => setReceipt(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(43,38,32,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 30, zIndex: 50 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 390, maxHeight: "100%", overflowY: "auto", background: "#fffdf9", borderRadius: 18, padding: "26px 26px 22px", boxShadow: "0 40px 80px -30px rgba(43,38,32,.6)" }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ ...CAPS, fontSize: 11 }}>Receipt #{receipt.id}</div>
                <div style={{ fontSize: 19, fontWeight: 800, marginTop: 4 }}>
                  {receipt.visit.customer.firstName} {receipt.visit.customer.lastName}
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#a89a86" }}>
                  {receipt.paidAt ? `${shortDay(receipt.paidAt)} · ${timeLabel(receipt.paidAt)} · ` : ""}
                  locker {receipt.visit.locker.number}
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
              const tax = sub * receipt.taxRate;
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