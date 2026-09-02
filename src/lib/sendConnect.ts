// ---------------------------------------------------------------------------
// Connecting sending inboxes (the accounts under test) to real SMTP creds.
//
// The user has ~121 accounts in Instantly. Most were created from a shared
// credential profile (one SES SMTP key, a per-mailbox username template), so
// "connect them all" is really "point them at the right MailProfile and resolve
// each login". This module resolves one inbox's concrete SMTP login, works out
// which of the fetched addresses are already connectable, and plans a bulk
// connect. Pure: no sockets here, the worker does the sending.
// ---------------------------------------------------------------------------
import type { MailProfile, SendInbox, SetupBatch } from "./types";
import { usernameFor } from "./setupBatch";

function splitEmail(email: string): { prefix: string; domain: string } {
  const e = (email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return at >= 0 ? { prefix: e.slice(0, at), domain: e.slice(at + 1) } : { prefix: e, domain: "" };
}

export interface ResolvedSmtp {
  host: string;
  port: number;
  secure: boolean; // implicit TLS (465) vs STARTTLS (587)
  user: string;
  pass: string;
  from: string;
  fromName?: string;
}

export type ResolveResult = { ok: true; smtp: ResolvedSmtp } | { ok: false; reason: string };

/**
 * The concrete SMTP login for one sending inbox — from its linked MailProfile
 * (username template applied to the address), or from its own inline fields.
 * Returns a reason instead of guessing when something's missing, so the UI can
 * say exactly what to fix rather than failing at send time.
 */
export function resolveSmtp(inbox: SendInbox, profiles: MailProfile[]): ResolveResult {
  const { prefix, domain } = splitEmail(inbox.email);

  if (inbox.profile_id) {
    const p = profiles.find((pr) => pr.id === inbox.profile_id);
    if (!p) return { ok: false, reason: "linked mail profile not found" };
    if (!p.smtp_host) return { ok: false, reason: "profile has no SMTP host" };
    if (!p.smtp_password) return { ok: false, reason: "profile has no SMTP password" };
    // Resolve the login. usernameFor expands {prefix}/{domain}; a per-mailbox
    // login is written as {email} (what the Connect modal suggests), which we
    // substitute here, and a blank template falls back to the mailbox address —
    // the same default the inline path uses. So an SES access key (explicit
    // username), an {email} template, and a blank field all yield a real login
    // instead of failing SMTP auth on the literal "{email}" or an empty user.
    const user = usernameFor(p.smtp_username, prefix, domain).replace(/\{email\}/g, inbox.email).trim() || inbox.email.trim();
    if (!user) return { ok: false, reason: "profile has no SMTP username and no mailbox address to fall back to" };
    return {
      ok: true,
      smtp: {
        host: p.smtp_host,
        port: p.smtp_port || 587,
        secure: (p.smtp_port || 587) === 465,
        user,
        pass: p.smtp_password,
        from: inbox.email,
        fromName: inbox.from_name,
      },
    };
  }

  // Inline creds (manual single add).
  if (!inbox.smtp_host) return { ok: false, reason: "no SMTP host set" };
  if (!inbox.smtp_password) return { ok: false, reason: "no SMTP password set" };
  const port = inbox.smtp_port || 587;
  return {
    ok: true,
    smtp: {
      host: inbox.smtp_host,
      port,
      secure: inbox.smtp_secure ?? port === 465,
      user: (inbox.smtp_user ?? "").trim() || inbox.email,
      pass: inbox.smtp_password,
      from: inbox.email,
      fromName: inbox.from_name,
    },
  };
}

export type ConnStatus = "connected" | "available" | "failed" | "none";

export interface IdentifiedInbox {
  email: string;
  status: ConnStatus;
  /** Where its creds come from, when it has any. */
  via: "send_inbox" | "profile" | null;
  /** Present for `failed`, or when creds exist but can't be resolved. */
  error?: string;
}

/** email (lowercased) -> the profile_id that a setup batch used to create it. */
export function batchCoverage(batches: SetupBatch[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of batches) {
    if (!b.profile_id) continue;
    for (const e of b.created_emails ?? []) {
      const k = (e ?? "").trim().toLowerCase();
      if (k && !m.has(k)) m.set(k, b.profile_id);
    }
  }
  return m;
}

/**
 * For a list of addresses (e.g. every account fetched from Instantly), work out
 * which are already connectable to SMTP: `connected` (a send-inbox row verified
 * ok), `available` (creds resolvable but not yet verified — via an existing
 * send-inbox row or a setup batch's profile), `failed` (verify failed), or
 * `none` (nothing on file → needs the bulk-connect flow).
 */
export function identifyConnected(
  emails: string[],
  sendInboxes: SendInbox[],
  profiles: MailProfile[],
  batches: SetupBatch[] = [],
): IdentifiedInbox[] {
  const byEmail = new Map<string, SendInbox>();
  for (const s of sendInboxes) byEmail.set((s.email ?? "").trim().toLowerCase(), s);
  const coverage = batchCoverage(batches);

  return emails.map((raw) => {
    const email = (raw ?? "").trim().toLowerCase();
    const row = byEmail.get(email);
    if (row) {
      if (row.connected === "ok") return { email, status: "connected", via: "send_inbox" };
      if (row.connected === "failed") return { email, status: "failed", via: "send_inbox", error: row.last_error };
      const r = resolveSmtp(row, profiles);
      return r.ok
        ? { email, status: "available", via: "send_inbox" }
        : { email, status: "none", via: null, error: r.reason };
    }
    // No explicit send-inbox row — is it covered by a setup batch's profile?
    const profileId = coverage.get(email);
    if (profileId) {
      const probe: SendInbox = {
        id: "", email, source: "instantly", profile_id: profileId, connected: "unknown",
      };
      const r = resolveSmtp(probe, profiles);
      if (r.ok) return { email, status: "available", via: "profile" };
    }
    return { email, status: "none", via: null };
  });
}

/**
 * Plan a bulk connect: for the selected addresses, the send-inbox rows to write
 * so each points at `profileId`. Rows that already exist for a selected email
 * are relinked (kept as updates); the rest are creates. The caller upserts.
 */
export function planBulkConnect(
  selectedEmails: string[],
  profileId: string,
  existing: SendInbox[],
): { creates: Partial<SendInbox>[]; updates: { id: string; patch: Partial<SendInbox> }[] } {
  const byEmail = new Map<string, SendInbox>();
  for (const s of existing) byEmail.set((s.email ?? "").trim().toLowerCase(), s);

  const creates: Partial<SendInbox>[] = [];
  const updates: { id: string; patch: Partial<SendInbox> }[] = [];
  const seen = new Set<string>();

  for (const raw of selectedEmails) {
    const email = (raw ?? "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const row = byEmail.get(email);
    if (row) {
      updates.push({ id: row.id, patch: { profile_id: profileId, connected: "unknown", last_error: undefined } });
    } else {
      creates.push({ email, source: "instantly", profile_id: profileId, connected: "unknown" });
    }
  }
  return { creates, updates };
}
