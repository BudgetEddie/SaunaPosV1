// ===========================================================================
// MANAGER OVERRIDE — the password prompt, and the plumbing that lets any
// screen summon it.
//
// The problem it solves: a staff member needs to void a charge. Before this,
// that meant finding the owner, signing out, handing over the terminal, and
// signing back in afterwards. Now a manager types their password into a box
// and the staff member carries on, still signed in as themselves.
//
// HOW A SCREEN USES IT
//   const askOverride = useOverride();
//   const token = await askOverride('Void "Green Tea" ($4.50)');
//   if (token === null) return;              // they cancelled
//   authFetch(`/some/admin/thing`, { ... }, token);
//
// Three possible answers, and the middle one is the trick that keeps call
// sites short:
//   a long string — a manager approved it
//   ""            — the person is ALREADY an admin and needs no approval
//   null          — cancelled
// Because "" is falsy, authFetch skips the header and the admin's own login
// does the work. So no screen needs an `if (isAdmin)` branch.
//
// ⚠️ THE PROMPT IS NOT THE SECURITY. Anyone can open the browser console and
//    call the API directly. What makes this real is that the server issues a
//    signed, time-limited, staff-bound token and refuses admin work without
//    one. This modal is just the polite way to obtain it.
// ===========================================================================

import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { authFetch } from "./authFetch.ts";

type Scope = "ACTION" | "PAGE";

// Resolves to a token on approval, "" for an admin who needs none, or null if
// they cancelled.
type Ask = (action: string, scope?: Scope) => Promise<string | null>;

const OverrideContext = createContext<Ask>(async () => null);

export function useOverride() {
  return useContext(OverrideContext);
}

// Who's signed in, according to the browser's own notepad. Only used to skip
// the prompt for admins — the server never trusts this.
function currentRole() {
  try {
    return JSON.parse(localStorage.getItem("user") ?? "null")?.role ?? "";
  } catch {
    return "";
  }
}

export function OverrideProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ action: string; scope: Scope } | null>(null);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // The caller's promise, parked here until they type a password or cancel.
  // This is what lets a screen simply `await askOverride(...)`.
  const resolver = useRef<((token: string | null) => void) | null>(null);

  const ask: Ask = (action, scope = "ACTION") => {
    // An admin is already allowed; don't make them prove it to themselves.
    if (currentRole() === "ADMIN") return Promise.resolve("");

    // Only ever one prompt at a time. Without this, a second request would
    // overwrite `resolver` and the FIRST caller would wait forever on a
    // promise nobody can resolve. That isn't hypothetical: React's StrictMode
    // runs effects twice in development, so any screen that asks on mount
    // asks twice.
    if (resolver.current) return Promise.resolve(null);

    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
      setPassword("");
      setStatus("");
      setBusy(false);
      setPending({ action, scope });
    });
  };

  const finish = (token: string | null) => {
    resolver.current?.(token);
    resolver.current = null;
    setPending(null);
    setPassword("");
    setStatus("");
    setBusy(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pending || busy) return;
    setBusy(true);
    setStatus("");
    const res = await authFetch(`/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, action: pending.action, scope: pending.scope }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Stay open so they can try again — the server refuses a wrong password
      // with 403, deliberately not 401, because authFetch treats 401 as "your
      // session died" and reloads the whole page.
      setStatus(body.error ?? "That didn't work");
      setPassword("");
      setBusy(false);
      return;
    }
    finish(body.token);
  };

  return (
    <OverrideContext.Provider value={ask}>
      {children}
      {pending && (
        <div
          className="ov-back"
          onMouseDown={(e) => {
            // Only a click on the backdrop itself closes it — not a click that
            // started inside the card and drifted out.
            if (e.target === e.currentTarget) finish(null);
          }}
        >
          <form
            className="ov-card"
            onSubmit={submit}
            onKeyDown={(e) => {
              if (e.key === "Escape") finish(null);
            }}
          >
            <div className="ov-label">Manager approval</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#2b2620", marginTop: 6 }}>
              {pending.action}
            </div>
            <p style={{ fontSize: 13, color: "#6b6152", fontWeight: 600, margin: "9px 0 16px", lineHeight: 1.45 }}>
              {pending.scope === "PAGE"
                ? "A manager's password opens this screen for the next few minutes."
                : "A manager's password is needed for this one action."}
            </p>
            <input
              className="ov-in"
              type="password"
              autoFocus
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Admin password"
            />
            {status && <div className="ov-err">{status}</div>}
            <div style={{ display: "flex", gap: 9, marginTop: 16 }}>
              <button type="button" className="ov-btn ov-ghost" onClick={() => finish(null)}>
                Cancel
              </button>
              <button type="submit" className="ov-btn ov-go" disabled={busy || !password}>
                {busy ? "Checking…" : "Approve"}
              </button>
            </div>
          </form>
        </div>
      )}
    </OverrideContext.Provider>
  );
}
