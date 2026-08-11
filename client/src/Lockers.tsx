// ============================================================================
// THE LOCKER BOARD — what's free, what's in use, what's broken.
//
// WHAT IT IS
//   Every locker in the building as a grid of tiles, split into the men's and
//   women's pools. Tapping a tile opens a panel on the right showing what that
//   locker is doing and what can be done about it.
//
//   Three states, and they're the same three the database has always had:
//     AVAILABLE   — free, ready to assign
//     OCCUPIED    — a guest is in it right now
//     MAINTENANCE — broken, hidden from check-in until someone fixes it
//
//   THE ONE RULE: a locker can only go out of service from AVAILABLE, and can
//   only come back to AVAILABLE from MAINTENANCE. An occupied locker can't be
//   marked broken — move the guest first (Front desk → their tab → "Move
//   locker…"), which frees it, and then it can be flagged.
//
// WHERE IT'S USED
//   The "/lockers" route in client/src/main.tsx.
//
// WHAT IT TALKS TO   (all in server/src/index.ts)
//   GET  /lockers              → every locker and its status
//   GET  /visits/active        → who's in the occupied ones
//   POST /lockers/:id/status   → flag broken / return to service
// ============================================================================

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { io } from "socket.io-client";
import { authFetch } from "./authFetch.ts";
import { type Locker, type Visit } from "./types.ts";

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
// panel can never disagree about what "out of service" is coloured.
const LOOK = {
  AVAILABLE:   { label: "Available",      ink: "#3f5540", bg: "#eef4ea", border: "#cfe0c8" },
  OCCUPIED:    { label: "Occupied",       ink: "#fffdf9", bg: "#7a6a53", border: "#7a6a53" },
  MAINTENANCE: { label: "Out of service", ink: "#a89a86", bg: "#efeae3", border: "#ddd5c9" },
} as const;

type Status = keyof typeof LOOK;

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

// One pool's headline numbers. Broken lockers are excluded from the total on
// purpose: "4 of 9 free" should mean nine lockers you could actually put
// somebody in, not nine that exist physically.
function poolStats(lockers: Locker[]) {
  const working = lockers.filter((l) => l.status !== "MAINTENANCE");
  const free = working.filter((l) => l.status === "AVAILABLE").length;
  const broken = lockers.length - working.length;
  return { free, usable: working.length, broken, inUse: working.length - free };
}

