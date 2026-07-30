import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { authFetch } from "./authFetch.ts";

// Edit these to the real business details before printing real receipts.
const BUSINESS_NAME = "BANYA #3";
const BUSINESS_LINES = [
  "123 Steam Street, Toronto ON",
  "(416) 555-0199",
  "HST # 00000 0000 RT0001",
];

const METHOD_LABELS: Record<string, string> = {
  CASH: "cash",
  CARD: "card",
  GIFT_CARD: "gift card",
  VISIT_PASS: "visit pass",
};

type BillData = {
  id: number;
  taxRate: number;
  paymentMethod: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  refundReason: string | null;
  lineItems: { id: number; description: string; amount: number; isAdmission: boolean }[];
  visit: {
    checkInAt: string;
    redeemsPass: boolean;
    customer: { firstName: string; lastName: string };
    locker: { number: string };
  };
};

function money(n: number) {
  return `$${n.toFixed(2)}`;
}

function Row({ left, right, bold }: { left: string; right: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontWeight: bold ? 700 : 400 }}>
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
}

const dashed: React.CSSProperties = { borderTop: "1px dashed #000", margin: "8px 0" };

function Receipt() {
  const { billId } = useParams();
  const [bill, setBill] = useState<BillData | null>(null);
  const signedIn = Boolean(localStorage.getItem("token"));

  useEffect(() => {
    if (!signedIn) return;
    authFetch(`/bills/${billId}`).then((r) => r.json()).then(setBill);
  }, [billId, signedIn]);

  if (!signedIn) {
    return <p style={{ fontFamily: "sans-serif", padding: 24 }}>Not signed in. <a href="/">Open the register</a> first.</p>;
  }
  if (!bill) {
    return <p style={{ fontFamily: "sans-serif", padding: 24 }}>Loading receipt…</p>;
  }

  const subtotal = bill.lineItems.reduce((sum, li) => sum + li.amount, 0);
  const tax = subtotal * bill.taxRate;
  const total = subtotal + tax;
  const when = bill.paidAt ?? bill.visit.checkInAt;

  return (
    <div style={{ maxWidth: 320, margin: "24px auto", fontFamily: "'Courier New', monospace", fontSize: 13, color: "#000", background: "#fff", padding: 20, borderRadius: 6 }}>
      <button className="no-print" onClick={() => window.print()} style={{ width: "100%", padding: 10, marginBottom: 14 }}>
        Print receipt
      </button>

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "0.2em" }}>{BUSINESS_NAME}</div>
        {BUSINESS_LINES.map((line) => (
          <div key={line} style={{ fontSize: 11 }}>{line}</div>
        ))}
      </div>

      <div style={dashed} />
      <Row left={`Receipt #${bill.id}`} right={new Date(when).toLocaleDateString()} />
      <Row left={new Date(when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} right={`Locker ${bill.visit.locker.number}`} />
      <Row left="Guest" right={`${bill.visit.customer.firstName} ${bill.visit.customer.lastName}`} />

      <div style={dashed} />
      {bill.lineItems.map((li) => (
        <Row key={li.id} left={li.description + (li.isAdmission ? " *" : "")} right={money(li.amount)} />
      ))}
      {bill.lineItems.length === 0 && <div>(no charges)</div>}

      <div style={dashed} />
      <Row left="Subtotal" right={money(subtotal)} />
      <Row left={`HST (${(bill.taxRate * 100).toFixed(0)}%)`} right={money(tax)} />
      <Row left="TOTAL" right={money(total)} bold />

      <div style={dashed} />
      {bill.paidAt ? (
        <>
          <div style={{ textAlign: "center", fontWeight: 700 }}>
            PAID — {(METHOD_LABELS[bill.paymentMethod ?? ""] ?? bill.paymentMethod ?? "").toUpperCase()}
          </div>
          {bill.refundedAt && (
            <div style={{ textAlign: "center", fontWeight: 700 }}>
              *** REFUNDED {new Date(bill.refundedAt).toLocaleDateString()} ***
              {bill.refundReason ? <div style={{ fontWeight: 400, fontSize: 11 }}>{bill.refundReason}</div> : null}
            </div>
          )}
          {bill.visit.redeemsPass && (
            <div style={{ textAlign: "center", fontSize: 11 }}>1 visit pass redeemed</div>
          )}
        </>
      ) : (
        <div style={{ textAlign: "center", fontWeight: 700 }}>NOT PAID — current tab</div>
      )}

      <div style={dashed} />
      <div style={{ textAlign: "center", fontSize: 11 }}>* admission &nbsp;·&nbsp; Thank you — see you at the baths</div>
    </div>
  );
}

export default Receipt;