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
  // Dedupe while preserving rank order. Check the limit BEFORE pushing so size 0
  // yields no picks (rather than one).
  const picks: string[] = [];
  const seen = new Set<string>();
  for (const b of ranked) {
    if (picks.length >= size) break;
    const e = norm(b.email);
    if (seen.has(e)) continue;
    seen.add(e);
    picks.push(e);
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

/** Emails locked to an enabled rotation cohort of a DIFFERENT campaign. */
export function reservedByOtherCampaign(
  states: Pick<RotationState, "enabled" | "campaign_id" | "cohort_a" | "cohort_b">[],
  campaignId: string,
): Set<string> {
  const s = new Set<string>();
  for (const st of states) {
    if (!st.enabled || st.campaign_id === campaignId) continue;
    for (const e of st.cohort_a ?? []) s.add(norm(e));
    for (const e of st.cohort_b ?? []) s.add(norm(e));
  }
  return s;
}

/** Which rotation cohort an inbox belongs to, if any. */
export interface RotationMember {
  campaignId: string;
  campaignName: string;
  cohort: "A" | "B";
  /** True when this cohort is the one currently connected (sending). Always false while paused. */
  active: boolean;
  /** True when the rotation is paused (config kept, not rotating). */
  paused: boolean;
}

/**
 * Map every inbox locked to ANY existing rotation cohort — enabled OR paused — to
 * which campaign/cohort holds it, whether it's currently sending, and whether the
 * rotation is paused. A cohort inbox stays reserved (off-limits to auto-populate,
 * not "free") as long as the rotation config exists; only Forget/delete frees it.
 * Enabled states are processed first so an active/enabled membership wins over a
 * paused one if the same email somehow appears in both (the "used" guard is meant
 * to prevent that; this stays deterministic if it slips).
 */
export function rotationMembership(
  states: Pick<RotationState, "enabled" | "campaign_id" | "campaign_name" | "cohort_a" | "cohort_b" | "active">[],
): Map<string, RotationMember> {
  const m = new Map<string, RotationMember>();
  const ordered = [...states].sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)));
  for (const st of ordered) {
    const paused = !st.enabled;
    const add = (email: string, cohort: "A" | "B") => {
      const e = norm(email);
      if (!e || m.has(e)) return;
      m.set(e, {
        campaignId: st.campaign_id,
        campaignName: st.campaign_name || st.campaign_id,
        cohort,
        active: !paused && st.active === cohort,
        paused,
      });
    };
    for (const e of st.cohort_a ?? []) add(e, "A");
    for (const e of st.cohort_b ?? []) add(e, "B");
  }
  return m;
}

// --- Manual-picker classification (the "already used" guard) ----------------

export type AccountUse = "available" | "used" | "wrong";
export type AccountUseReason = "other-cohort" | "other-campaign" | "other-rotation" | "not-ready" | "wrong-niche" | null;

export interface ClassifyAccountInput {
  email: string;
  /** The inbox's resolved niche tags (`tagsFor(tagMap, email)`). */
  mailboxTags: string[];
  /** The target campaign's niche. */
  campaignTags: string[];
  /** Every campaign (any status) the inbox is attached to (`allCampaignIds`). */
  allCampaignIds: string[];
  /** active && !excluded && !setupPending — is the inbox usable at all. */
  ready: boolean;
  /** The campaign whose cohort is being edited (its own attachment is fine). */
  campaignId: string;
  /** This campaign's OTHER cohort (can't be in both), lowercased. */
  otherCohort: Set<string>;
  /** Emails locked to another campaign's rotation cohort, lowercased. */
  reservedByOther: Set<string>;
}

/**
 * Can this account be ADDED to the cohort? Strict same-niche, and "used" if it's
 * on another campaign (any status), locked in another rotation cohort, or already
 * in this campaign's other cohort. Order matters: the "used" checks come before
 * the niche check so a same-niche account that's used elsewhere still reads as
 * used, not available.
 */
export function classifyAccount(inp: ClassifyAccountInput): { status: AccountUse; reason: AccountUseReason } {
  const e = norm(inp.email);
  if (inp.otherCohort.has(e)) return { status: "used", reason: "other-cohort" };
  if ((inp.allCampaignIds ?? []).some((id) => id !== inp.campaignId)) return { status: "used", reason: "other-campaign" };
  if (inp.reservedByOther.has(e)) return { status: "used", reason: "other-rotation" };
  if (!inp.ready) return { status: "wrong", reason: "not-ready" };
  if (!eligibleFor(inp.mailboxTags, inp.campaignTags)) return { status: "wrong", reason: "wrong-niche" };
  return { status: "available", reason: null };
}
