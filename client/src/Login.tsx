// ============================================================================
// THE SIGN-IN PAGE — the steam logo, the name and passphrase, the staff chips.
//
// WHAT IT IS
//   The screen staff see before the app opens. Most of the file's length is
//   the artwork: a hand-drawn steam burst that shimmers, drawn in SVG.
//
// WHERE IT'S USED
//   Only by client/src/Shell.tsx, which shows this INSTEAD of the whole app
//   whenever nobody is signed in. It has no address of its own — you can't
//   navigate to "/login", because there isn't one.
//
//   It doesn't sign anyone in by itself. When the server accepts the
//   passphrase, this calls the `onLogin` function Shell handed down, and
//   Shell does the remembering.
//
// WHAT IT TALKS TO
//   GET  /login-roster  → the list of accounts, for the quick-sign-in chips
//   POST /login         → name + passphrase, gets a token back
//   Both live in server/src/index.ts, and both are deliberately open to
//   people who aren't signed in yet — they're defined above the guard line.
//
//   This is the one file that uses plain `fetch` instead of `authFetch`:
//   there's no token to attach until this screen succeeds.
// ============================================================================

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { API, type LoggedInUser } from "./authFetch.ts";

// One staff account, as the server describes it. (The same little shape is
// re-declared in Home, Checkout, Kitchen and CustomerDirectory — they all show
// the same row of "on shift" avatars.)
type RosterEntry = { username: string; displayName: string; role: string };

// Deterministic "hand-drawn" steam rays — same math as the design mockup.
// The seeded random means the burst looks identical on every load.
//
// Working out the shape of the logo: `n` lines fanning out from a centre
// point, each a slightly different length and thickness with a slight bend,
// so it looks drawn by hand rather than by a compass.
//
// The trick is that `rand()` isn't really random. It's a formula that produces
// a scrambled-looking but completely repeatable sequence from the starting
// number 7.3 — so the "hand-drawn" wobble is the SAME wobble every time the
// page loads, instead of the logo redrawing itself differently on each visit.
function buildRays(n: number) {
  let s = 7.3;
  const rand = () => {
    s = Math.sin(s) * 43758.5453;
    return s - Math.floor(s);
  };
  // Centre of the drawing, and how far from it each ray starts.
  const cx = 100, cy = 100, inner = 16;
  const rays: { d: string; w: string }[] = [];
  for (let i = 0; i < n; i++) {
    // Space the rays evenly around a full circle, starting at 12 o'clock.
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const len = 46 + rand() * 20;
    const bend = (rand() - 0.5) * 10;
    const nx = Math.cos(a), ny = Math.sin(a);
    const px = -ny, py = nx;
    const x1 = cx + nx * inner, y1 = cy + ny * inner;
    const x2 = cx + nx * len, y2 = cy + ny * len;
    const mx = cx + (nx * (inner + len)) / 2 + px * bend;
    const my = cy + (ny * (inner + len)) / 2 + py * bend;
    // `d` is the drawing instruction in SVG's own shorthand: Move to the
    // start, then draw a Quadratic curve bending through the middle point to
    // the end. `w` is how thick to draw it.
    rays.push({
      d: `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      w: (2.6 + rand() * 2.2).toFixed(1),
    });
  }
  return rays;
}

// "Anna Petrova" → "AP", for the little round avatar chips.
function initials(name: string) {
  return name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

// `onLogin` is a function passed down from Shell.tsx. Calling it is how this
// screen reports success upward — it's the only way a child component can tell
// its parent anything.
function Login({ onLogin }: { onLogin: (user: LoggedInUser, token: string) => void }) {
  const [attendant, setAttendant] = useState("");   // the name box
  const [pin, setPin] = useState("");               // the passphrase box
  const [status, setStatus] = useState("");         // the italic line under the button
  const [roster, setRoster] = useState<RosterEntry[]>([]);  // staff for the chips

  // Build the steam rays once and reuse them. Without useMemo they'd be
  // recalculated on every keystroke in the passphrase box — harmless, but
  // pointless work.
  const rays = useMemo(() => buildRays(12), []);

  // Runs once, when the login screen first appears.
  useEffect(() => {
    // Fetch the staff list for the quick-sign-in chips. The empty `.catch`
    // means "if the server is down, just skip the chips" — the name and
    // passphrase boxes still work, so there's nothing to warn about yet.
    fetch(`${API}/login-roster`).then((r) => r.json()).then(setRoster).catch(() => {});

    // If this computer is set to reduce motion (an accessibility setting for
    // people who find animation uncomfortable), physically rip the animation
    // tags out of the steam artwork. Reaching into the page like this is
    // unusual in React — it's done here because the shimmer is built from raw
    // SVG <animate> tags that React isn't managing.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.querySelectorAll(".lg-page animate").forEach((el) => el.remove());
    }
  }, []);

  // Runs when the form is submitted — the button, or Enter in either box.
  const onSubmit = async (e: FormEvent) => {
    // Stop the browser's built-in behaviour of reloading the whole page on
    // submit, which would throw away everything React is holding.
    e.preventDefault();

    const who = attendant.trim();
    if (!who) {
      setStatus("Enter a name or staff number to continue.");
      return;
    }
    setStatus("Warming the register…");
    try {
      // Ask the server to check the passphrase. It compares against a
      // scrambled version stored in the database — the real passphrase is
      // never saved anywhere, so not even an admin can look it up.
      const res = await fetch(`${API}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: who, password: pin }),
      });
      // A refusal is a normal answer, not a crash — show what the server said.
      if (!res.ok) {
        const { error } = await res.json();
        setStatus(error ?? "Wrong name or passphrase.");
        return;
      }
      // Accepted. `token` is the wristband every later request will carry.
      const { token, user } = await res.json();
      setStatus(`Register open — have a good shift, ${user.displayName.split(" ")[0]}.`);
      // A deliberate 700ms pause so the greeting is actually readable before
      // the screen changes. Handing the token to Shell is what opens the app.
      setTimeout(() => onLogin(user, token), 700);
    } catch {
      // We only land here if the request never arrived at all — a wrong
      // passphrase is handled above. So this really does mean "no server".
      setStatus("Can't reach the server — is it running?");
    }
  };

  return (
    <div className="lg-page" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "32px 20px", position: "relative", background: "radial-gradient(120% 90% at 50% 8%,#4a4236 0%,#3a332a 42%,#2b2620 100%)" }}>
      {/* faint mosaic-tile grid, like a bathhouse floor */}
      <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(244,239,231,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(244,239,231,.09) 1px,transparent 1px)", backgroundSize: "44px 44px", maskImage: "radial-gradient(120% 80% at 50% 40%,#000 30%,transparent 78%)", WebkitMaskImage: "radial-gradient(120% 80% at 50% 40%,#000 30%,transparent 78%)", opacity: 0.5, pointerEvents: "none" }} />

      {/* SVG filters: the line-boil turbulence */}
      {/* These two are invisible themselves — they're reusable image effects,
          defined once here and referenced by name further down. "boil" jitters
          the artwork a few times a second so the ink looks alive; it's what
          the reduced-motion check above strips out. */}
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
              {/* Draw each ray buildRays() worked out above. `key` isn't a
                  visible attribute — React needs a stable label per item in
                  any repeated list to track them between redraws. */}
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
        {/* Tapping a chip only fills in the name box — it never skips the
            passphrase. It's a shortcut for typing, not a way in. */}
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