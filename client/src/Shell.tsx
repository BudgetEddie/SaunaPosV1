// ============================================================================
// THE SHELL — the frame around every screen, and the front door lock.
//
// WHAT IT IS
//   Two things at once:
//     1. The dark sidebar on the left, on every page.
//     2. The sign-in gate for the whole app. If nobody is signed in, this
//        renders the login page INSTEAD of the app — which is why there's no
//        separate "are you allowed in?" check on any of the six screens.
//
// WHERE IT'S USED
//   client/src/main.tsx wraps six routes in it (/, /customers, /pos,
//   /kitchen, /reports, /menu). It is not used anywhere else.
//   Note /receipt/:billId is deliberately NOT wrapped — see main.tsx.
//
// WHAT IT TALKS TO
//   Nothing on the server directly. It only reads and writes the browser's
//   own localStorage notepad.
// ============================================================================

import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import Login from "./Login.tsx";
import { authFetch, type LoggedInUser } from "./authFetch.ts";
import { type Location } from "./types.ts";
import { useDialog } from "./DialogProvider.tsx";
import { soundEnabled, setSoundEnabled } from "./clickSound.ts";

function Shell() {
  // Who's signed in, remembered across page reloads in localStorage — the
  // browser's small per-site notepad.
  //
  // The `?? "null"` matters: on a fresh browser there's nothing stored, and
  // JSON.parse(null) would crash. Feeding it the *text* "null" instead gives
  // us a clean "nobody is signed in" rather than an error. The same trick
  // appears in Home, Checkout, MenuPage, Reports and CustomerDirectory.
  const [user, setUser] = useState<LoggedInUser | null>(
    JSON.parse(localStorage.getItem("user") ?? "null")
  );

  // The tap sound, remembered per terminal like the till's Cards/List choice.
  // A quiet room and an eight-hour shift is exactly when someone wants this off.
  const [sound, setSound] = useState(soundEnabled());

  // THE SITES this business runs, for the location switcher below. Fetched once
  // signed in — never on the login screen, since a token-less /locations call
  // would 401 and bounce us into a reload loop. `user` in the dependency list
  // is what makes it run the moment someone signs in.
  const [locations, setLocations] = useState<Location[]>([]);
  const dialog = useDialog();
  useEffect(() => {
    if (!user) return;
    authFetch("/locations")
      .then((r) => (r.ok ? r.json() : []))
      .then(setLocations)
      .catch(() => {});
  }, [user]);

  // Which site THIS terminal is set to, remembered in the browser's notepad. An
  // unset terminal shows the first location — the same one the server falls back
  // to — so the picture on screen matches the data behind it.
  const storedLocationId = localStorage.getItem("locationId");
  const selectedLocationId = storedLocationId ? Number(storedLocationId) : locations[0]?.id ?? null;

  // Switching is a per-terminal setting, so it's stored and then the page is
  // reloaded — the bluntest possible way to make every screen re-fetch its data
  // under the new site, with no chance of one screen forgetting to.
  const switchLocation = (id: number) => {
    localStorage.setItem("locationId", String(id));
    window.location.reload();
  };

  // ADMIN adds a site. It starts with an empty menu, so we switch straight to it
  // — the admin's next move is always to start building that menu.
  const addLocation = async () => {
    const name = await dialog.askText("Name the new location", {
      title: "Add a location",
      placeholder: "e.g. Toronto",
      confirmLabel: "Create",
    });
    if (name === null) return; // cancelled, as opposed to left blank
    if (!name.trim()) {
      await dialog.say("A location needs a name.");
      return;
    }
    const res = await authFetch("/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      await dialog.say(err.error ?? "Couldn't add that location.");
      return;
    }
    const created = await res.json();
    switchLocation(created.id);
  };

  // THE GATE. Nobody signed in means the login page is all that exists — the
  // sidebar and the six screens below are never even built.
  if (!user) {
    return (
      <Login
        // Login can't sign anyone in by itself; it just reports back up here
        // with who it got and the token the server issued. Storing them is
        // this component's job, and setUser then redraws — this time falling
        // past the gate and into the real app.
        onLogin={(loggedIn, token) => {
          localStorage.setItem("token", token);
          localStorage.setItem("user", JSON.stringify(loggedIn));
          setUser(loggedIn);
        }}
      />
    );
  }

  // Admins get two extra sidebar links (Reports and Menu). Hiding a link is a
  // courtesy, not security — typing the address still loads the page. The
  // server is what actually refuses the data.
  const isAdmin = user.role === "ADMIN";

  // Signing out is just forgetting: bin the wristband and the name, then
  // clear state, which re-runs the gate above and lands back on Login.
  const signOut = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#efe9df", color: "#2b2620", fontFamily: "'Hanken Grotesk', system-ui, sans-serif" }}>
      <aside style={{ width: 190, background: "#332c24", color: "#f4efe7", display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh", flexShrink: 0 }}>
        <div style={{ padding: "22px 18px 12px", fontWeight: 800, letterSpacing: ".22em", fontSize: 13 }}>
          BANYA#3
        </div>

        {/* THE LOCATION SWITCHER. Which site this terminal is set to. A single
            location shows as a plain label — there's nothing to choose — and
            only turns into a dropdown once a second site exists. Admins get the
            "add" link in either case, since that's how the second site is born. */}
        <div style={{ padding: "0 16px 14px" }}>
          {locations.length > 1 ? (
            <select
              value={selectedLocationId ?? ""}
              onChange={(e) => switchLocation(Number(e.target.value))}
              style={{ width: "100%", background: "#221d17", color: "#f4efe7", border: "1px solid rgba(244,239,231,.25)", borderRadius: 7, padding: "7px 9px", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}
            >
              {locations.map((l) => (
                // Dark option text would vanish on the dark control on some
                // systems; the near-black keeps the open list readable.
                <option key={l.id} value={l.id} style={{ color: "#2b2620" }}>{l.name}</option>
              ))}
            </select>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "rgba(244,239,231,.85)" }}>
              <span aria-hidden>📍</span>
              {locations[0]?.name ?? "…"}
            </div>
          )}
          {isAdmin && (
            <div
              onClick={addLocation}
              style={{ marginTop: 8, fontSize: 11.5, fontWeight: 600, color: "rgba(244,239,231,.5)", cursor: "pointer" }}
            >
              + Add location
            </div>
          )}
        </div>
        {/* Sidebar links. NavLink is a router link that knows whether it's the
            page you're currently on, and adds class "active" to itself if so —
            that's what lights the current tab up. The styling for both states
            lives in index.css under "App shell". */}
        <nav style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <NavLink to="/" end className="side-link">Home</NavLink>
          <NavLink to="/customers" className="side-link">Customer Directory</NavLink>
          <NavLink to="/pos" className="side-link">Point of Sale</NavLink>
          <NavLink to="/kitchen" className="side-link">Kitchen</NavLink>
          <NavLink to="/bar" className="side-link">Bar</NavLink>
          <NavLink to="/lockers" className="side-link">Lockers</NavLink>
          <NavLink to="/tables" className="side-link">Tables</NavLink>
          {/* Reports and Menu are no longer hidden from staff. Both now ask
              for a manager's password on entry, so hiding them just meant a
              staff member couldn't tell the feature existed. `isAdmin` still
              decides the caption below. */}
          <NavLink to="/reports" className="side-link">Reports</NavLink>
          {/* An empty stretchy box that eats all the leftover height, pushing
              Menu and the sign-out button down to the bottom of the sidebar. */}
          <div style={{ flex: 1 }} />
          <NavLink to="/menu" className="side-link">Menu</NavLink>
          <div
            onClick={() => { const next = !sound; setSound(next); setSoundEnabled(next); }}
            title={sound ? "Turn the app's sounds off" : "Turn the app's sounds on"}
            style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 18px 0", padding: "7px 0", fontSize: 12, fontWeight: 600, color: sound ? "rgba(244,239,231,.75)" : "rgba(244,239,231,.4)", cursor: "pointer" }}
          >
            <span style={{ fontSize: 13 }}>{sound ? "🔊" : "🔇"}</span>
            {/* "Sound", not "Tap sound" — this switch also silences the chime
                that plays when a guest is checked out. */}
            {sound ? "Sound on" : "Sound off"}
          </div>
          <div style={{ padding: "12px 18px 6px", fontSize: 12, color: "rgba(244,239,231,.55)" }}>
            {user.displayName} · {isAdmin ? "admin" : "staff"}
          </div>
          <button
            onClick={signOut}
            style={{ margin: "6px 18px 18px", padding: "8px 0", background: "transparent", border: "1px solid rgba(244,239,231,.35)", color: "#f4efe7", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
          >
            Sign out
          </button>
        </nav>
      </aside>

      {/* Outlet is the hole the current screen gets dropped into. Whichever of
          the six routes in main.tsx matches the address bar renders right
          here, with the sidebar above staying put. */}
      <main style={{ flex: 1, minWidth: 0 }}>
        <Outlet />
      </main>
    </div>
  );
}

export default Shell;