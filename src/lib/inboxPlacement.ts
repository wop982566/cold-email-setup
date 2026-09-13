// ---------------------------------------------------------------------------
// Turning seed-panel reads into a real "does it land in the Primary inbox" score.
//
// One test across ~15 seeds is noisy (±13%), and deliverability drifts, so the
// true health of a sending inbox is a time-decayed average of several tests —
// never a single snapshot. This module scores one test, rolls many into a
// decayed figure with a confidence flag, and classifies where a message landed
// from what IMAP tells us. Pure: the worker fetches, this decides.
// ---------------------------------------------------------------------------
import type { InboxTest, InboxTestResult, InboxTestSummary, SeedFolder } from "./types";

// Re-exported so callers don't need a second import for the band type.
export type PlacementBand = "good" | "watch" | "warn" | "critical" | "unknown";

// Primary is the goal; a tab is delivered-but-buried; spam and missing are zero.
const WEIGHT: Record<SeedFolder, number> = { primary: 1, tab: 0.5, spam: 0, missing: 0 };

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

export function scoreTest(results: InboxTestResult[]): InboxTestSummary {
  const total = results.length;
  const perProvider: InboxTestSummary["perProvider"] = {};
  let primary = 0;
  let tab = 0;
  let spam = 0;
  let missing = 0;
  let weight = 0;

  for (const r of results) {
    if (r.folder === "primary") primary++;
    else if (r.folder === "tab") tab++;
    else if (r.folder === "spam") spam++;
    else missing++;
    weight += WEIGHT[r.folder] ?? 0;

    const p = (perProvider[r.provider] ??= { primary: 0, tab: 0, spam: 0, missing: 0, total: 0 });
    p[r.folder]++;
    p.total++;
  }

  return {
    primaryRate: pct(primary, total),
    tabRate: pct(tab, total),
    spamRate: pct(spam, total),
    missing,
    placementScore: total > 0 ? Math.round((weight / total) * 100) : 0,
    perProvider,
  };
}

export function bandOfPrimary(primaryRate: number | null): PlacementBand {
  if (primaryRate === null) return "unknown";
  if (primaryRate >= 80) return "good";
  if (primaryRate >= 60) return "watch";
  if (primaryRate >= 40) return "warn";
  return "critical";
}

export interface SeedRollup {
  /** Decayed % of seeds landing in Primary, or null when never tested. */
  primaryRate: number | null;
  /** Decayed composite placement (primary 1 / tab 0.5 / spam·missing 0), 0-100. */
  placementScore: number | null;
  /** Tests that contributed (recent window). */
  samples: number;
  lastTestedAt: string | null;
  /** True until there are enough tests to trust the number. */
  provisional: boolean;
  band: PlacementBand;
}

const EMPTY_ROLLUP: SeedRollup = {
  primaryRate: null,
  placementScore: null,
  samples: 0,
  lastTestedAt: null,
  provisional: true,
  band: "unknown",
};

/**
 * Decayed roll-up of one mailbox's tests. Recent tests dominate (exponential
 * decay by `halflifeDays`); `provisional` until `minSamples` tests exist.
 */
export function rollupHealth(
  tests: InboxTest[],
  opts: { halflifeDays?: number; minSamples?: number; now?: Date } = {},
): SeedRollup {
  const halflife = Math.max(0.5, opts.halflifeDays ?? 10);
  const minSamples = Math.max(1, opts.minSamples ?? 2);
  const now = opts.now ?? new Date();

  const done = tests
    .filter((t) => t.status === "done" && t.summary)
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
    .slice(0, 10);
  if (done.length === 0) return { ...EMPTY_ROLLUP };

  let wp = 0;
  let ws = 0;
  let w = 0;
  for (const t of done) {
    const ageDays = Math.max(0, (now.getTime() - Date.parse(t.started_at)) / 86_400_000);
    const decay = Math.pow(0.5, ageDays / halflife);
    wp += decay * t.summary!.primaryRate;
    ws += decay * t.summary!.placementScore;
    w += decay;
  }
  const primaryRate = w > 0 ? Math.round((wp / w) * 10) / 10 : null;
  return {
    primaryRate,
    placementScore: w > 0 ? Math.round(ws / w) : null,
    samples: done.length,
    lastTestedAt: done[0].started_at ?? null,
    provisional: done.length < minSamples,
    band: bandOfPrimary(primaryRate),
  };
}

/** Roll up every mailbox's tests, keyed by lowercased sending address. */
export function rollupAll(
  tests: InboxTest[],
  opts: { halflifeDays?: number; minSamples?: number; now?: Date } = {},
): Map<string, SeedRollup> {
  const byMailbox = new Map<string, InboxTest[]>();
  for (const t of tests) {
    const key = (t.mailbox ?? "").trim().toLowerCase();
    if (!key) continue;
    (byMailbox.get(key) ?? byMailbox.set(key, []).get(key)!).push(t);
  }
  const out = new Map<string, SeedRollup>();
  for (const [email, list] of byMailbox) out.set(email, rollupHealth(list, opts));
  return out;
}

// --- Folder classification from what IMAP hands back -----------------------

/**
 * Classify a Gmail message from its labels (Gmail IMAP's `X-GM-LABELS`, read
 * from an All-Mail search). Spam wins; then a category label (Promotions /
 * Social / Updates / Forums) means it landed in a tab, not Primary; an Inbox
 * label with no category is Primary; anything else (archived / no inbox) is
 * effectively not delivered to the inbox.
 */
export function folderFromGmail(labels: string[]): SeedFolder {
  const norm = labels.map((l) => String(l).toLowerCase());
  if (norm.some((l) => /spam|junk/.test(l))) return "spam";
  if (norm.some((l) => /promotion|social|update|forum|category_/.test(l))) return "tab";
  if (norm.some((l) => /inbox/.test(l))) return "primary";
  return "missing";
}

/**
 * Classify by the IMAP folder a message was found in (Outlook, Yahoo, iCloud,
 * generic IMAP). Honest limit: Outlook's Focused vs Other both live under INBOX
 * over IMAP, so we can only distinguish inbox (Primary) / junk (Spam) / missing.
 * "" or null folder means the token wasn't found anywhere → missing.
 */
export function folderFromOutlook(mailbox: string | null | undefined): SeedFolder {
  const m = String(mailbox ?? "").toLowerCase();
  if (!m) return "missing";
  if (/junk|spam|bulk/.test(m)) return "spam";
  if (/inbox/.test(m)) return "primary";
  if (/deleted|trash/.test(m)) return "missing";
  return "primary";
}

/** Pull spf/dkim/dmarc verdicts out of the Authentication-Results header(s). */
export function parseAuthResults(headers: string): { spf?: string; dkim?: string; dmarc?: string } {
  const grab = (re: RegExp): string | undefined => {
    const m = headers.match(re);
    return m ? m[1].toLowerCase() : undefined;
  };
  const out: { spf?: string; dkim?: string; dmarc?: string } = {
    spf: grab(/\bspf=(\w+)/i),
    dkim: grab(/\bdkim=(\w+)/i),
    dmarc: grab(/\bdmarc=(\w+)/i),
  };
  if (!out.spf) delete out.spf;
  if (!out.dkim) delete out.dkim;
  if (!out.dmarc) delete out.dmarc;
  return out;
}
