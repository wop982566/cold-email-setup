// ---------------------------------------------------------------------------
// Mailboxes pulled out of live campaigns, and whether they're actually getting
// better.
//
// Two jobs:
//   1. Keep a convalescing mailbox out of the spare pool. Without this, the
//      inbox you just swapped out for a bad score is immediately eligible to be
//      proposed as the replacement for the next campaign.
//   2. Tell you whether warmup is repairing it or it's flat-lined, so "give it
//      another week" is a decision rather than a hope.
//
// Sampling is one point per calendar day — the planner may load twenty times a
// day, and twenty identical points are not a trend.
//
// Pure module — the page fetches and persists, this computes.
// ---------------------------------------------------------------------------
import { RecoveryEntry, RecoveryStatus } from "./types";

/** Samples kept per mailbox. Two months of daily points is plenty of history. */
const MAX_HISTORY = 60;
/** Consecutive good samples before we suggest returning a mailbox to service. */
const CLEAR_SAMPLES = 3;

export type Trend = "improving" | "declining" | "flat" | "unknown";

export interface RecoveryView {
  entry: RecoveryEntry;
  daysOut: number;
  scoreNow: number | null;
  scoreAtSwap: number | null;
  delta: number | null;
  trend: Trend;
  /** Cleared the bar for CLEAR_SAMPLES consecutive samples. */
  eligible: boolean;
  /** Out for a long time with no improvement — worth retiring. */
  stalled: boolean;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function daysBetween(fromIso: string, to: Date): number {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((to.getTime() - t) / 86400000));
}

/** Emails currently convalescing — never proposed as replacements. */
export function recoveringEmails(entries: RecoveryEntry[]): Set<string> {
  return new Set(
    entries.filter((e) => e.status === "recovering").map((e) => e.email.trim().toLowerCase()),
  );
}

/**
 * Append today's reading, or replace today's if one already exists. Returns
 * null when nothing changed, so callers can skip a pointless write.
 */
export function sampleFor(
  entry: RecoveryEntry,
  score: number | null,
  inboxRate: number | null,
  now = new Date(),
): RecoveryEntry["history"] | null {
  const history = Array.isArray(entry.history) ? entry.history : [];
  const at = now.toISOString();
  const today = dayKey(at);
  const last = history[history.length - 1];

  if (last && dayKey(last.at) === today) {
    // Same day: only rewrite if the numbers actually moved.
    if (last.score === score && last.inbox_rate === inboxRate) return null;
    return [...history.slice(0, -1), { at, score, inbox_rate: inboxRate }];
  }
  return [...history, { at, score, inbox_rate: inboxRate }].slice(-MAX_HISTORY);
}

/** Latest known score, preferring live data over stored history. */
function latestScore(entry: RecoveryEntry, live: number | null): number | null {
  if (live !== null) return live;
  const history = Array.isArray(entry.history) ? entry.history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].score !== null) return history[i].score;
  }
  return entry.score_at_swap;
}

function trendOf(entry: RecoveryEntry): Trend {
  const points = (Array.isArray(entry.history) ? entry.history : [])
    .map((h) => h.score)
    .filter((s): s is number => s !== null);
  if (points.length < 2) return "unknown";
  // Compare the last third against the first third — resistant to one bad day.
  const third = Math.max(1, Math.floor(points.length / 3));
  const first = points.slice(0, third);
  const last = points.slice(-third);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const diff = mean(last) - mean(first);
  if (diff >= 5) return "improving";
  if (diff <= -5) return "declining";
  return "flat";
}

export function viewFor(
  entry: RecoveryEntry,
  liveScore: number | null,
  minScore: number,
  now = new Date(),
): RecoveryView {
  const history = Array.isArray(entry.history) ? entry.history : [];
  const scoreNow = latestScore(entry, liveScore);
  const scoreAtSwap = entry.score_at_swap;

  const recent = history.slice(-CLEAR_SAMPLES).map((h) => h.score);
  const eligible =
    entry.status === "recovering" &&
    recent.length >= CLEAR_SAMPLES &&
    recent.every((s) => s !== null && s >= minScore);

  const daysOut = daysBetween(entry.swapped_out_at, now);
  const trend = trendOf(entry);

  return {
    entry,
    daysOut,
    scoreNow,
    scoreAtSwap,
    delta: scoreNow !== null && scoreAtSwap !== null ? scoreNow - scoreAtSwap : null,
    trend,
    eligible,
    // Three weeks out, not improving, still under the bar: warmup isn't
    // fixing this one.
    stalled:
      entry.status === "recovering" &&
      daysOut >= 21 &&
      trend !== "improving" &&
      (scoreNow === null || scoreNow < minScore),
  };
}

