import { useCallback, useEffect, useState } from "react";
import { authFetch } from "./authFetch.ts";

const METHOD_LABELS: Record<string, string> = {
  CASH: "Cash",
  CARD: "Card",
  GIFT_CARD: "Gift card",
  VISIT_PASS: "Visit pass",
  UNKNOWN: "Unknown",
};

type ReportBill = {
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

type Report = {
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
  bills: ReportBill[];
};

function todayStr() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function money(n: number) {
  return `$${n.toFixed(2)}`;
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#f4f4f4", padding: "12px 16px", borderRadius: 8, minWidth: 130 }}>
      <div style={{ color: "#666", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

const cell: React.CSSProperties = { padding: "8px 6px", borderBottom: "1px solid #eee", textAlign: "left" };

function Reports() {
  const [date, setDate] = useState(todayStr());
  const [report, setReport] = useState<Report | null>(null);
  const signedIn = Boolean(localStorage.getItem("token"));
  const user = JSON.parse(localStorage.getItem("user") ?? "null");
  const isAdmin = user?.role === "ADMIN";

  const load = useCallback(() => {
    authFetch(`/reports/daily?date=${date}`).then((r) => r.json()).then(setReport);
  }, [date]);

  useEffect(() => {
    if (!signedIn) return;
    load();
  }, [load, signedIn]);

  const refund = async (b: ReportBill) => {
    const reason = prompt(
      `Refund ${b.customer}'s ${money(b.total)} bill (paid by ${METHOD_LABELS[b.paymentMethod] ?? b.paymentMethod})?\n\nReason (optional):`
    );
    if (reason === null) return; // Cancel pressed
    const res = await authFetch(`/bills/${b.id}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
    }
    load();
  };

  if (!signedIn) {
    return (
      <div style={{ padding: 24, fontFamily: "sans-serif" }}>
        <h1>Reports</h1>
        <p>Not signed in. <a href="/">Open the register</a> on this terminal first, then come back.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif", maxWidth: 960 }}>
      <h1>Daily report</h1>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ padding: 8, fontSize: 15 }} />

      {report && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
            <SummaryCard label="Total taken" value={money(report.total)} />
            <SummaryCard label="Refunds given" value={money(report.refundsGiven)} />
            <SummaryCard label="Net" value={money(report.net)} />
            <SummaryCard label="Tax collected" value={money(report.tax)} />
            <SummaryCard label="Bills closed" value={String(report.billCount)} />
            <SummaryCard label="Passes redeemed" value={String(report.passesRedeemed)} />
            {Object.entries(report.byMethod).map(([method, amount]) => (
              <SummaryCard key={method} label={`${METHOD_LABELS[method] ?? method} takings`} value={money(amount)} />
            ))}
          </div>

          <h2 style={{ marginTop: 24 }}>Closed bills</h2>
          {report.bills.length === 0 ? (
            <p>No paid bills on this day.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={cell}>Time</th>
                  <th style={cell}>Customer</th>
                  <th style={cell}>Locker</th>
                  <th style={cell}>Paid by</th>
                  <th style={{ ...cell, textAlign: "right" }}>Total</th>
                  <th style={cell}></th>
                </tr>
              </thead>
              <tbody>
                {report.bills.map((b) => (
                  <tr key={b.id} style={b.refunded ? { color: "#999" } : undefined}>
                    <td style={cell}>{new Date(b.paidAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td>
                    <td style={cell}>{b.customer}</td>
                    <td style={cell}>{b.locker}</td>
                    <td style={cell}>
                      {METHOD_LABELS[b.paymentMethod] ?? b.paymentMethod}
                      {b.redeemsPass ? " · pass" : ""}
                      {b.refunded ? <strong style={{ color: "#c00" }}> · REFUNDED</strong> : ""}
                    </td>
                    <td style={{ ...cell, textAlign: "right", textDecoration: b.refunded ? "line-through" : "none" }}>
                      {money(b.total)}
                    </td>
                    <td style={cell}>
                      <a href={`/receipt/${b.id}`} target="_blank">Receipt</a>
                      {isAdmin && !b.refunded && (
                        <>
                          {" "}
                          <button onClick={() => refund(b)}>Refund</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

export default Reports;