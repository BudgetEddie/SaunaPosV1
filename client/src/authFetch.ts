export const API = "http://localhost:4000";

export type LoggedInUser = { username: string; displayName: string; role: string };

// fetch, but with the sign-in token attached. If the server says the token
// is missing or expired (401), wipe it and reload — which lands on the login page.
export async function authFetch(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem("token");
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.reload();
  }
  return res;
}