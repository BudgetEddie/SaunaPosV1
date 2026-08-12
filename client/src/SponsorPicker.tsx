// ============================================================================
// SPONSOR PICKER — "whose pass is paying for this?"
//
// WHAT IT IS
//   A small overlay listing every customer, with a search box, for choosing
//   who a sponsored pass comes out of. Deliberately searches the WHOLE
//   directory rather than today's guests: the person paying often isn't in the
//   building — a member phones ahead, or buys a pack and sends a friend in.
//
// WHERE IT'S USED
//   Twice, which is the only reason it's a file of its own:
//     CustomerDirectory.tsx — at check-in, as the guest arrives
//     PointOfSale.tsx       — from the admission tiles, to fix it later
//
// WHAT IT TALKS TO
//   GET /customers — the same list the directory itself uses.
//
// It shows each customer's pass balance, and greys out anyone on zero. That's
// a courtesy, not the rule: the server does the real check, and it counts
// guests already checked in on that person as well as the raw balance.
// ============================================================================

import { useEffect, useState } from "react";
import { authFetch } from "./authFetch.ts";
import { type Customer } from "./types.ts";

export function SponsorPicker({
  onPick,
  onCancel,
}: {
  onPick: (c: Customer) => void;
  onCancel: () => void;
}) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    authFetch(`/customers`).then((r) => r.json()).then(setCustomers).catch(() => setCustomers([]));
  }, []);

  const q = query.trim().toLowerCase();
  const matches = q
    ? customers.filter((c) => `${c.firstName} ${c.lastName}`.toLowerCase().includes(q))
    : customers;

  return (
    <div
      className="ov-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="ov-card" style={{ width: 420, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div className="ov-label">Sponsored pass</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#2b2620", marginTop: 6 }}>
            Whose pass is paying?
          </div>
          <p style={{ fontSize: 13, color: "#6b6152", fontWeight: 600, margin: "8px 0 0", lineHeight: 1.45 }}>
            One pass comes off their balance when this guest checks out — not before.
          </p>
        </div>

        <input
          className="ov-in"
          autoFocus
          placeholder="Search everyone by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid rgba(43,38,32,.09)", borderRadius: 11 }}>
          {matches.map((c) => {
            // Greyed out at zero — but the server still has the final say, and
            // it also counts guests already relying on this person.
            const broke = c.visitPassBalance < 1;
            return (
              <div
                key={c.id}
                onClick={() => !broke && onPick(c)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "11px 13px", borderBottom: "1px solid rgba(43,38,32,.06)",
                  cursor: broke ? "default" : "pointer", opacity: broke ? 0.45 : 1,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700 }}>
                  {c.firstName} {c.lastName}
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: broke ? "#a4442c" : "#7a6a53" }}>
                  {c.visitPassBalance} pass{c.visitPassBalance === 1 ? "" : "es"}
                </div>
              </div>
            );
          })}
          {matches.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", fontSize: 13, fontWeight: 600, color: "#a89a86" }}>
              {query ? `Nobody matches “${query}”.` : "No customers yet."}
            </div>
          )}
        </div>

        <button type="button" className="ov-btn ov-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
