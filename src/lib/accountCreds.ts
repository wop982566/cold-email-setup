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

import type { MailProfile, SetupBatch } from "./types";
import { usernameFor } from "./setupBatch";

export type LiveAccount = Record<string, unknown>;

export interface AccountCreds {
  imapHost?: string;
  imapUsername?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpUsername?: string;
  smtpPort?: number;
}

/** Where an account's creds were read from — live Instantly, or the setup log. */
export type CredsSource = "live" | "log";

export interface CredsWithSource {
  creds: AccountCreds;
  source: CredsSource;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * First present value across candidate keys, looked for both flat on the
 * account and inside any of several nested containers Instantly might use.
 *
 * The account payload's exact shape is unverified from the build environment,
 * so this casts a wide net: `imap`, `imap_settings`, `imap_config`, and a
 * `connection.imap` sub-object, plus the flat keys. A miss just yields
 * undefined; the raw-JSON expander in the UI is there to reveal any key this
 * still doesn't catch.
 */
function pick(a: LiveAccount, group: "imap" | "smtp", keys: string[]): unknown {
  // Nested containers where a bare `host`/`username` unambiguously belongs to
  // this group.
  const nested: (Record<string, unknown> | undefined)[] = [
    a[group] as Record<string, unknown> | undefined,
    a[`${group}_settings`] as Record<string, unknown> | undefined,
    a[`${group}_config`] as Record<string, unknown> | undefined,
    (a.connection as Record<string, unknown> | undefined)?.[group] as
      | Record<string, unknown>
      | undefined,
  ];
  for (const k of keys) {
    // Flat on the account only for keys that name the group themselves
    // (imap_host, imapHost, imap_server…) — a bare `host` flat on the account
    // would bleed between IMAP and SMTP, so it's read from nested only.
    if (k.toLowerCase().startsWith(group) && a[k] != null) return a[k];
    for (const c of nested) {
      if (c && c[k] != null) return c[k];
    }
  }
  return undefined;
}

/**
 * Read the (non-secret) connection identity from one account, tolerant of the
 * shape Instantly returns — flat `imap_host`, camelCase `imapHost`, or nested
 * `imap: { host }` / `imap_settings: { server }`. Host/username/port only;
 * never a password (which the proxy scrubs anyway).
 */
export function credsOf(a: LiveAccount): AccountCreds {
  return {
    imapHost: str(pick(a, "imap", ["imap_host", "imapHost", "host", "imap_server", "imapServer", "server"])),
    imapUsername: str(pick(a, "imap", ["imap_username", "imapUsername", "imap_login", "imapLogin", "username", "user", "login"])),
    imapPort: num(pick(a, "imap", ["imap_port", "imapPort", "port"])),
    smtpHost: str(pick(a, "smtp", ["smtp_host", "smtpHost", "host", "smtp_server", "smtpServer", "server"])),
    smtpUsername: str(pick(a, "smtp", ["smtp_username", "smtpUsername", "smtp_login", "smtpLogin", "username", "user", "login"])),
    smtpPort: num(pick(a, "smtp", ["smtp_port", "smtpPort", "port"])),
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

// ---------------------------------------------------------------------------
// The setup-log source. The live accounts list omits IMAP, and even the detail
// read may hide it under an unknown key — but the app knows which credential
// profile created each mailbox, so it can reconstruct the connection identity
// it was born with. This is creation-time truth: right for app-made accounts,
// but stale if the IMAP was later changed in Instantly — hence live wins.
//
// Passwords are never read here, only host/username/port.
// ---------------------------------------------------------------------------

/** local-part before the @, used as the `{prefix}` in a profile's templates. */
function prefixOf(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
function domainOf(email: string): string {
  const at = email.indexOf("@");
  return at >= 0 ? email.slice(at + 1) : "";
}

/**
 * Reconstruct one mailbox's creds from the profile that created it. Usernames
 * are the profile's `{prefix}`/`{domain}` templates expanded with this email's
 * own local-part and domain (via `usernameFor`, so a blank template stays blank
 * rather than becoming the address). Host/port come straight off the profile.
 */
export function credsFromProfile(profile: MailProfile, email: string): AccountCreds {
  const prefix = prefixOf(email);
  const domain = domainOf(email);
  return {
    imapHost: str(profile.imap_host),
    imapUsername: str(usernameFor(profile.imap_username ?? "", prefix, domain)),
    imapPort: num(profile.imap_port),
    smtpHost: str(profile.smtp_host),
    smtpUsername: str(usernameFor(profile.smtp_username ?? "", prefix, domain)),
    smtpPort: num(profile.smtp_port),
  };
}

/**
 * Every created mailbox mapped to the creds of the profile that made it. A
 * batch stores `profile_id` and the confirmed `created_emails`; join them
 * through `profilesById`. Emails whose batch profile isn't available (e.g.
 * mail_profiles gated behind APP_FUNCTION_TOKEN) are simply omitted.
 */
export function credsFromBatches(
  batches: readonly SetupBatch[],
  profilesById: Map<string, MailProfile>,
): Map<string, AccountCreds> {
  const map = new Map<string, AccountCreds>();
  for (const b of batches) {
    const profile = profilesById.get(b.profile_id);
    if (!profile) continue;
    for (const raw of b.created_emails ?? []) {
      const email = str(raw)?.toLowerCase();
      if (!email) continue;
      // Earlier batches lose to later ones — the most recent creation wins.
      map.set(email, credsFromProfile(profile, email));
    }
  }
  return map;
}

/**
 * Merge the two sources: live Instantly wins per field, the setup log fills the
 * gaps. An account is labelled `live` when the live payload contributed any
 * identity field, else `log` — so a mailbox whose IMAP was changed in Instantly
 * reads as live (the truth) rather than the stale creation-time value.
 */
export function mergeCredsPreferLive(
  live: Map<string, AccountCreds>,
  logs: Map<string, AccountCreds>,
): Map<string, CredsWithSource> {
  const out = new Map<string, CredsWithSource>();
  const emails = new Set<string>([...live.keys(), ...logs.keys()]);
  for (const email of emails) {
    const l = live.get(email) ?? {};
    const g = logs.get(email) ?? {};
    const liveHasAny = Boolean(
      l.imapHost || l.imapUsername || l.imapPort || l.smtpHost || l.smtpUsername || l.smtpPort,
    );
    out.set(email, {
      source: liveHasAny ? "live" : "log",
      creds: {
        imapHost: l.imapHost ?? g.imapHost,
        imapUsername: l.imapUsername ?? g.imapUsername,
        imapPort: l.imapPort ?? g.imapPort,
        smtpHost: l.smtpHost ?? g.smtpHost,
        smtpUsername: l.smtpUsername ?? g.smtpUsername,
        smtpPort: l.smtpPort ?? g.smtpPort,
      },
    });
  }
  return out;
}
