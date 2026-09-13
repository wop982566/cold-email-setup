// ---------------------------------------------------------------------------
// Keeping the Domains table a live mirror of Instantly, without clobbering it.
//
// A Domain row carries things Instantly never sees — registrar, expiry, DNS
// status, renewal cost, notes. Instantly owns the opposite half: which
// mailboxes exist, whether they're connected, whether warmup is on. So this
// reconciles the two rather than replacing one with the other:
//
//   • a domain Instantly has but the table doesn't  → a new row to ADD
//   • an existing row whose Instantly-owned fields drifted → a minimal patch
//   • everything the operator typed → left exactly as-is
//
// The rules that keep it safe to run on every load:
//   – additive only: fill a BLANK mailbox slot, never overwrite a filled one;
//   – status fields (connected / warmup) reflect Instantly, because those are
//     facts, not opinions — but only patched when they actually changed;
//   – never delete, and an empty Instantly read (a transient failure) yields
//     nothing to do, so it can't wipe the table;
//   – idempotent: after applying, a second pass finds no diff, so there's no
//     write loop when the domains query refetches.
//
// Pure module — the page fetches accounts and persists; this only decides.
// ---------------------------------------------------------------------------
import type { Domain, TriState } from "./types";

export type LiveAccount = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

/** Same active test the planner uses, so "connected" agrees across the app. */
function isActive(a: LiveAccount): boolean {
  return (Number(a.status) === 1 || a.status === "active") && a.setup_pending !== true;
}

/** Best-effort: warmup on if a warmup object/flag or a score is present. */
function warmupOn(a: LiveAccount): boolean {
  const w = a.warmup as Record<string, unknown> | undefined;
  if (w && (w.limit != null || w.status != null || w.increment != null)) return true;
  const score = a.stat_warmup_score ?? a.warmup_score;
  return typeof score === "number" && score > 0;
}

/** Live accounts grouped by their email's domain (lowercased). */
export function accountsByDomain(accounts: LiveAccount[]): Map<string, LiveAccount[]> {
  const map = new Map<string, LiveAccount[]>();
  for (const a of accounts) {
    const d = domainOf(str(a.email));
    if (!d) continue;
    (map.get(d) ?? map.set(d, []).get(d)!).push(a);
  }
  return map;
}

export interface DomainStatus {
  connected: TriState; // Yes / Partially / No
  warmup: TriState;
  /** Mailbox addresses on this domain, as Instantly reports them. */
  emails: string[];
  /** Per-mailbox daily limit, when consistent across the domain's inboxes. */
  dailyLimit: number | null;
}

/** The Instantly-owned facts for one domain's set of accounts. */
export function deriveDomainStatus(accts: LiveAccount[]): DomainStatus {
  const emails = accts.map((a) => str(a.email)).filter(Boolean);
  const activeCount = accts.filter(isActive).length;
  const connected: TriState =
    accts.length === 0 ? "" : activeCount === 0 ? "No" : activeCount === accts.length ? "Yes" : "Partially";
  const warmup: TriState = accts.length === 0 ? "" : accts.some(warmupOn) ? "Yes" : "No";

  const limits = accts.map((a) => Number((a as Record<string, unknown>).daily_limit)).filter((n) => Number.isFinite(n));
  const dailyLimit = limits.length && limits.every((l) => l === limits[0]) ? limits[0] : null;

  return { connected, warmup, emails, dailyLimit };
}

export interface Reconciliation {
  /** New Domain rows to insert for Instantly domains not in the table. */
  toAdd: Partial<Domain>[];
  /** Minimal patches for existing rows whose Instantly-owned fields drifted. */
  toUpdate: { id: string; patch: Partial<Domain> }[];
  /** Domains that have more live inboxes than a Domain row can hold (2). */
  overflow: { domain: string; count: number }[];
}

/**
 * Reconcile the stored domains against live Instantly accounts.
 *
 * `basePosition` is where new rows are ordered from (usually the current row
 * count), matching how createDomainRows numbers them.
 */
export function reconcileDomains(
  stored: Domain[],
  accounts: LiveAccount[],
  make: () => string, // id generator, injected so the module stays pure
  basePosition = stored.length,
): Reconciliation {
  const byDomain = accountsByDomain(accounts);
  const known = new Map(stored.map((d) => [str(d.domain_name).toLowerCase().replace(/^www\./, ""), d]));

  const toAdd: Partial<Domain>[] = [];
  const toUpdate: { id: string; patch: Partial<Domain> }[] = [];
  const overflow: { domain: string; count: number }[] = [];
  let pos = basePosition;

  for (const [domain, accts] of byDomain) {
    const st = deriveDomainStatus(accts);
    if (st.emails.length > 2) overflow.push({ domain, count: st.emails.length });

    const existing = known.get(domain);
    if (!existing) {
      // A domain Instantly has that we don't — add it, pre-filled with what
      // Instantly knows and sensible defaults; registrar/expiry/DNS left blank.
      toAdd.push({
        id: make(),
        position: pos++,
        domain_name: domain,
        email_1: st.emails[0] ?? "",
        email_2: st.emails[1] ?? "",
        expiry_date: null,
        expiry_source: "manual",
        expiry_checked_at: null,
        domain_provider: "",
        mailing_server: "Amazon SES",
        mailing_status: "",
        dns_provider: "Cloudflare",
        dns_status: "",
        email_forward: "",
        hosting_provider: "",
        hosting_account: "",
        website_note: "",
        emails_forwarded_to: "",
        campaign_id: null,
        campaign_label: "",
        gravatar: "",
        gmail_send_configured: "",
        connected_to_instantly: st.connected,
        warmup_started: st.warmup,
        mailbox_daily_limit: st.dailyLimit,
        renewal_cost: 0,
        notes: "Added automatically from Instantly.",
        custom: {},
      });
      continue;
    }

    // Existing row: build a patch of ONLY the Instantly-owned fields that
    // actually differ. Blank mailbox slots get filled; a filled slot is left
    // alone even if Instantly disagrees (the operator's value wins for identity).
    const patch: Partial<Domain> = {};
    if (!str(existing.email_1) && st.emails[0]) patch.email_1 = st.emails[0];
    if (!str(existing.email_2) && st.emails[1]) patch.email_2 = st.emails[1];
    if (st.connected && existing.connected_to_instantly !== st.connected) {
      patch.connected_to_instantly = st.connected;
    }
    if (st.warmup && existing.warmup_started !== st.warmup) {
      patch.warmup_started = st.warmup;
    }
    if (Object.keys(patch).length > 0) toUpdate.push({ id: existing.id, patch });
  }

  return { toAdd, toUpdate, overflow };
}
