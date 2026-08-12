// ============================================================================
// THE PRINTABLE RECEIPT — one bill, laid out like till roll.
//
// WHAT IT IS
//   A deliberately plain page in a typewriter font, sized to receipt paper.
//   The "Print receipt" button hands it to the browser's print dialogue.
//
// WHERE IT'S USED
//   Its own address, /receipt/123, opened in a NEW BROWSER TAB from:
//     - Checkout.tsx, on the green "paid" screen
//     - Reports.tsx, from a closed bill in the day's list
//   Both use window.open(...) rather than a link, so searching the code for
//   "Receipt" won't show those two connections — this note is the only record.
//
//   Because it opens in a fresh tab it is NOT wrapped in Shell.tsx (see the
//   route list in main.tsx), so it gets no sidebar — right for printing — but
//   also doesn't inherit Shell's sign-in gate, which is why it checks for a
//   token itself below.
//
// WHAT IT TALKS TO
//   GET /bills/:billId  → the bill, its charges, the guest and the locker.
//   Handled in server/src/index.ts.
// ============================================================================

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

// The database stores payment methods in shouty form; these are the readable
// versions for the printed line.
const METHOD_LABELS: Record<string, string> = {
  CASH: "cash",
  CARD: "card",
  GIFT_CARD: "gift card",
  VISIT_PASS: "visit pass",
};

// What the server sends back for one bill. This screen declares its own shape
// rather than using types.ts, because it needs fields the shared Bill doesn't
// carry — the refund stamps and who the guest was.
type BillData = {
  id: number;
  taxRate: number;
  paymentMethod: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  refundReason: string | null;
  lineItems: { id: number; description: string; amount: number; taxRate: number; isAdmission: boolean }[];
  visit: {
    checkInAt: string;
    redeemsPass: boolean;
    kind: string;
    takeoutNumber: number | null;
    takeoutName: string | null;
    customer: { firstName: string; lastName: string } | null;
    locker: { number: string } | null;
  };
};

// 4.5 → "$4.50". This tiny helper is redefined in six screens rather than
// shared; it's two lines, so nobody has bothered to centralise it.
function money(n: number) {
  // Discounts are negative, and "$-5.00" reads like a typo. Put the minus in
  // front of the whole thing — "−$5.00" — the way a receipt would.
  return n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

// One line of the receipt: label on the left, figure pushed to the right.
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
  // Pull the number out of the address: /receipt/123 gives billId = "123".
  const { billId } = useParams();
  const [bill, setBill] = useState<BillData | null>(null);

  // This page isn't behind Shell's gate, so it does its own check. Opening a
  // receipt tab in a browser that was never signed in shows a note instead.
  const signedIn = Boolean(localStorage.getItem("token"));

  // Fetch the bill once the page opens. Re-runs if the address changes to a
  // different bill number.
  useEffect(() => {
    if (!signedIn) return;
    authFetch(`/bills/${billId}`).then((r) => r.json()).then(setBill);
  }, [billId, signedIn]);

  if (!signedIn) {
    return <p style={{ fontFamily: "sans-serif", padding: 24 }}>Not signed in. <a href="/">Open the register</a> first.</p>;
  }
  // The bill hasn't arrived yet — the request above is still in flight.
  if (!bill) {
    return <p style={{ fontFamily: "sans-serif", padding: 24 }}>Loading receipt…</p>;
  }

  // Add up the charges. Tax is worked out per line, because each charge
  // carries its own frozen rate — a 0% service can sit beside a 13% sandwich.
  const subtotal = bill.lineItems.reduce((sum, li) => sum + li.amount, 0);
  const tax = bill.lineItems.reduce((sum, li) => sum + li.amount * li.taxRate, 0);
  const total = subtotal + tax;
  // Date the receipt by when it was paid. An unpaid tab has no payment time,
  // so fall back to when they walked in.
  const when = bill.paidAt ?? bill.visit.checkInAt;

  return (
    <div style={{ maxWidth: 320, margin: "24px auto", fontFamily: "'Courier New', monospace", fontSize: 13, color: "#000", background: "#fff", padding: 20, borderRadius: 6 }}>
      {/* Class "no-print" hides this button on paper — see the @media print
          rule in index.css. Without it, every receipt would come out with a
          grey rectangle at the top. */}
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
      <Row
        left={new Date(when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        right={bill.visit.locker ? `Locker ${bill.visit.locker.number}` : `Takeout #${bill.visit.takeoutNumber ?? "?"}`}
      />
      {/* A staying guest is named; a takeout customer usually isn't, and a
          receipt shouldn't invent one. The line is simply left off. */}
      {bill.visit.customer ? (
        <Row left="Guest" right={`${bill.visit.customer.firstName} ${bill.visit.customer.lastName}`} />
      ) : bill.visit.takeoutName ? (
        <Row left="Name" right={bill.visit.takeoutName} />
      ) : null}

      <div style={dashed} />
      {/* Every charge, one per line. A "*" marks the entry fee — the footnote
          at the bottom explains it. Unlike the Checkout screen, identical
          items aren't merged here; a receipt lists each one. */}
      {bill.lineItems.map((li) => (
        <Row key={li.id} left={li.description + (li.isAdmission ? " *" : "")} right={money(li.amount)} />
      ))}
      {bill.lineItems.length === 0 && <div>(no charges)</div>}

      <div style={dashed} />
      <Row left="Subtotal" right={money(subtotal)} />
      {/* The tax percentage is worked out backwards from the totals rather
          than looked up. It has to be: a bill can mix several rates, so there
          isn't a single "the" rate to print. */}
      <Row left={subtotal > 0 ? `HST (${((tax / subtotal) * 100).toFixed(2)}%)` : "HST"} right={money(tax)} />
      <Row left="TOTAL" right={money(total)} bold />

      <div style={dashed} />
      {/* A receipt can be printed mid-visit as a running tab, so the footer
          says either how it was paid or that it hasn't been yet. */}
      {bill.paidAt ? (
        <>
          <div style={{ textAlign: "center", fontWeight: 700 }}>
            PAID — {(METHOD_LABELS[bill.paymentMethod ?? ""] ?? bill.paymentMethod ?? "").toUpperCase()}
          </div>
          {/* Refunds don't erase anything — the bill keeps all its charges and
              gets stamped instead, so a reprint still shows what was sold and
              that the money went back. */}
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