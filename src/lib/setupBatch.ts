// ---------------------------------------------------------------------------
// Resuming a half-finished bulk setup.
//
// Creating mailboxes is a loop of one network call per address. Interrupt it —
// a refresh, a closed laptop, dropped wifi — and without a record of which
// addresses Instantly actually confirmed, the only options are re-attempting
// all of them or working out by hand where it stopped.
//
// So the batch stores the confirmed addresses, and this decides what is left.
// The rule that matters: an address is only "done" if Instantly confirmed it.
// A dry run proves nothing, and a failed create least of all — recording either
// would make the next run skip a mailbox that doesn't exist.
//
// Pure module — the page fetches and persists, this decides.
// ---------------------------------------------------------------------------
import { trackingDomainFor, type BatchConfig, type DomainSpec } from "./dnsPlan";
import type { MailProfile, SetupBatch } from "./types";
import type { NewAccount } from "./instantly";

/** Addresses compare case-insensitively; Instantly treats them that way. */
function key(email: string): string {
  return email.trim().toLowerCase();
}

export function mailboxAddresses(specs: DomainSpec[]): string[] {
  const out: string[] = [];
  for (const s of specs) {
    for (const p of s.prefixes) out.push(`${p}@${s.domain}`);
  }
  return out;
}

/**
 * Addresses still to create. Anything already confirmed is skipped, so a
 * resumed run costs only the work that genuinely remains.
 */
export function pendingMailboxes(specs: DomainSpec[], createdEmails: string[]): string[] {
  const done = new Set(createdEmails.map(key));
  return mailboxAddresses(specs).filter((e) => !done.has(key(e)));
}

export interface BatchProgress {
  total: number;
  created: number;
  pending: number;
  /** True once there's something to resume — drives the banner. */
  partiallyDone: boolean;
  complete: boolean;
}

export function batchProgress(specs: DomainSpec[], createdEmails: string[]): BatchProgress {
  const all = mailboxAddresses(specs);
  const done = new Set(createdEmails.map(key));
  // Count against THIS batch's addresses, so stale entries left over from a
  // domain you since removed can't report more created than exist.
  const created = all.filter((e) => done.has(key(e))).length;
  return {
    total: all.length,
    created,
    pending: all.length - created,
    partiallyDone: created > 0 && created < all.length,
    complete: all.length > 0 && created === all.length,
  };
}

/** The editable fields — what autosave compares and persists. */
export interface BatchDraft {
  name: string;
  config: Record<string, unknown>;
  domains_text: string;
  default_prefixes: string[];
  overrides: SetupBatch["overrides"];
  profile_id: string;
}

export function draftOf(batch: SetupBatch): BatchDraft {
  return {
    name: batch.name,
    config: batch.config,
    domains_text: batch.domains_text,
    default_prefixes: batch.default_prefixes,
    overrides: batch.overrides,
    profile_id: batch.profile_id,
  };
}

/**
 * Has anything actually changed since the last save?
 *
 * Structural rather than by reference: React hands back new objects for
 * untouched state constantly, and a dirty flag that trips on every render would
 * make the "unsaved changes" warning permanent and therefore ignored.
 */
export function isDirty(saved: BatchDraft | null, current: BatchDraft): boolean {
  if (!saved) return true;
  return stableJson(saved) !== stableJson(current);
}

/** JSON with object keys sorted, so key order can't fake a change. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = o[k];
          return acc;
        }, {});
    }
    return v;
  });
}

/** `{prefix}`/`{domain}` templating for SMTP/IMAP usernames. */
function expand(tpl: string, prefix: string, domain: string): string {
  return tpl.replace(/\{prefix\}/g, prefix).replace(/\{domain\}/g, domain);
}

/**
 * The Instantly create-account payload for one mailbox.
 *
 * Pure and separate from the page so the two things that cause a 400 are
 * testable: whether the tracking domain is attached, and which provider/host
 * values are sent. `tracking_domain_name` is included ONLY when the batch opts
 * in — a fresh domain's tracking CNAME isn't verified in Instantly yet, and
 * sending an unresolvable one is rejected at create time.
 */
export function createAccountArgs(
  profile: MailProfile,
  spec: DomainSpec,
  prefix: string,
  config: BatchConfig,
): NewAccount {
  const email = `${prefix}@${spec.domain}`;
  const args: NewAccount = {
    email,
    first_name: prefix.split(/[._-]/)[0] ?? prefix,
    last_name: "",
    provider_code: profile.provider_code,
    smtp_username: profile.smtp_username ? expand(profile.smtp_username, prefix, spec.domain) : email,
    smtp_password: profile.smtp_password,
    smtp_host: profile.smtp_host,
    smtp_port: profile.smtp_port,
    imap_username: profile.imap_username ? expand(profile.imap_username, prefix, spec.domain) : email,
    imap_password: profile.imap_password,
    imap_host: profile.imap_host,
    imap_port: profile.imap_port,
    daily_limit: profile.daily_limit,
    warmup_limit: profile.warmup_limit,
    warmup_increment: profile.warmup_increment,
    warmup_reply_rate: profile.warmup_reply_rate,
  };
  if (config.sendTrackingDomain) {
    args.tracking_domain_name = trackingDomainFor(spec, config);
  }
  return args;
}

/** A name that means something in a list six weeks from now. */
export function suggestBatchName(domainsText: string, now = new Date()): string {
  const first = domainsText
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  const stamp = now.toISOString().slice(0, 10);
  return first ? `${first} + others — ${stamp}` : `Batch ${stamp}`;
}
