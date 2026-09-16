// ---------------------------------------------------------------------------
// Pure decision logic for the periodic rotation swap.
//
// A rotation-managed campaign keeps two FIXED same-niche cohorts (A and B) and
// alternates the whole connected set every `interval_days`. This module decides
// WHAT to do — pick the locked partner cohort, tell whether a campaign is due,
// which set to connect next, and how to pair out↔in for the notification. It
// touches no network and no DOM; the engine (_rotationRun.ts) and the UI
// (RotationPanel) call it and perform the reads/writes.
// ---------------------------------------------------------------------------
import { eligibleFor, tagsFor, type TagMap } from "./tags";
import type { RotationState } from "./types";

const DAY_MS = 86_400_000;
const norm = (e: string): string => (e ?? "").trim().toLowerCase();

// --- Cohort B selection (auto-pick idle same-niche spares, locked) ---------

/** A candidate idle inbox for the partner cohort. */
export interface RotationCandidate {
  email: string;
  dailyLimit: number;
  mature?: boolean;
  healthScore?: number | null;
}

export interface SelectCohortBInput {
  /** Idle inboxes (attached to no campaign). Niche is filtered here, not by the caller. */
  idle: RotationCandidate[];
  /** The campaign's niche tags (both sides must overlap; untagged matches nothing). */
  campaignTags: string[];
  tagMap: TagMap;
  /** Target size = cohort A's size. Fewer are returned when the pool is short (unequal is allowed). */
  size: number;
  /** Emails already locked to another rotation cohort — never picked. */
  reserved?: Set<string>;
}

export interface CohortBResult {
  picks: string[];
  /** size - picks.length; > 0 means the partner cohort is smaller than A. */
  shortfall: number;
  /** How many eligible idle spares existed before slicing to `size`. */
  poolSize: number;
}

/**
 * Pick up to `size` idle, same-niche spares as the fixed partner cohort, ranked
 * mature → healthier → bigger daily limit → email. Returns fewer than `size`
 * when the same-niche idle pool is short (the user chose "proceed unequal").
 */
export function selectCohortB(input: SelectCohortBInput): CohortBResult {
  const reserved = input.reserved ?? new Set<string>();
  const size = Math.max(0, Math.floor(input.size));
  const eligible = input.idle.filter(
    (b) =>
      b.email &&
      !reserved.has(norm(b.email)) &&
      eligibleFor(tagsFor(input.tagMap, b.email), input.campaignTags),
  );
  const ranked = [...eligible].sort((a, b) => {
    const ma = a.mature ? 1 : 0;
    const mb = b.mature ? 1 : 0;
    if (ma !== mb) return mb - ma;
    const sa = a.healthScore ?? -1;
    const sb = b.healthScore ?? -1;
    if (sa !== sb) return sb - sa;
    if (a.dailyLimit !== b.dailyLimit) return b.dailyLimit - a.dailyLimit;
    return norm(a.email).localeCompare(norm(b.email));
  });
  // Dedupe while preserving rank order.
  const picks: string[] = [];
  const seen = new Set<string>();
  for (const b of ranked) {
    const e = norm(b.email);
    if (seen.has(e)) continue;
    seen.add(e);
    picks.push(e);
    if (picks.length >= size) break;
  }
  return { picks, shortfall: Math.max(0, size - picks.length), poolSize: eligible.length };
}

// --- Rotation timing -------------------------------------------------------

export function daysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / DAY_MS);
}

export function nextDueMs(lastMs: number, intervalDays: number): number {
  return lastMs + Math.max(1, intervalDays) * DAY_MS;
}

/**
 * Is this campaign due to rotate now? A freshly-enabled campaign (its active
 * cohort just connected) is NOT due until `interval_days` have elapsed since
 * `last_rotated_at`, which is stamped at enable time.
 */
export function dueForRotation(
  state: Pick<RotationState, "enabled" | "last_rotated_at" | "interval_days">,
  nowMs: number,
  defaultIntervalDays = 15,
): boolean {
  if (!state.enabled) return false;
  if (!state.last_rotated_at) return false;
  const last = Date.parse(state.last_rotated_at);
  if (!Number.isFinite(last)) return false;
  const interval = state.interval_days && state.interval_days > 0 ? state.interval_days : defaultIntervalDays;
  return daysBetween(last, nowMs) >= interval;
}

// --- What the swap does ----------------------------------------------------

export interface RotationPlan {
  direction: "A→B" | "B→A";
  /** The cohort to connect. */
  target: string[];
  /** The currently-active cohort being disconnected (goes to rest). */
  resting: string[];
}

export function planRotation(state: Pick<RotationState, "active" | "cohort_a" | "cohort_b">): RotationPlan {
  const toB = state.active === "A";
  return {
    direction: toB ? "A→B" : "B→A",
    target: (toB ? state.cohort_b : state.cohort_a).map(norm),
    resting: (toB ? state.cohort_a : state.cohort_b).map(norm),
  };
}

/**
 * Pair outgoing↔incoming by index for the notification. When the cohorts are
 * unequal, the surplus side pairs with an empty string on the other (a rested
 * inbox with no replacement, or an inbox returning with no counterpart leaving).
 */
export function pairSwaps(out: string[], inn: string[]): { out: string; in: string }[] {
  const n = Math.max(out.length, inn.length);
  const pairs: { out: string; in: string }[] = [];
  for (let i = 0; i < n; i++) pairs.push({ out: norm(out[i] ?? ""), in: norm(inn[i] ?? "") });
  return pairs;
}

export function capacityOf(emails: string[], dailyLimitByEmail: Map<string, number>): number {
  return emails.reduce((sum, e) => sum + (dailyLimitByEmail.get(norm(e)) ?? 0), 0);
}

/** Every email locked to an ENABLED rotation cohort — reserved from other use. */
export function reservedEmails(
  states: Pick<RotationState, "enabled" | "cohort_a" | "cohort_b">[],
): Set<string> {
  const s = new Set<string>();
  for (const st of states) {
    if (!st.enabled) continue;
    for (const e of st.cohort_a ?? []) s.add(norm(e));
    for (const e of st.cohort_b ?? []) s.add(norm(e));
  }
  return s;
}
