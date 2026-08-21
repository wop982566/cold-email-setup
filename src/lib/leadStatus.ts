// ---------------------------------------------------------------------------
// A campaign's lead-status counts, the way Instantly reports them.
//
// The planner used to compute "leads remaining" as total − contacted, reading
// Instantly's `contacted_count`. But that counter is cumulative and can exceed
// the current list size (a campaign showed 3,122 contacted against a 3,073-lead
// list), so the subtraction went negative, got clamped to 0, and the whole
// campaign was declared "list done" when it was 14% through. Instantly's own UI
// never does that — it shows Completed / In Progress / Not-yet-contacted counts
// that always sum to the total.
//
// So this reads those real per-status fields when present, and NEVER produces a
// count larger than the total. When Instantly returns only the cumulative
// counter, it says so (`source: "counter"`) and leaves "not yet contacted"
// unknown rather than inventing a "done".
//
// Pure module.
// ---------------------------------------------------------------------------

export interface LeadStatusCounts {
  total: number;
  /** Leads that finished the sequence. Null when Instantly didn't report it. */
  completed: number | null;
  inProgress: number | null;
  /** The real "leads left" to first-contact — drives the ETA. Null = unknown. */
  notYetContacted: number | null;
  /** total − notYetContacted. Null when notYetContacted is unknown. */
  contacted: number | null;
  /** completed / total × 100 — Instantly's headline "Progress". Null = unknown. */
  pctComplete: number | null;
  /**
   *  - "status":  read straight from Instantly's per-status fields (or a per-lead
   *               aggregation) — the trustworthy case.
   *  - "derived": notYet computed as total − completed − inProgress.
   *  - "counter": only the cumulative contacted_count was available; counts are
   *               clamped and notYet is left unknown.
   *  - "unknown": nothing usable.
   */
  source: "status" | "derived" | "counter" | "unknown";
}

/** First numeric value among keys, or null when NONE of the keys is present. */
function pickNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  }
  return null;
}

const clamp = (n: number, hi: number) => Math.max(0, Math.min(n, hi));

const K = {
  total: ["leads_count", "total_leads", "leads_total"],
  completed: ["completed_count", "completed", "leads_completed", "total_completed", "completed_leads_count"],
  inProgress: ["in_progress", "in_progress_count", "leads_in_progress", "contacted_in_progress"],
  notYet: ["not_yet_contacted", "not_yet_contacted_count", "leads_not_contacted", "uncontacted_count", "leads_who_are_not_yet_contacted"],
  // The cumulative counter that overshoots — used only as a last resort.
  contactedCounter: ["contacted_count", "contacted"],
};

/**
 * Reconcile one analytics row into trustworthy counts.
 *
 * Never returns a count greater than `total`. Prefers Instantly's per-status
 * fields; falls back to deriving not-yet-contacted from completed + in-progress;
 * and if only the cumulative counter exists, clamps it and leaves not-yet
 * unknown so no caller can mistake it for "done".
 */
export function leadStatusOf(row: Record<string, unknown> | null | undefined): LeadStatusCounts {
  const r = row ?? {};
  const total = pickNum(r, K.total) ?? 0;
  const completedRaw = pickNum(r, K.completed);
  const inProgressRaw = pickNum(r, K.inProgress);
  const completed = completedRaw === null ? null : clamp(completedRaw, total);
  const inProgress = inProgressRaw === null ? null : clamp(inProgressRaw, total);

  const empty: LeadStatusCounts = {
    total, completed, inProgress,
    notYetContacted: null, contacted: null, pctComplete: null, source: "unknown",
  };
  if (total <= 0) return { ...empty, source: completed !== null || inProgress !== null ? "status" : "unknown" };

  const pctComplete = completed === null ? null : (completed / total) * 100;

  // 1. A real "not yet contacted" field — the cleanest signal, matches Instantly.
  const notYetRaw = pickNum(r, K.notYet);
  if (notYetRaw !== null) {
    const notYet = clamp(notYetRaw, total);
    return { total, completed, inProgress, notYetContacted: notYet, contacted: total - notYet, pctComplete, source: "status" };
  }

  // 2. Derive it from the parts, since completed + in-progress + not-yet = total.
  if (completed !== null && inProgress !== null) {
    const notYet = clamp(total - completed - inProgress, total);
    return { total, completed, inProgress, notYetContacted: notYet, contacted: total - notYet, pctComplete, source: "derived" };
  }

  // 3. Only the cumulative counter. Clamp so it can't exceed the list, and leave
  //    "not yet contacted" unknown — never claim the list is done from this.
  const counter = pickNum(r, K.contactedCounter);
  if (counter !== null) {
    return {
      total, completed, inProgress,
      notYetContacted: null,
      contacted: clamp(counter, total),
      pctComplete,
      source: "counter",
    };
  }

  return { ...empty, pctComplete, source: completed !== null ? "status" : "unknown" };
}

// --- The exact backstop: aggregate the per-lead list --------------------------

export interface LeadRow {
  /** Instantly lead status; 3 = completed sequence. */
  status?: number;
  /** The proxy's derived flag: has this lead been emailed at least once. */
  contacted?: boolean;
}

/**
 * Exact counts from the per-lead `leads` resource — the guaranteed-correct
 * source when the analytics row is thin. `contacted` is the proxy's own flag;
 * `status === 3` is a completed sequence. Matches Instantly's numbers because
 * it's the same per-lead truth its UI counts.
 */
export function aggregateLeadCounts(rows: readonly LeadRow[]): LeadStatusCounts {
  const total = rows.length;
  let completed = 0;
  let contacted = 0;
  for (const r of rows) {
    if (r.status === 3) completed++;
    if (r.contacted) contacted++;
  }
  const notYet = clamp(total - contacted, total);
  return {
    total,
    completed,
    inProgress: total > 0 ? clamp(contacted - completed, total) : 0,
    notYetContacted: notYet,
    contacted,
    pctComplete: total > 0 ? (completed / total) * 100 : null,
    source: "status",
  };
}
