// ============================================================================
// THE PHONE LINE TO THE SERVER — every request in the app goes through here.
//
// WHAT IT IS
//   Three small things: the server's address, a description of a signed-in
//   user, and one function that asks the server for something with the
//   sign-in token attached.
//
// WHERE IT'S USED
//   The most-imported file in the client — 10 of the 12 modules use it:
//     Shell.tsx, Login.tsx, Home.tsx, CustomerDirectory.tsx,
//     PointOfSale.tsx, Checkout.tsx, StationBoard.tsx, MenuPage.tsx,
//     Reports.tsx, Receipt.tsx
//   Login.tsx is the odd one out: it uses plain `fetch` with API, because at
//   sign-in time there is no token yet to attach.
// ============================================================================

// Where the server lives.
//
// In production the server serves the client too, so both share an origin and
// SERVER_ORIGIN is empty — the browser fills in whatever host the page came
// from. In development the client is on Vite's port and the server on 4000, so
// client/.env.development points at it.
//
// The `: string` is deliberate. Vite types every VITE_ variable as `any`, and
// without the label that `any` would spread into both exports below — a typo in
// the variable name would then sail through the build and only show up as a
// broken app.
//
// TWO exports, and they are NOT interchangeable:
//
//   API         base for fetch(). Ends in /api.
//
//   SOCKET_URL  base for io(). Must NOT include /api. socket.io reads a
//               leading slash as a NAMESPACE, not a path — io("/api") would
//               quietly connect to the wrong place and live updates would
//               stop working with no error anywhere. `undefined` is the
//               correct way to say "same origin as this page"; an empty
//               string is not, it builds the broken URL "http://".
const SERVER_ORIGIN: string = import.meta.env.VITE_SERVER_ORIGIN ?? "";
export const API = `${SERVER_ORIGIN}/api`;
export const SOCKET_URL = SERVER_ORIGIN || undefined;

// What the server tells us about whoever signed in. `role` is "ADMIN" or
// "STAFF", and it's what the Reports and Menu screens check.
export type LoggedInUser = { username: string; displayName: string; role: string };

// fetch, but with the sign-in token attached. If the server says the token
// is missing or expired (401), wipe it and reload — which lands on the login page.
//
// Two things it deliberately does NOT do, which is why every caller looks the
// way it does:
//   - It doesn't unpack the answer, so callers write `.then(r => r.json())`.
//   - It doesn't complain when the server refuses. A "no" is a perfectly
//     normal answer here, so callers check `res.ok` themselves.
// The third argument is a manager's permission slip, for the handful of calls
// that need one. Optional, so all ~40 existing calls are untouched.
export async function authFetch(path: string, options: RequestInit = {}, override?: string | null) {
  // The wristband we were given at sign-in. Missing on the login screen.
  const token = localStorage.getItem("token");
  // WHICH SITE this terminal is set to. The switcher in Shell.tsx writes it to
  // localStorage; the server reads it (see currentLocation) to scope the menu
  // and settings. Absent on a fresh terminal, in which case the server falls
  // back to the first location — so this is safe to leave unset.
  const locationId = localStorage.getItem("locationId");
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      // Keep whatever headers the caller asked for, then add ours on top.
      ...(options.headers ?? {}),
      // "Bearer" is just the standard word for "the holder of this token" —
      // the server slices it off and checks what follows.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(locationId ? { "X-Location-Id": locationId } : {}),
      // Deliberately passed by hand rather than stashed somewhere global: a
      // single-use approval would otherwise be spent by whichever request
      // happened to fire next — a socket refresh, a background reload —
      // instead of the one it was granted for.
      ...(override ? { "X-Override": override } : {}),
    },
  });
  // 401 means "I don't know who you are" — either the 12-hour token ran out
  // or it was never valid. These four lines ARE the app's entire session
  // handling: forget everything and reload the page, which restarts Shell,
  // which finds no user, which shows the login screen.
  if (res.status === 401) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.reload();
  }
  return res;
}