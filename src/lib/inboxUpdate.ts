// ---------------------------------------------------------------------------
// Bulk-updating settings on inboxes that ALREADY exist in Instantly.
//
// Distinct from creating an account: this only PATCHes an existing one, and
// only the fields the operator explicitly enabled. Nothing here can touch SMTP/
// IMAP credentials.
//
// Two of the fields — tags and the warmup filter tag — have JSON keys I could
// not verify against Instantly's API (the endpoint is unreachable from the
// build environment). Rather than hardcode a guess that would 400 the whole
// patch, the updater writes those back under the SAME key the LIVE account
// exposes them under: the preview reads the account, we find where Instantly
// keeps the value, and we write to that exact path. If the live account has no
// such key, the field is omitted and the reason recorded — never a blind guess.
//
// Pure module — the page fetches live accounts and sends the patch; this builds
// the patch and maps the preview.
// ---------------------------------------------------------------------------

/** A live Instantly account object, shape unknown, read defensively. */
export type LiveAccount = Record<string, unknown>;

/** Which fields the operator turned on, and the value to set. */
export interface UpdateFields {
  trackingDomain?: { enabled: boolean; prefix: string };
  firstName?: string;
  lastName?: string;
  dailyLimit?: number;
  warmup?: { limit?: number; increment?: number; replyRate?: number };
  tags?: string[];
  warmupFilterTag?: string;
}

export interface BuiltPatch {
  /** The PATCH body — only enabled fields. Empty means nothing to do. */
  patch: Record<string, unknown>;
  /** Fields we wanted to set but couldn't (e.g. no discoverable key). */
  skipped: { field: string; reason: string }[];
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : "";
}

/** First existing key on `obj` from a list of candidates, else null. */
function findKey(obj: LiveAccount, candidates: string[]): string | null {
  for (const k of candidates) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) return k;
  }
  return null;
}

// Best-known candidate keys, tried in order. The live account decides which is
// real; these are only the search space, never assumed correct.
const FILTER_TAG_KEYS = [
  "warmup_custom_ftag", "warmup_filter_tag", "filter_tag", "warmup_ftag", "custom_ftag",
];
const TAGS_KEYS = ["tags", "tag_ids", "labels"];

/**
 * Build the PATCH body for one inbox from the enabled fields.
 *
 * `live` is that inbox's current Instantly object — used to derive the tracking
 * domain's host domain and to discover where tags / the filter tag live.
 */
export function accountUpdatePayload(
  email: string,
  fields: UpdateFields,
  live: LiveAccount,
): BuiltPatch {
  const patch: Record<string, unknown> = {};
  const skipped: { field: string; reason: string }[] = [];

  if (fields.trackingDomain?.enabled) {
    const domain = domainOf(email);
    const prefix = (fields.trackingDomain.prefix || "inst").trim().replace(/\.$/, "");
    // Each inbox points at ITS OWN domain, not one shared value.
    patch.tracking_domain_name = prefix ? `${prefix}.${domain}` : domain;
  }

  if (typeof fields.firstName === "string" && fields.firstName.trim() !== "") {
    patch.first_name = fields.firstName.trim();
  }
  if (typeof fields.lastName === "string") {
    // Last name may legitimately be cleared, so an empty string is a real value
    // here — only `undefined` means "leave alone".
    patch.last_name = fields.lastName.trim();
  }

  if (typeof fields.dailyLimit === "number" && Number.isFinite(fields.dailyLimit)) {
    patch.daily_limit = Math.trunc(fields.dailyLimit);
  }

  if (fields.warmup) {
    const w: Record<string, number> = {};
    if (typeof fields.warmup.limit === "number") w.limit = Math.trunc(fields.warmup.limit);
    if (typeof fields.warmup.increment === "number") w.increment = Math.trunc(fields.warmup.increment);
    if (typeof fields.warmup.replyRate === "number") w.reply_rate = Math.trunc(fields.warmup.replyRate);
    if (Object.keys(w).length > 0) patch.warmup = w;
  }

  // --- discovered-key fields ------------------------------------------------
  if (fields.warmupFilterTag !== undefined) {
    const key = findKey(live, FILTER_TAG_KEYS);
    if (key) patch[key] = fields.warmupFilterTag;
    else
      skipped.push({
        field: "warmupFilterTag",
        reason: `no warmup-filter-tag key on the live account (looked for ${FILTER_TAG_KEYS.join(", ")}) — open a row's raw JSON to find the real name`,
      });
  }

  if (fields.tags !== undefined) {
    const key = findKey(live, TAGS_KEYS);
    if (key) patch[key] = fields.tags;
    else
      skipped.push({
        field: "tags",
        reason: `no tags key on the live account (looked for ${TAGS_KEYS.join(", ")}) — tags may need a separate endpoint`,
      });
  }

  return { patch, skipped };
}

// --- Preview mapping -------------------------------------------------------
// The live settings shown per inbox. Every field is best-effort: a sparse or
// unexpected account must map to "unknown", never throw.

export interface LiveInboxRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
  dailyLimit: number | null;
  warmupLimit: number | null;
  warmupIncrement: number | null;
  warmupReplyRate: number | null;
  trackingDomain: string | null;
  warmupFilterTag: string | null;
  tags: string[];
  status: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function n(v: unknown): number | null {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

/** Pull the first present value across candidate keys (nested warmup too). */
function pickField(a: LiveAccount, keys: string[]): unknown {
  for (const k of keys) {
    if (a[k] != null) return a[k];
    const w = a.warmup as Record<string, unknown> | undefined;
    if (w && w[k] != null) return w[k];
  }
  return undefined;
}

export function liveInboxRow(account: LiveAccount): LiveInboxRow {
  const warmup = (account.warmup ?? {}) as Record<string, unknown>;
  const rawTags = pickField(account, TAGS_KEYS);
  const tags = Array.isArray(rawTags)
    ? rawTags
        .map((t) => (typeof t === "string" ? t : str((t as Record<string, unknown>)?.name ?? (t as Record<string, unknown>)?.label)))
        .filter((t): t is string => Boolean(t))
    : [];
  return {
    email: str(account.email) ?? "",
    firstName: str(account.first_name),
    lastName: str(account.last_name),
    dailyLimit: n(account.daily_limit),
    warmupLimit: n(warmup.limit ?? account.warmup_limit),
    warmupIncrement: n(warmup.increment ?? account.warmup_increment),
    warmupReplyRate: n(warmup.reply_rate ?? account.warmup_reply_rate),
    trackingDomain: str(account.tracking_domain_name),
    warmupFilterTag: str(pickField(account, FILTER_TAG_KEYS)),
    tags,
    status: str(account.status) ?? (account.status != null ? String(account.status) : null),
  };
}

/** Inboxes whose domain is in the given set (lowercased). */
export function inboxesForDomains(accounts: LiveAccount[], domains: Set<string>): LiveAccount[] {
  return accounts.filter((a) => {
    const email = typeof a.email === "string" ? a.email : "";
    return domains.has(domainOf(email).toLowerCase());
  });
}

/** True when at least one field is enabled — gates the Apply button. */
export function hasAnyField(f: UpdateFields): boolean {
  return Boolean(
    f.trackingDomain?.enabled ||
      (typeof f.firstName === "string" && f.firstName.trim() !== "") ||
      typeof f.lastName === "string" ||
      typeof f.dailyLimit === "number" ||
      (f.warmup && Object.values(f.warmup).some((v) => typeof v === "number")) ||
      f.tags !== undefined ||
      f.warmupFilterTag !== undefined,
  );
}
