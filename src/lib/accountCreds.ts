// ---------------------------------------------------------------------------
// Which IMAP/SMTP each Instantly account is actually on.
//
// So you can see, per inbox, the login it uses — and which inboxes share one —
// which matters after changing an IMAP: the account's OWN live value is the
// truth, not whatever a saved credential profile still says.
//
// Passwords are never read here. They're write-only in Instantly and gated in
// the app, and the account-detail proxy scrubs them anyway. Only host, username
// and port — the identifying, non-secret part — is surfaced.
//
// Pure module — callers fetch accounts; this maps and groups.
// ---------------------------------------------------------------------------

export type LiveAccount = Record<string, unknown>;

export interface AccountCreds {
  imapHost?: string;
  imapUsername?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpUsername?: string;
  smtpPort?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** First present value across candidate keys, incl. a nested `imap`/`smtp`. */
function pick(a: LiveAccount, group: "imap" | "smtp", keys: string[]): unknown {
  const nested = a[group] as Record<string, unknown> | undefined;
  for (const k of keys) {
    if (a[k] != null) return a[k];
    if (nested && nested[k] != null) return nested[k];
  }
  return undefined;
}

/**
 * Read the (non-secret) connection identity from one account, tolerant of the
 * shape Instantly returns — flat `imap_host` or nested `imap: { host }`.
 */
export function credsOf(a: LiveAccount): AccountCreds {
  return {
    imapHost: str(pick(a, "imap", ["imap_host", "host"])),
    imapUsername: str(pick(a, "imap", ["imap_username", "username", "user"])),
    imapPort: num(pick(a, "imap", ["imap_port", "port"])),
    smtpHost: str(pick(a, "smtp", ["smtp_host", "host"])),
    smtpUsername: str(pick(a, "smtp", ["smtp_username", "username", "user"])),
    smtpPort: num(pick(a, "smtp", ["smtp_port", "port"])),
  };
}

/** email (lowercased) -> creds, for every account that has an email. */
export function accountCredentials(accounts: LiveAccount[]): Map<string, AccountCreds> {
  const map = new Map<string, AccountCreds>();
  for (const a of accounts) {
    const email = str(a.email);
    if (email) map.set(email.toLowerCase(), credsOf(a));
  }
  return map;
}

export interface ImapGroup {
  /** "username @ host", or a marker when the IMAP isn't known. */
  identity: string;
  imapHost?: string;
  imapUsername?: string;
  emails: string[];
}

const UNKNOWN = "IMAP not reported";

/** Emails grouped by the IMAP login they share. Unknown-IMAP accounts bucket together. */
export function groupByImap(creds: Map<string, AccountCreds>): ImapGroup[] {
  const groups = new Map<string, ImapGroup>();
  for (const [email, c] of creds) {
    const host = c.imapHost;
    const user = c.imapUsername;
    const key = host || user ? `${(user ?? "").toLowerCase()}@${(host ?? "").toLowerCase()}` : UNKNOWN;
    const identity = host || user ? `${user ?? "?"} @ ${host ?? "?"}` : UNKNOWN;
    const g = groups.get(key) ?? { identity, imapHost: host, imapUsername: user, emails: [] };
    g.emails.push(email);
    groups.set(key, g);
  }
  // Biggest groups first; unknown bucket last.
  return [...groups.values()]
    .map((g) => ({ ...g, emails: g.emails.sort() }))
    .sort((a, b) => {
      if (a.identity === UNKNOWN) return 1;
      if (b.identity === UNKNOWN) return -1;
      return b.emails.length - a.emails.length || a.identity.localeCompare(b.identity);
    });
}

/**
 * Fold an on-demand account-detail result into the map, for the fill-the-gaps
 * button when the accounts list didn't carry IMAP fields. Returns a new map;
 * only the named account changes.
 */
export function mergeCredsFromDetail(
  base: Map<string, AccountCreds>,
  email: string,
  detail: LiveAccount | null | undefined,
): Map<string, AccountCreds> {
  if (!detail) return base;
  const next = new Map(base);
  const existing = next.get(email.toLowerCase()) ?? {};
  next.set(email.toLowerCase(), { ...existing, ...credsOf(detail) });
  return next;
}

/** True when the account list already carries usable IMAP identity. */
export function hasImapDetail(creds: Map<string, AccountCreds>): boolean {
  for (const c of creds.values()) {
    if (c.imapHost || c.imapUsername) return true;
  }
  return false;
}

/** Emails whose IMAP identity is still unknown — what "Load details" fetches. */
export function emailsMissingImap(creds: Map<string, AccountCreds>): string[] {
  const out: string[] = [];
  for (const [email, c] of creds) {
    if (!c.imapHost && !c.imapUsername) out.push(email);
  }
  return out;
}
