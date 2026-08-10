// ---------------------------------------------------------------------------
// Inbox-vs-spam placement, from Instantly's warmup-analytics endpoint.
//
// The endpoint's payload shape has moved around across API revisions, and the
// per-mailbox numbers are the whole point of the feature, so this parser is
// deliberately tolerant: it accepts a bare array, {items:[…]}, or the keyed
// {aggregate_data:{email:{…}}} / {email_date_data:{email:{date:{…}}}} objects,
// and reads counts through a list of candidate field names.
//
// The one rule that matters: a mailbox we couldn't measure returns null, never
// zero. mailboxHealth treats null as "unknown" and 0 as "everything is going to
// spam" — conflating them would flag every unmeasured inbox as burned.
//
// Pure module — the page fetches, this parses.
// ---------------------------------------------------------------------------
import { pick } from "./instantly";

export interface Placement {
  /** 0-100, or null when nothing was measured. */
  inboxRate: number | null;
  /** Warmup score reported alongside the counts, when present. */
  score: number | null;
  inbox: number;
  spam: number;
  /** Messages the rate was computed from — 0 means "no evidence". */
  sampled: number;
}

export type PlacementMap = Map<string, Placement>;

const F = {
  inbox: ["landed_inbox", "inbox_count", "inbox", "landed", "in_inbox"],
  spam: ["landed_spam", "spam_count", "spam", "in_spam"],
  score: ["warmup_score", "score", "health_score"],
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function norm(email: string): string {
  return email.trim().toLowerCase();
}

/** Sum inbox/spam/score out of one record, or out of a {date: record} bag. */
function readCounts(node: unknown): { inbox: number; spam: number; score: number | null } {
  if (!isObj(node)) return { inbox: 0, spam: 0, score: null };

  const direct = {
    inbox: pick(node, F.inbox, 0),
    spam: pick(node, F.spam, 0),
  };
  // A record carrying counts directly wins; only recurse when it has none, so a
  // daily bag ({"2026-08-01": {...}, ...}) still resolves.
  if (direct.inbox > 0 || direct.spam > 0) {
    const s = pick(node, F.score, -1);
    return { ...direct, score: s >= 0 ? s : null };
  }

  let inbox = 0;
  let spam = 0;
  let score: number | null = null;
  for (const v of Object.values(node)) {
    if (!isObj(v)) continue;
    inbox += pick(v, F.inbox, 0);
    spam += pick(v, F.spam, 0);
    const s = pick(v, F.score, -1);
    if (s >= 0) score = s; // last day wins — the score is a running figure
  }
  if (score === null) {
    const s = pick(node, F.score, -1);
    if (s >= 0) score = s;
  }
  return { inbox, spam, score };
}

function toPlacement(inbox: number, spam: number, score: number | null): Placement {
  const sampled = inbox + spam;
  return {
    inbox,
    spam,
    sampled,
    // No measured sends => unknown, NOT 0%.
    inboxRate: sampled > 0 ? (inbox / sampled) * 100 : null,
    score,
  };
}

/**
 * Parse one warmup-analytics response into per-mailbox placement.
 * Unrecognised payloads yield an empty map rather than throwing — the caller
 * shows "not checked" and every downstream check stays null-safe.
 */
export function parseWarmupAnalytics(data: unknown): PlacementMap {
  const out: PlacementMap = new Map();
  if (data == null) return out;

  const add = (email: string, node: unknown) => {
    const key = norm(email);
    if (!key) return;
    const { inbox, spam, score } = readCounts(node);
    const prev = out.get(key);
    out.set(
      key,
      prev
        ? toPlacement(prev.inbox + inbox, prev.spam + spam, score ?? prev.score)
        : toPlacement(inbox, spam, score),
    );
  };

  // Shape 1 — array of rows, or {items:[…]}.
  const rows: unknown[] = Array.isArray(data)
    ? data
    : isObj(data) && Array.isArray(data.items)
      ? (data.items as unknown[])
      : [];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const email = row.email ?? row.account ?? row.address;
    if (typeof email === "string") add(email, row);
  }

  // Shape 2 — email-keyed objects. Both keys can appear together; aggregate_data
  // is authoritative, so it's read second and overwrites.
  if (isObj(data)) {
    for (const key of ["email_date_data", "aggregate_data", "data", "emails"]) {
      const bag = data[key];
      if (!isObj(bag)) continue;
      for (const [email, node] of Object.entries(bag)) {
        if (email.includes("@")) add(email, node);
      }
    }
  }

  return out;
}

/** Fold several batch responses into one map. */
export function mergePlacement(maps: PlacementMap[]): PlacementMap {
  const out: PlacementMap = new Map();
  for (const m of maps) {
    for (const [email, p] of m) {
      const prev = out.get(email);
      out.set(
        email,
        prev ? toPlacement(prev.inbox + p.inbox, prev.spam + p.spam, p.score ?? prev.score) : p,
      );
    }
  }
  return out;
}

/** Split into fixed-size batches — the endpoint accepts at most 100 emails. */
export function batchEmails(emails: string[], size = 100): string[][] {
  const uniq = [...new Set(emails.map(norm).filter(Boolean))];
  const out: string[][] = [];
  for (let i = 0; i < uniq.length; i += size) out.push(uniq.slice(i, i + size));
  return out;
}

/** The shape mailboxHealth's `placement` input expects. */
export function toHealthInput(m: PlacementMap): Map<string, { inboxRate: number | null; score: number | null }> {
  const out = new Map<string, { inboxRate: number | null; score: number | null }>();
  for (const [email, p] of m) out.set(email, { inboxRate: p.inboxRate, score: p.score });
  return out;
}