// --- Archive ---------------------------------------------------------------
// Every swap ever applied, whatever became of it. Kept separate from
// RecoveryView because that one only ever describes mailboxes still healing,
// while this describes the historical record.

export type ArchiveFilter = "all" | RecoveryStatus;

export interface ArchiveRow {
  entry: RecoveryEntry;
  scoreAtSwap: number | null;
  scoreNow: number | null;
  inboxRateAtSwap: number | null;
  inboxRateNow: number | null;
  daysSince: number;
  /** Whether reversing this swap is offered at all. */
  canUndo: boolean;
  undoBlockedReason: string | null;
  /** Still below the bar it was pulled for — worth warning about, not blocking. */
  stillUnhealthy: boolean;
}

export interface CurrentHealth {
  score: number | null;
  inboxRate: number | null;
}

/**
 * Build the archive, newest swap first.
 *
 * `current` supplies live health per address so a row can show the score at
 * swap time next to the score now — the comparison that makes an undo a
 * decision rather than a guess.
 */
export function archiveRows(
  entries: RecoveryEntry[],
  current: Map<string, CurrentHealth>,
  minScore: number,
  now = new Date(),
): ArchiveRow[] {
  return [...entries]
    .sort((a, b) => (b.swapped_out_at ?? "").localeCompare(a.swapped_out_at ?? ""))
    .map((entry) => {
      const live = current.get(entry.email.trim().toLowerCase()) ?? null;
      const scoreNow = live?.score ?? null;

      // Already put back, or nothing recorded to put back into.
      const undoBlockedReason = entry.status === "restored"
        ? "Already swapped back"
        : !entry.replaced_by
          ? "No replacement recorded, so there's nothing to reverse"
          : entry.campaign_ids.length === 0
            ? "No campaign recorded for this swap"
            : null;

      return {
        entry,
        scoreAtSwap: entry.score_at_swap,
        scoreNow,
        inboxRateAtSwap: entry.inbox_rate_at_swap,
        inboxRateNow: live?.inboxRate ?? null,
        daysSince: daysBetween(entry.swapped_out_at, now),
        canUndo: undoBlockedReason === null,
        undoBlockedReason,
        // Unknown is not unhealthy — we only warn on a measured, still-low score.
        stillUnhealthy: scoreNow !== null && scoreNow < minScore,
      };
    });
}

/**
 * Is this swap completely reversed — every campaign it touched confirmed back?
 *
 * The gate on deleting the record. A partly-reversed swap is still live
 * somewhere, and dropping its row would leave no way to find or finish it. Only
 * ids the caller CONFIRMED are passed in; an unconfirmed write contributes
 * nothing, so an undo we couldn't verify can never clear the row.
 */
export function fullyRestored(entry: RecoveryEntry, confirmedIds: string[]): boolean {
  if (entry.campaign_ids.length === 0) return false;
  const confirmed = new Set(confirmedIds);
  return entry.campaign_ids.every((id) => confirmed.has(id));
}

/** What a "clear the archive" click would actually destroy. */
export interface ClearImpact {
  total: number;
  /** Rows whose exclusion is doing live work — clearing frees them as spares. */
  healing: number;
  ids: string[];
}

export function clearImpact(rows: ArchiveRow[]): ClearImpact {
  return {
    total: rows.length,
    healing: rows.filter((r) => r.entry.status === "recovering").length,
    ids: rows.map((r) => r.entry.id),
  };
}

export function filterArchive(rows: ArchiveRow[], filter: ArchiveFilter): ArchiveRow[] {
  return filter === "all" ? rows : rows.filter((r) => r.entry.status === filter);
}

export function archiveCounts(rows: ArchiveRow[]): Record<ArchiveFilter, number> {
  const counts: Record<ArchiveFilter, number> = {
    all: rows.length,
    recovering: 0,
    recovered: 0,
    restored: 0,
    retired: 0,
  };
  for (const r of rows) counts[r.entry.status]++;
  return counts;
}

export function summarise(views: RecoveryView[]) {
  const active = views.filter((v) => v.entry.status === "recovering");
  return {
    recovering: active.length,
    eligible: active.filter((v) => v.eligible).length,
    stalled: active.filter((v) => v.stalled).length,
    improving: active.filter((v) => v.trend === "improving").length,
  };
}
