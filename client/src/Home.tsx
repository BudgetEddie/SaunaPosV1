import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { io } from "socket.io-client";
import { authFetch, type LoggedInUser } from "./authFetch.ts";

const socket = io("http://localhost:4000");

type Visit = {
  id: number;
  checkInAt: string;
  customer: { firstName: string; lastName: string; gender: string; notes: string | null };
  locker: { number: string };
};
type Locker = { id: number; gender: string; status: string };
type Order = { id: number; status: string };
type RosterEntry = { username: string; displayName: string; role: string };

function fmtDuration(iso: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function sinceLabel(iso: string) {
  return `since ${new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function initials(name: string) {
  return name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

function Dial({ free, total, label }: { free: number; total: number; label: string }) {
  const full = total > 0 && free === 0;
  const occupied = total - free;
  const TICKS = 48;
  const lit = total > 0 ? Math.round((occupied / total) * TICKS) : 0;
  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 18, display: "flex", gap: 16, alignItems: "center", flex: 1, minWidth: 250, border: full ? "1.5px solid #b5563a" : "1.5px solid transparent" }}>
      <svg viewBox="0 0 120 120" style={{ width: 104, height: 104, flexShrink: 0 }}>
        {Array.from({ length: TICKS }, (_, i) => {
          const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
          const x1 = 60 + Math.cos(a) * 43, y1 = 60 + Math.sin(a) * 43;
          const x2 = 60 + Math.cos(a) * 54, y2 = 60 + Math.sin(a) * 54;
          return (
            <line
              key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={full ? "#b5563a" : i < lit ? "#7a6a53" : "#e6dfd1"}
              strokeWidth={3}
              strokeLinecap="round"
            />
          );
        })}
        <text x="60" y="60" textAnchor="middle" fontSize={full ? 19 : 27} fontWeight={800} fill={full ? "#b5563a" : "#2b2620"} fontFamily="inherit">
          {full ? "FULL" : free}
        </text>
        <text x="60" y="77" textAnchor="middle" fontSize={8.5} letterSpacing={1.4} fill="#8a7f6d" fontFamily="inherit">
          {full ? `${total} / ${total}` : "AVAILABLE"}
        </text>
      </svg>
      <div>
        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: ".16em", color: "#8a7f6d" }}>{label}</div>
        <div style={{ fontSize: 21, fontWeight: 800, color: full ? "#b5563a" : "#2b2620" }}>
          {full ? "Full" : `${free} free`}
        </div>
        <div style={{ fontSize: 12.5, color: "#8a7f6d" }}>{occupied} occupied · {total} total</div>
      </div>
    </div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: "#fff", borderRadius: 14, padding: 18, ...style }}>{children}</div>;
}

const CARD_LABEL: React.CSSProperties = { fontSize: 11.5, fontWeight: 800, letterSpacing: ".16em", color: "#8a7f6d", marginBottom: 10 };

function Home() {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [, setTick] = useState(0); // bumping this re-renders the clock + durations
  const user: LoggedInUser | null = JSON.parse(localStorage.getItem("user") ?? "null");

  const loadAll = () => {
    authFetch(`/visits/active`).then((r) => r.json()).then(setVisits);
    authFetch(`/lockers`).then((r) => r.json()).then(setLockers);
    authFetch(`/orders/open`).then((r) => r.json()).then(setOrders);
  };

  useEffect(() => {
    loadAll();
    authFetch(`/login-roster`).then((r) => r.json()).then(setRoster);

    const refresh = () => loadAll();
    socket.on("visit:checked-in", refresh);
    socket.on("visit:checked-out", refresh);
    socket.on("visit:locker-changed", refresh);
    socket.on("locker:updated", refresh);
    socket.on("orders:changed", refresh);
    socket.on("bill:line-item-added", refresh);

    const timer = setInterval(() => setTick((t) => t + 1), 60000);
    return () => {
      socket.off("visit:checked-in", refresh);
      socket.off("visit:checked-out", refresh);
      socket.off("visit:locker-changed", refresh);
      socket.off("locker:updated", refresh);
      socket.off("orders:changed", refresh);
      socket.off("bill:line-item-added", refresh);
      clearInterval(timer);
    };
  }, []);

  const count = (g: string, status?: string) =>
    lockers.filter((l) => l.gender === g && (!status || l.status === status)).length;
  const freeM = count("MALE", "AVAILABLE"), totalM = count("MALE");
  const freeF = count("FEMALE", "AVAILABLE"), totalF = count("FEMALE");

  const menIn = visits.filter((v) => v.customer.gender === "MALE").length;
  const womenIn = visits.length - menIn;

  const kitchenCount = (s: string) => orders.filter((o) => o.status === s).length;

  const fullPools = [
    ...(totalM > 0 && freeM === 0 ? [`Men at capacity (${totalM}/${totalM})`] : []),
    ...(totalF > 0 && freeF === 0 ? [`Women at capacity (${totalF}/${totalF})`] : []),
  ];

  const now = new Date();

  return (
    <div style={{ padding: "18px 26px 30px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>
            {greeting()}, {user?.displayName ?? "there"}
          </h1>
          <div style={{ color: "#8a7f6d", fontSize: 13, marginTop: 2 }}>
            {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
            {" · "}
            {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "#8a7f6d" }}>On shift</span>
          {roster.map((s) => (
            <span
              key={s.username}
              title={`${s.displayName} · ${s.role === "ADMIN" ? "Admin" : "Staff"}`}
              style={{ width: 30, height: 30, borderRadius: "50%", background: "#e6dfd1", color: "#5c5344", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}
            >
              {initials(s.displayName)}
            </span>
          ))}
          <Link
            to="/customers"
            style={{ background: "#4a4236", color: "#fffdf9", padding: "11px 22px", borderRadius: 10, textDecoration: "none", fontWeight: 700, fontSize: 14 }}
          >
            Check In
          </Link>
        </div>
      </div>

      {/* At-capacity banner */}
      {fullPools.length > 0 && (
        <div style={{ marginTop: 14, background: "#f6ded8", color: "#8f3b26", padding: "10px 16px", borderRadius: 10, fontWeight: 700, fontSize: 13.5 }}>
          ● {fullPools.join(" · ")}
        </div>
      )}

      {/* Main grid */}
      <div style={{ display: "flex", gap: 16, marginTop: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Left column */}
        <div style={{ flex: 2.2, minWidth: 460, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Dial free={freeM} total={totalM} label="MEN" />
            <Dial free={freeF} total={totalF} label="WOMEN" />
          </div>

          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={CARD_LABEL}>GUESTS IN THE BATHS</div>
              <Link to="/pos" style={{ color: "#8f5340", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>
                See all →
              </Link>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  {["LOCKER", "GUEST", "DURATION", "NOTE"].map((h) => (
                    <th key={h} style={{ textAlign: "left", fontSize: 10.5, letterSpacing: ".12em", color: "#8a7f6d", padding: "8px 6px", borderBottom: "1px solid #eee7da" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visits.slice(0, 8).map((v) => (
                  <tr key={v.id}>
                    <td style={{ padding: "10px 6px", borderBottom: "1px solid #f3ede2", fontWeight: 700, color: "#5c5344" }}>
                      {v.locker.number}
                    </td>
                    <td style={{ padding: "10px 6px", borderBottom: "1px solid #f3ede2" }}>
                      <div style={{ fontWeight: 700 }}>{v.customer.firstName} {v.customer.lastName}</div>
                      <div style={{ fontSize: 12, color: "#8a7f6d" }}>{sinceLabel(v.checkInAt)}</div>
                    </td>
                    <td style={{ padding: "10px 6px", borderBottom: "1px solid #f3ede2", fontWeight: 600 }}>
                      {fmtDuration(v.checkInAt)}
                    </td>
                    <td style={{ padding: "10px 6px", borderBottom: "1px solid #f3ede2" }}>
                      {v.customer.notes ? (
                        <span style={{ background: "#f6ded8", color: "#8f3b26", padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
                          {v.customer.notes}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {visits.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ padding: "16px 6px", color: "#8a7f6d" }}>Nobody checked in right now.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </div>

        {/* Right column */}
        <div style={{ flex: 1, minWidth: 240, display: "flex", flexDirection: "column", gap: 16 }}>
          <Link
            to="/customers"
            style={{ display: "block", textAlign: "center", background: "#fff", border: "1.5px solid #d8cfbd", borderRadius: 12, padding: "13px 0", textDecoration: "none", color: "#2b2620", fontWeight: 700, fontSize: 14 }}
          >
            New Customer
          </Link>

          <Card>
            <div style={CARD_LABEL}>CHECKED IN NOW</div>
            <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1 }}>{visits.length}</div>
            <div style={{ display: "flex", gap: 4, marginTop: 12 }}>
              <div style={{ height: 7, borderRadius: 4, background: "#4a4236", flex: Math.max(menIn, 0.0001) }} />
              <div style={{ height: 7, borderRadius: 4, background: "#cfc4ae", flex: Math.max(womenIn, 0.0001) }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#8a7f6d", marginTop: 6 }}>
              <span>{menIn} men</span>
              <span>{womenIn} women</span>
            </div>
          </Card>

          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={CARD_LABEL}>KITCHEN</div>
              <Link to="/kitchen" style={{ color: "#8f5340", textDecoration: "none", fontWeight: 700 }}>→</Link>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { label: "QUEUE", n: kitchenCount("QUEUED"), bg: "#f3ede2" },
                { label: "PREP", n: kitchenCount("IN_PROGRESS"), bg: "#f0e4d4" },
                { label: "READY", n: kitchenCount("READY"), bg: "#e2eadb" },
              ].map((t) => (
                <div key={t.label} style={{ flex: 1, background: t.bg, borderRadius: 10, padding: "12px 0", textAlign: "center" }}>
                  <div style={{ fontSize: 20, fontWeight: 800 }}>{t.n}</div>
                  <div style={{ fontSize: 10, letterSpacing: ".1em", color: "#8a7f6d", fontWeight: 700 }}>{t.label}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default Home;