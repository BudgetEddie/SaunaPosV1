import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import Login from "./Login.tsx";
import { type LoggedInUser } from "./authFetch.ts";

function Shell() {
  const [user, setUser] = useState<LoggedInUser | null>(
    JSON.parse(localStorage.getItem("user") ?? "null")
  );

  if (!user) {
    return (
      <Login
        onLogin={(loggedIn, token) => {
          localStorage.setItem("token", token);
          localStorage.setItem("user", JSON.stringify(loggedIn));
          setUser(loggedIn);
        }}
      />
    );
  }

  const isAdmin = user.role === "ADMIN";

  const signOut = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#efe9df", color: "#2b2620", fontFamily: "'Hanken Grotesk', system-ui, sans-serif" }}>
      <aside style={{ width: 190, background: "#332c24", color: "#f4efe7", display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh", flexShrink: 0 }}>
        <div style={{ padding: "22px 18px 16px", fontWeight: 800, letterSpacing: ".22em", fontSize: 13 }}>
          BANYA#3
        </div>
        <nav style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <NavLink to="/" end className="side-link">Home</NavLink>
          <NavLink to="/customers" className="side-link">Customer Directory</NavLink>
          <NavLink to="/frontdesk" className="side-link">Front desk</NavLink>
          <NavLink to="/kitchen" className="side-link">Kitchen</NavLink>
          <NavLink to="/reports" className="side-link">Reports</NavLink>
          <div style={{ flex: 1 }} />
          {isAdmin && <NavLink to="/menu" className="side-link">Menu</NavLink>}
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

      <main style={{ flex: 1, minWidth: 0 }}>
        <Outlet />
      </main>
    </div>
  );
}

export default Shell;