function Lockers() {
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [pool, setPool] = useState<"MALE" | "FEMALE">("MALE");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [note, setNote] = useState("");        // the optional "why" box
  const [busy, setBusy] = useState(false);     // stops double-taps mid-request

  // Bumped once a minute so the "in for 2h 05m" labels stay honest.
  const [, setTick] = useState(0);

  const loadLockers = () => authFetch(`/lockers`).then((r) => r.json()).then(setLockers);
  const loadVisits = () => authFetch(`/visits/active`).then((r) => r.json()).then(setVisits);

  useEffect(() => {
    loadLockers();
    loadVisits();

    // Same pattern as everywhere else in this app: the message contents are
    // ignored, each one just means "go and refetch".
    const refresh = () => { loadLockers(); loadVisits(); };
    socket.on("locker:updated", refresh);
    socket.on("visit:checked-in", refresh);
    socket.on("visit:checked-out", refresh);
    socket.on("visit:locker-changed", refresh);

    const timer = setInterval(() => setTick((t) => t + 1), 60000);

    return () => {
      socket.off("locker:updated", refresh);
      socket.off("visit:checked-in", refresh);
      socket.off("visit:checked-out", refresh);
      socket.off("visit:locker-changed", refresh);
      clearInterval(timer);
    };
  }, []);

  // Reading the selected locker out of the live list rather than holding a
  // copy means another terminal's change repaints this panel too.
  const selected = lockers.find((l) => l.id === selectedId) ?? null;
  // Who's in it, if anyone. Only occupied lockers have an active visit.
  const occupant = selected
    ? (visits.find((v) => v.locker.id === selected.id) ?? null)
    : null;

  const inPool = lockers
    .filter((l) => l.gender === pool)
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));

  const stats = {
    MALE: poolStats(lockers.filter((l) => l.gender === "MALE")),
    FEMALE: poolStats(lockers.filter((l) => l.gender === "FEMALE")),
  };

  // Flag broken, or return to service. The server enforces the same rule this
  // screen does — it will refuse an occupied locker even if a stale page
  // somehow offers the button.
  const setStatus = async (status: Status, withNote?: string) => {
    if (!selected || busy) return;
    setBusy(true);
    const res = await authFetch(`/lockers/${selected.id}/status`, {
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
    loadLockers();
  };

  const now = new Date();

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 26px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 800 }}>Lockers</div>
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

        {/* the two pools, as pickable summary cards */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {(["MALE", "FEMALE"] as const).map((g) => {
            const s = stats[g];
            const on = g === pool;
            const full = s.usable > 0 && s.free === 0;
            return (
              <div
                key={g}
                onClick={() => { setPool(g); setSelectedId(null); }}
                style={{ ...PANEL, flex: 1, minWidth: 250, padding: "16px 20px", cursor: "pointer", background: on ? "#fffdf9" : "#efe9df", border: on ? "2px solid #7a6a53" : "1px solid rgba(43,38,32,.08)" }}
              >
                <div style={{ ...LABEL, color: on ? "#7a6a53" : "#a89a86" }}>
                  {g === "MALE" ? "Men's lockers" : "Women's lockers"}
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
                  <span style={{ fontSize: 27, fontWeight: 800, color: full ? "#b5563a" : "#2b2620" }}>
                    {full ? "FULL" : s.free}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#a89a86" }}>
                    of {s.usable} free
                  </span>
                </div>
                <div style={{ height: 7, borderRadius: 20, background: "#e6dfd1", marginTop: 10, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: s.usable > 0 ? `${(s.inUse / s.usable) * 100}%` : "0%", background: full ? "#b5563a" : "#7a6a53" }} />
                </div>
                {s.broken > 0 && (
                  <div style={{ ...MICRO, marginTop: 9, color: "#a89a86" }}>
                    {s.broken} out of service
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 16, alignItems: "start" }}>

          {/* the grid of tiles */}
          <div style={{ ...PANEL, padding: "18px 20px" }}>
            <div style={{ ...LABEL, marginBottom: 14 }}>
              {pool === "MALE" ? "Men's section" : "Women's section"} · {inPool.length} lockers
            </div>
            {inPool.length === 0 ? (
              <div style={{ padding: 30, textAlign: "center", fontSize: 13.5, fontWeight: 600, color: "#b8ab97" }}>
                No lockers in this pool yet.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))", gap: 8 }}>
                {inPool.map((l) => {
                  const look = LOOK[l.status as Status] ?? LOOK.AVAILABLE;
                  const on = l.id === selectedId;
                  return (
                    <div
                      key={l.id}
                      onClick={() => { setSelectedId(l.id); setNote(""); }}
                      title={l.status === "MAINTENANCE" && l.maintenanceNote ? l.maintenanceNote : look.label}
                      style={{
                        height: 52, borderRadius: 10, cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, fontWeight: 800, letterSpacing: .3,
                        background: look.bg, color: look.ink,
                        border: `1px solid ${look.border}`,
                        textDecoration: l.status === "MAINTENANCE" ? "line-through" : "none",
                        boxShadow: on ? "0 0 0 3px rgba(122,106,83,.45)" : "none",
                      }}
                    >
                      {l.number}
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
                Tap a locker to see what it's doing.
              </div>
            ) : (
              <>
                <div>
                  <div style={MICRO}>Locker</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3 }}>
                    <span style={{ fontSize: 26, fontWeight: 800 }}>{selected.number}</span>
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: .4, padding: "4px 10px", borderRadius: 20, color: LOOK[selected.status as Status].ink, background: LOOK[selected.status as Status].bg, border: `1px solid ${LOOK[selected.status as Status].border}` }}>
                      {LOOK[selected.status as Status].label}
                    </span>
                  </div>
                </div>

                {/* OCCUPIED — who's in it, and the way to deal with them */}
                {selected.status === "OCCUPIED" && (
                  <>
                    {occupant ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 14, borderTop: "1px solid rgba(43,38,32,.07)" }}>
                        <div style={{ width: 42, height: 42, flex: "none", borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#7a6a53" }}>
                          {initials(occupant.customer.firstName, occupant.customer.lastName)}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14.5, fontWeight: 800, lineHeight: 1.2 }}>
                            {occupant.customer.firstName} {occupant.customer.lastName}
                          </div>
                          <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a89a86", marginTop: 2 }}>
                            In since {sinceLabel(occupant.checkInAt)} · {fmtDuration(occupant.checkInAt)}
                          </div>
                        </div>
                      </div>
                    ) : (
                      // Marked occupied with no active visit behind it. Shouldn't
                      // happen — check-in and check-out change both together in
                      // one transaction — but say so plainly rather than hide it.
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#8f3f28", background: "#f7e4dc", padding: "10px 12px", borderRadius: 10 }}>
                        Marked occupied, but no active visit is using it. Worth
                        mentioning to whoever maintains this system.
                      </div>
                    )}

                    <Link
                      to={`/pos?locker=${encodeURIComponent(selected.number)}`}
                      style={{ ...BTN_GHOST, display: "block", textAlign: "center", textDecoration: "none" }}
                    >
                      Open their tab →
                    </Link>

                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "#a89a86", lineHeight: 1.5 }}>
                      An occupied locker can't be marked out of service. Move the
                      guest to another locker from their tab first — that frees
                      this one, and then it can be flagged.
                    </div>
                  </>
                )}

                {/* AVAILABLE — the one place out-of-service can be set */}
                {selected.status === "AVAILABLE" && (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#6b6152", paddingTop: 14, borderTop: "1px solid rgba(43,38,32,.07)" }}>
                      Free and ready to assign.
                    </div>
                    <div>
                      <div style={{ ...MICRO, marginBottom: 6 }}>Reason (optional)</div>
                      <input
                        className="cd-in"
                        placeholder="Lock broken, door won't shut…"
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

                {/* MAINTENANCE — why, and the way back */}
                {selected.status === "MAINTENANCE" && (
                  <>
                    <div style={{ paddingTop: 14, borderTop: "1px solid rgba(43,38,32,.07)" }}>
                      <div style={{ ...MICRO, marginBottom: 5 }}>Reason</div>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: selected.maintenanceNote ? "#5f5340" : "#b8ab97" }}>
                        {selected.maintenanceNote || "None given."}
                      </div>
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "#a89a86", lineHeight: 1.5 }}>
                      Hidden from check-in while it's flagged — nobody will be
                      assigned this locker.
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

export default Lockers;