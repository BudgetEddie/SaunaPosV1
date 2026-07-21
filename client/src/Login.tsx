import { useEffect, useMemo, useState, type FormEvent } from "react";
import { API, type LoggedInUser } from "./authFetch.ts";

type RosterEntry = { username: string; displayName: string; role: string };

// Deterministic "hand-drawn" steam rays — same math as the design mockup.
// The seeded random means the burst looks identical on every load.
function buildRays(n: number) {
  let s = 7.3;
  const rand = () => {
    s = Math.sin(s) * 43758.5453;
    return s - Math.floor(s);
  };
  const cx = 100, cy = 100, inner = 16;
  const rays: { d: string; w: string }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const len = 46 + rand() * 20;
    const bend = (rand() - 0.5) * 10;
    const nx = Math.cos(a), ny = Math.sin(a);
    const px = -ny, py = nx;
    const x1 = cx + nx * inner, y1 = cy + ny * inner;
    const x2 = cx + nx * len, y2 = cy + ny * len;
    const mx = cx + (nx * (inner + len)) / 2 + px * bend;
    const my = cy + (ny * (inner + len)) / 2 + py * bend;
    rays.push({
      d: `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      w: (2.6 + rand() * 2.2).toFixed(1),
    });
  }
  return rays;
}

function initials(name: string) {
  return name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

function Login({ onLogin }: { onLogin: (user: LoggedInUser, token: string) => void }) {
  const [attendant, setAttendant] = useState("");
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState("");
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const rays = useMemo(() => buildRays(12), []);

  useEffect(() => {
    fetch(`${API}/login-roster`).then((r) => r.json()).then(setRoster).catch(() => {});
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.querySelectorAll(".lg-page animate").forEach((el) => el.remove());
    }
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const who = attendant.trim();
    if (!who) {
      setStatus("Enter a name or staff number to continue.");
      return;
    }
    setStatus("Warming the register…");
    try {
      const res = await fetch(`${API}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: who, password: pin }),
      });
      if (!res.ok) {
        const { error } = await res.json();
        setStatus(error ?? "Wrong name or passphrase.");
        return;
      }
      const { token, user } = await res.json();
      setStatus(`Register open — have a good shift, ${user.displayName.split(" ")[0]}.`);
      setTimeout(() => onLogin(user, token), 700);
    } catch {
      setStatus("Can't reach the server — is it running?");
    }
  };

  return (
    <div className="lg-page" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "32px 20px", position: "relative", background: "radial-gradient(120% 90% at 50% 8%,#4a4236 0%,#3a332a 42%,#2b2620 100%)" }}>
      {/* faint mosaic-tile grid, like a bathhouse floor */}
      <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(244,239,231,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(244,239,231,.09) 1px,transparent 1px)", backgroundSize: "44px 44px", maskImage: "radial-gradient(120% 80% at 50% 40%,#000 30%,transparent 78%)", WebkitMaskImage: "radial-gradient(120% 80% at 50% 40%,#000 30%,transparent 78%)", opacity: 0.5, pointerEvents: "none" }} />

      {/* SVG filters: the line-boil turbulence */}
      <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
        <defs>
          <filter id="boil-strong" x="-30%" y="-30%" width="160%" height="160%">
            <feTurbulence type="turbulence" baseFrequency="0.028" numOctaves="2" seed="1" result="n">
              <animate attributeName="seed" values="1;2;3;4;5" dur="0.55s" calcMode="discrete" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="boil-soft" x="-8%" y="-30%" width="116%" height="160%">
            <feTurbulence type="turbulence" baseFrequency="0.012 0.03" numOctaves="1" seed="4" result="n">
              <animate attributeName="seed" values="4;6;8;10" dur="0.7s" calcMode="discrete" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>

      <div style={{ position: "relative", width: "min(400px,100%)", textAlign: "center", zIndex: 1 }}>
        {/* drifting steam behind the burst */}
        <svg viewBox="0 0 220 220" aria-hidden="true" style={{ position: "absolute", left: "50%", top: -18, width: 220, height: 220, transform: "translateX(-50%)", pointerEvents: "none", zIndex: 0 }}>
          <path d="M96 120 q-10 -22 4 -40 q12 -16 0 -34" fill="none" stroke="#f4efe7" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0, animation: "rise 6.5s ease-in-out infinite" }} />
          <path d="M118 124 q12 -20 -2 -42 q-10 -16 4 -32" fill="none" stroke="#f4efe7" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0, animation: "rise 7.8s ease-in-out .9s infinite" }} />
          <path d="M108 128 q-4 -24 6 -44 q8 -14 -2 -30" fill="none" stroke="#f4efe7" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0, animation: "rise 8.6s ease-in-out 2.1s infinite" }} />
        </svg>

        {/* signature: radial steam-burst with animated line boil */}
        <div style={{ position: "relative", zIndex: 1 }}>
          <svg viewBox="0 0 200 200" role="img" aria-label="Rising steam" style={{ width: 132, height: 132 }}>
            <g filter="url(#boil-strong)">
              <g stroke="#b5563a" fill="none" strokeLinecap="round">
                {rays.map((r, i) => (
                  <path key={i} d={r.d} strokeWidth={r.w} />
                ))}
              </g>
              <circle cx="100" cy="100" r="5.5" fill="#c8b9a0" />
            </g>
          </svg>
        </div>

        <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: ".32em", textIndent: ".32em", color: "#f4efe7", margin: "10px 0 3px" }}>BANYA#3</h1>
        <p style={{ fontStyle: "italic", fontWeight: 500, fontSize: 14.5, color: "#b5563a", opacity: 0.92, margin: "0 0 30px" }}>the register at the baths</p>

        <form onSubmit={onSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: 17, textAlign: "left" }}>
          <div className="lg-field" style={{ position: "relative" }}>
            <label htmlFor="attendant" style={{ display: "block", fontSize: 11, fontWeight: 700, letterSpacing: ".2em", textTransform: "uppercase", color: "#c8b9a0", margin: "0 0 7px 2px" }}>Attendant</label>
            <div style={{ position: "relative" }}>
              <svg className="lg-outline" viewBox="0 0 100 52" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                <rect x="1" y="1" width="98" height="50" fill="transparent" stroke="#8f5340" strokeWidth="2" filter="url(#boil-soft)" style={{ transition: "stroke .35s ease" }} />
              </svg>
              <input id="attendant" type="text" autoComplete="username" placeholder="name or staff number" value={attendant} onChange={(e) => setAttendant(e.target.value)} style={{ width: "100%", background: "transparent", border: "none", outline: "none", padding: "14px 16px", fontFamily: "inherit", fontSize: 15, fontWeight: 600, color: "#f4efe7", letterSpacing: ".02em" }} />
            </div>
          </div>

          <div className="lg-field" style={{ position: "relative" }}>
            <label htmlFor="pin" style={{ display: "block", fontSize: 11, fontWeight: 700, letterSpacing: ".2em", textTransform: "uppercase", color: "#c8b9a0", margin: "0 0 7px 2px" }}>Passphrase</label>
            <div style={{ position: "relative" }}>
              <svg className="lg-outline" viewBox="0 0 100 52" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                <rect x="1" y="1" width="98" height="50" fill="transparent" stroke="#8f5340" strokeWidth="2" filter="url(#boil-soft)" style={{ transition: "stroke .35s ease" }} />
              </svg>
              <input id="pin" type="password" autoComplete="current-password" placeholder="••••••••" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: "100%", background: "transparent", border: "none", outline: "none", padding: "14px 16px", fontFamily: "inherit", fontSize: 15, fontWeight: 600, color: "#f4efe7", letterSpacing: ".02em" }} />
            </div>
          </div>

          <button className="lg-btn" type="submit" style={{ position: "relative", marginTop: 10, padding: "15px 16px", border: "none", cursor: "pointer", background: "transparent", color: "#fffdf9", fontFamily: "inherit", fontWeight: 800, letterSpacing: ".22em", fontSize: 13, textTransform: "uppercase", overflow: "hidden" }}>
            <svg className="lg-fill" viewBox="0 0 100 48" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 0 }}>
              <rect x="1" y="1" width="98" height="46" fill="#7a6a53" filter="url(#boil-soft)" style={{ transition: "fill .3s ease" }} />
            </svg>
            <span style={{ position: "relative", zIndex: 1 }}>Open the register</span>
          </button>

          <p role="status" aria-live="polite" style={{ minHeight: 18, margin: "2px 0 0", fontStyle: "italic", fontWeight: 500, fontSize: 14, color: "#c8b9a0", textAlign: "center", opacity: status ? 1 : 0, transition: "opacity .4s ease" }}>{status}</p>
        </form>

        {/* quick sign-in: the on-shift chips, now backed by the real accounts */}
        {roster.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".2em", textTransform: "uppercase", color: "rgba(244,239,231,.38)", marginBottom: 10 }}>Quick sign-in</div>
            <div style={{ display: "flex", justifyContent: "center", gap: 9 }}>
              {roster.map((s) => (
                <div
                  key={s.username}
                  className="lg-chip"
                  title={`${s.displayName} · ${s.role === "ADMIN" ? "Admin" : "Staff"}`}
                  onClick={() => { setAttendant(s.username); setStatus(""); }}
                  style={{ width: 38, height: 38, borderRadius: "50%", border: "1.5px solid rgba(200,185,160,.4)", background: "rgba(244,239,231,.06)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#c8b9a0", cursor: "pointer", transition: "border-color .25s ease,color .25s ease" }}
                >
                  {initials(s.displayName)}
                </div>
              ))}
            </div>
          </div>
        )}

        <p style={{ marginTop: 22, fontSize: 13, fontWeight: 500, color: "rgba(244,239,231,.42)" }}>Locked out? Ask a manager.</p>
      </div>
    </div>
  );
}

export default Login;