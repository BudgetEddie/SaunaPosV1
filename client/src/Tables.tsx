// ============================================================================
// THE TABLE BOARD — what's free in the lounge.
//
// WHAT IT IS
//   Every dining table as a grid of tiles, with three states:
//     AVAILABLE   — free, ready to seat
//     OCCUPIED    — people are sitting there
//     MAINTENANCE — out of use; broken chair, spill, whatever
//
//   THE IMPORTANT DIFFERENCE FROM LOCKERS: nothing in the system knows when
//   somebody sits down or gets up. A locker looks after itself — check-in
//   claims one, check-out frees it. A table is maintained entirely by hand, so
//   this board is only ever as accurate as the last person to tap it.
//
//   That's why occupied tiles show how long they've been occupied. A table
//   reading "5h 20m" is how staff spot one that was never cleared. The number
//   costs nobody any extra work — it's just the clock since the tap.
//
//   Tables carry NO billing. Someone eating in the lounge is a checked-in guest
//   and their food goes on their locker tab, exactly as it always has. This
//   screen answers one question: is there somewhere to sit?
//
// WHERE IT'S USED
//   The "/tables" route in client/src/main.tsx.
//
// WHAT IT TALKS TO   (all in server/src/index.ts)
//   GET  /tables             → every table and its status
//   POST /tables/:id/status  → seat, clear, flag broken, return to service
// ============================================================================

import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { authFetch } from "./authFetch.ts";
import { type Table } from "./types.ts";

const socket = io("http://localhost:4000");

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
  padding: "11px 16px", border: "1.5px solid #d8cebc", borderRadius: 11, background: "#fffdf9",
  color: "#5f5340", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: "pointer",
};

// How each state looks, in one place so the tile, the legend and the detail
// panel can never disagree.
const LOOK = {
  AVAILABLE:   { label: "Free",           ink: "#3f5540", bg: "#eef4ea", border: "#cfe0c8" },
  OCCUPIED:    { label: "Occupied",       ink: "#fffdf9", bg: "#7a6a53", border: "#7a6a53" },
  MAINTENANCE: { label: "Out of service", ink: "#a89a86", bg: "#efeae3", border: "#ddd5c9" },
} as const;

type Status = keyof typeof LOOK;

// A table sitting occupied this long has probably just been forgotten. It isn't
// treated as an error — the lounge might genuinely be that slow — but it's worth
// making visible.
const STALE_MINUTES = 240;

