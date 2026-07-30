import { useEffect, useRef, useState } from "react";
import { authFetch } from "./authFetch.ts";
import { type BillLineItem, type Visit } from "./types.ts";

type RosterEntry = { username: string; displayName: string; role: string };
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
  ids: number[];
};

function groupBill(items: BillLineItem[]): BillRow[] {
  const rows = new Map<string, BillRow>();
  for (const item of items) {
    const key = `${item.description}|${item.amount}|${item.isAdmission}`;
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
        ids: [item.id],
      });
    }
  }
  return Array.from(rows.values());
}

function money(n: number) {
  return `$${n.toFixed(2)}`;
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
const ROW = "1fr 60px 100px 92px";

const METHODS = [
  { id: "CASH", label: "Cash" },
  { id: "CARD", label: "Card" },
];

function Checkout({ visit, onBack, onDone }: { visit: Visit; onBack: () => void; onDone: () => void }) {
  const [method, setMethod] = useState("CARD");
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [paid, setPaid] = useState<Paid | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<number[]>([]);
  const [, setTick] = useState(0);

  const seenIds = useRef<Set<number>>(new Set(visit.bill.lineItems.map((i) => i.id)));
  const freshTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);

  const user = JSON.parse(localStorage.getItem("user") ?? "null");
  const isAdmin = user?.role === "ADMIN";

  useEffect(() => {
    authFetch(`/login-roster`).then((r) => r.json()).then(setRoster);
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  // Runs after every render: anything on the bill we haven't seen before just
  // arrived (usually the kitchen, or another terminal) — flash it green.
  useEffect(() => {
    const added = visit.bill.lineItems.filter((i) => !seenIds.current.has(i.id)).map((i) => i.id);
    visit.bill.lineItems.forEach((i) => seenIds.current.add(i.id));
    if (added.length === 0) return;
    setFresh(added);
    if (freshTimer.current) clearTimeout(freshTimer.current);
    freshTimer.current = window.setTimeout(() => setFresh([]), 2400);
  });

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  };

  const rows = groupBill(visit.bill.lineItems);
  const subtotal = visit.bill.lineItems.reduce((sum, i) => sum + i.amount, 0);
  const tax = visit.bill.lineItems.reduce((sum, i) => sum + i.amount * i.taxRate, 0);
  const total = subtotal + tax;

  // A charge counts as a kitchen item if the kitchen was ever sent something
  // by that name on this visit — that's what puts the "Kitchen" chip on the row.
  const kitchenNames = new Set(
    visit.orders.flatMap((o) => o.items.filter((i) => !i.canceled).map((i) => i.name))
  );

  const voidOne = async (row: BillRow) => {
    const id = row.ids[row.ids.length - 1]; // the most recently rung-up one
    if (!confirm(`Void one "${row.description}" (${money(row.unit)}) from this bill?`)) return;
    const res = await authFetch(`/bills/${visit.bill.id}/line-items/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
    }
  };

  const completeCheckout = async () => {
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
      alert(error);
      return;
    }
    setPaid({
      total,
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
                <div style={{ textAlign: "right", fontSize: 15, fontWeight: 700 }}>{money(row.amount)}</div>
                <div style={{ textAlign: "right" }}>
                  {voiding && !row.isAdmission && (
                    <button
                      onClick={() => voidOne(row)}
                      style={{ padding: "5px 11px", border: "1.5px solid #e0bfb2", borderRadius: 9, background: "#fffdf9", color: "#8f3f28", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                    >
                      Void one
                    </button>
                  )}
                </div>
              </div>
            ))}

            {rows.length === 0 && (
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
                onClick={() => {
                  if (!isAdmin) {
                    showToast("Only an Admin login can apply this.");
                    return;
                  }
                  setVoiding((v) => !v);
                }}
                style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 13, borderRadius: 11, border: `1.5px solid ${voiding ? "#8f3f28" : "#d8cebc"}`, background: "#fffdf9", color: voiding ? "#8f3f28" : "#6b6152", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <rect x="2.5" y="6" width="8" height="5.5" rx="1.3" stroke={voiding ? "#8f3f28" : "#a89a86"} strokeWidth="1.5" />
                  <path d="M4.2 6V4.3a2.3 2.3 0 014.6 0V6" stroke={voiding ? "#8f3f28" : "#a89a86"} strokeWidth="1.5" />
                </svg>
                {voiding ? "Done voiding" : "Void an item"}
              </button>
              <div style={{ fontSize: 11.5, color: "#b8ab97", fontWeight: 600, marginTop: 10, textAlign: "center" }}>
                {voiding ? "Pick a row to remove one of" : "Requires an Admin login · refunds live on Reports"}
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