// ---------------------------------------------------------------------------
// Lightweight login gate. Credentials come from build-time env vars:
//   VITE_APP_USERNAME (optional) and VITE_APP_PASSWORD.
// If VITE_APP_PASSWORD is unset, the app is open (no gate) — keeps local mode
// frictionless. When set, a username/password screen guards the app.
//
// NOTE: this is a client-side gate. Because Vite inlines VITE_* vars into the
// bundle, the password is technically discoverable by someone who inspects the
// JS. It stops casual access; for hard protection use Netlify's built-in
// site-wide password (server-side) or Supabase Auth.
// ---------------------------------------------------------------------------
const U = (import.meta.env.VITE_APP_USERNAME ?? "").trim();
const P = import.meta.env.VITE_APP_PASSWORD ?? "";

export const authEnabled = P !== "";

const KEY = "cec:auth:v1";

export function isAuthed(): boolean {
  if (!authEnabled) return true;
  try {
    return localStorage.getItem(KEY) === "ok";
  } catch {
    return false;
  }
}

export function signIn(username: string, password: string): boolean {
  const userOk = U === "" || username.trim() === U;
  if (userOk && password === P) {
    try {
      localStorage.setItem(KEY, "ok");
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

export function signOut(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