function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}
function fmtDuration(iso: string) {
  const mins = minutesSince(iso);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function Tables() {
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [note, setNote] = useState("");        // the optional "why" box
  const [busy, setBusy] = useState(false);     // stops double-taps mid-request

  // Bumped once a minute so the "occupied 2h 05m" labels stay honest. This one
  // earns its keep more than most — the durations are the whole early-warning
  // system for a table nobody cleared.
  const [, setTick] = useState(0);

  const loadTables = () => authFetch(`/tables`).then((r) => r.json()).then(setTables);

  useEffect(() => {
    loadTables();

    socket.on("table:updated", loadTables);
    const timer = setInterval(() => setTick((t) => t + 1), 60000);

    return () => {
      socket.off("table:updated", loadTables);
      clearInterval(timer);
    };
  }, []);

  // Reading the selected table out of the live list rather than holding a copy
  // means another terminal's change repaints this panel too.
  const selected = tables.find((t) => t.id === selectedId) ?? null;

  const sorted = [...tables].sort((a, b) =>
    a.number.localeCompare(b.number, undefined, { numeric: true })
  );

  const working = tables.filter((t) => t.status !== "MAINTENANCE");
  const free = working.filter((t) => t.status === "AVAILABLE").length;
  const broken = tables.length - working.length;
  const full = working.length > 0 && free === 0;
  // Occupied for hours — probably nobody cleared them.
  const stale = tables.filter(
    (t) => t.status === "OCCUPIED" && t.occupiedSince && minutesSince(t.occupiedSince) >= STALE_MINUTES
  ).length;

  const setStatus = async (status: Status, withNote?: string) => {
    if (!selected || busy) return;
    setBusy(true);
    const res = await authFetch(`/tables/${selected.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, note: withNote ?? null }),
    });
    setBusy(false);
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
      return;
    }
    setNote("");
    loadTables();
  };

  const now = new Date();

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 26px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 800 }}>Tables</div>
        <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600 }}>
          {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          {" · "}
          {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </div>
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {(Object.keys(LOOK) as Status[]).map((s) => (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{ width: 13, height: 13, borderRadius: 4, background: LOOK[s].bg, border: `1px solid ${LOOK[s].border}` }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#7a6a53" }}>{LOOK[s].label}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ background: "#f4efe7", minHeight: "100vh" }}>
      {header}

      <div style={{ padding: "22px 26px 28px", display: "flex", flexDirection: "column", gap: 16 }}>

        {/* the headline count */}
        <div style={{ ...PANEL, padding: "16px 20px", display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
          <div>
            <div style={LABEL}>Lounge</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
              <span style={{ fontSize: 27, fontWeight: 800, color: full ? "#b5563a" : "#2b2620" }}>
                {full ? "FULL" : free}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#a89a86" }}>
                of {working.length} free
              </span>
            </div>
          </div>
          {broken > 0 && (
            <div style={{ paddingLeft: 22, borderLeft: "1px solid rgba(43,38,32,.09)" }}>
              <div style={MICRO}>Out of service</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#a89a86", marginTop: 4 }}>{broken}</div>
            </div>
          )}
          {stale > 0 && (
            <div style={{ marginLeft: "auto", fontSize: 12.5, fontWeight: 700, color: "#8f3f28", background: "#f7e4dc", padding: "9px 13px", borderRadius: 10, maxWidth: 340, lineHeight: 1.45 }}>
              {stale === 1 ? "1 table has" : `${stale} tables have`} been occupied over four
              hours. Worth checking whether anyone's actually sitting there.
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 16, alignItems: "start" }}>

          {/* the grid of tiles */}
          <div style={{ ...PANEL, padding: "18px 20px" }}>
            <div style={{ ...LABEL, marginBottom: 14 }}>
              All tables · {tables.length}
            </div>
            {sorted.length === 0 ? (
              <div style={{ padding: 30, textAlign: "center", fontSize: 13.5, fontWeight: 600, color: "#b8ab97" }}>
                No tables set up yet. They're created by the seed script in
                `server/prisma/seed-tables.ts`.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 9 }}>
                {sorted.map((t) => {
                  const look = LOOK[t.status as Status] ?? LOOK.AVAILABLE;
                  const on = t.id === selectedId;
                  const isStale = t.status === "OCCUPIED" && t.occupiedSince && minutesSince(t.occupiedSince) >= STALE_MINUTES;
                  return (
                    <div
                      key={t.id}
                      onClick={() => { setSelectedId(t.id); setNote(""); }}
                      title={t.status === "MAINTENANCE" && t.maintenanceNote ? t.maintenanceNote : look.label}
                      style={{
                        minHeight: 64, borderRadius: 10, cursor: "pointer",
                        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                        padding: "8px 6px",
                        background: look.bg, color: look.ink,
                        border: isStale ? "1.5px solid #b5563a" : `1px solid ${look.border}`,
                        textDecoration: t.status === "MAINTENANCE" ? "line-through" : "none",
                        boxShadow: on ? "0 0 0 3px rgba(122,106,83,.45)" : "none",
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: .3 }}>{t.number}</span>
                      {t.seats != null && t.status !== "OCCUPIED" && (
                        <span style={{ fontSize: 10, fontWeight: 700, opacity: .7 }}>{t.seats} seats</span>
                      )}
                      {t.status === "OCCUPIED" && t.occupiedSince && (
                        <span style={{ fontSize: 10, fontWeight: 700, opacity: .85 }}>
                          {fmtDuration(t.occupiedSince)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* the detail panel */}
          <div style={{ ...PANEL, padding: "18px 20px", position: "sticky", top: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            {!selected ? (
              <div style={{ padding: "26px 6px", textAlign: "center", fontSize: 13.5, fontWeight: 600, color: "#b8ab97" }}>
                Tap a table to seat or clear it.
              </div>
            ) : (
              <>
                <div>
                  <div style={MICRO}>Table</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 26, fontWeight: 800 }}>{selected.number}</span>
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: .4, padding: "4px 10px", borderRadius: 20, color: LOOK[selected.status as Status].ink, background: LOOK[selected.status as Status].bg, border: `1px solid ${LOOK[selected.status as Status].border}` }}>
                      {LOOK[selected.status as Status].label}
                    </span>
                  </div>
                  {selected.seats != null && (
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "#a89a86", marginTop: 5 }}>
                      Seats {selected.seats}
                    </div>
                  )}
                </div>

                {/* FREE — seat it, or take it out of use */}
                {selected.status === "AVAILABLE" && (
                  <>
                    <button
                      onClick={() => setStatus("OCCUPIED")}
                      disabled={busy}
                      style={{ padding: "13px 16px", border: "none", borderRadius: 11, background: "#7a6a53", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: busy ? "default" : "pointer", marginTop: 6 }}
                    >
                      Seat guests
                    </button>
                    <div style={{ paddingTop: 12, borderTop: "1px solid rgba(43,38,32,.07)" }}>
                      <div style={{ ...MICRO, marginBottom: 6 }}>Reason (optional)</div>
                      <input
                        className="cd-in"
                        placeholder="Broken chair, spill, reserved for event…"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </div>
                    <button
                      onClick={() => setStatus("MAINTENANCE", note.trim() || undefined)}
                      disabled={busy}
                      style={{ ...BTN_GHOST, borderColor: "#e0bcb0", color: "#8f3f28", cursor: busy ? "default" : "pointer" }}
                    >
                      Mark out of service
                    </button>
                  </>
                )}

                {/* OCCUPIED — how long, and the way to clear it */}
                {selected.status === "OCCUPIED" && (
                  <>
                    <div style={{ paddingTop: 14, borderTop: "1px solid rgba(43,38,32,.07)" }}>
                      <div style={{ ...MICRO, marginBottom: 5 }}>Occupied for</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: selected.occupiedSince && minutesSince(selected.occupiedSince) >= STALE_MINUTES ? "#b5563a" : "#2b2620" }}>
                        {selected.occupiedSince ? fmtDuration(selected.occupiedSince) : "—"}
                      </div>
                    </div>
                    {selected.occupiedSince && minutesSince(selected.occupiedSince) >= STALE_MINUTES && (
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "#8f3f28", background: "#f7e4dc", padding: "10px 12px", borderRadius: 10, lineHeight: 1.5 }}>
                        That's a long sitting. If nobody's there, clear it — an
                        uncleared table makes the whole board wrong.
                      </div>
                    )}
                    <button
                      onClick={() => setStatus("AVAILABLE")}
                      disabled={busy}
                      style={{ padding: "13px 16px", border: "none", borderRadius: 11, background: "#5f7a5a", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: busy ? "default" : "pointer" }}
                    >
                      Clear table
                    </button>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "#a89a86", lineHeight: 1.5 }}>
                      Nothing is charged here. Anything they ordered is already on
                      their locker tab.
                    </div>
                  </>
                )}

                {/* OUT OF SERVICE — why, and the way back */}
                {selected.status === "MAINTENANCE" && (
                  <>
                    <div style={{ paddingTop: 14, borderTop: "1px solid rgba(43,38,32,.07)" }}>
                      <div style={{ ...MICRO, marginBottom: 5 }}>Reason</div>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: selected.maintenanceNote ? "#5f5340" : "#b8ab97" }}>
                        {selected.maintenanceNote || "None given."}
                      </div>
                    </div>
                    <button
                      onClick={() => setStatus("AVAILABLE")}
                      disabled={busy}
                      style={{ padding: "12px 16px", border: "none", borderRadius: 11, background: "#5f7a5a", color: "#fff", fontFamily: "inherit", fontSize: 13.5, fontWeight: 800, cursor: busy ? "default" : "pointer" }}
                    >
                      Return to service
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Tables;
