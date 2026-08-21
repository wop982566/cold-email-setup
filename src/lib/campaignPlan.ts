// ---------------------------------------------------------------------------
// Campaign planner: per-campaign and per-group capacity, using the campaign ->
// mailbox linkage Instantly exposes as `email_list`.
//
// The key correctness rule: a mailbox attached to several campaigns does NOT
// give its daily limit to each of them — the limit is SHARED. Naively summing
// each campaign's mailboxes would invent capacity that doesn't exist, so supply
// is allocated as a fair share (limit / number of active campaigns using it).
//
// Pure module — the page fetches, this computes.
// ---------------------------------------------------------------------------
import { AppSettings, CostItem } from "./types";
import { CapacityResult } from "./capacity";
import { monthlyCost } from "./costs";
import { asItems, pick } from "./apiShape";
import { leadStatusOf, type LeadStatusCounts } from "./leadStatus";

const F = {
  acctDailyLimit: ["daily_limit", "daily_sending_limit", "sending_limit", "max_daily_limit"],
  campDailyLimit: ["daily_limit", "campaign_daily_limit"],
  campMaxLeads: ["daily_max_leads", "max_new_leads_per_day"],
  warmupScore: ["stat_warmup_score", "warmup_score"],
  leadsTotal: ["leads_count", "total_leads"],
  contacted: ["contacted_count", "contacted"],
  newContacted: ["new_leads_contacted_count"],
  sent: ["emails_sent_count", "sent_count", "emails_sent", "total_sent"],
  replies: ["reply_count", "replied_count", "total_replies"],
  bounced: ["bounced_count", "bounce_count"],
  opps: ["total_opportunities", "opportunities_count", "opportunities"],
};

const MISSING = -1; // pick() returns 0 for absent keys, so limits need a sentinel

/**
 * How many emails one lead receives — the number of steps in the campaign's
 * sequence. A lead runs through one sequence, so where a campaign carries
 * several (A/B variants) the longest is what a lead can cost.
 * Returns 0 when the payload doesn't describe steps, so the caller can fall
 * back to the configured default and say that's what it did.
 */
export function sequenceStepsOf(c: Obj): number {
  const seqs = Array.isArray(c.sequences) ? (c.sequences as unknown[]) : [];
  let steps = 0;
  for (const s of seqs) {
    if (!s || typeof s !== "object") continue;
    const list = (s as Obj).steps;
    if (Array.isArray(list)) steps = Math.max(steps, list.length);
  }
  if (steps > 0) return steps;
  // Some payloads expose a flat count instead of the step objects.
  for (const k of ["sequence_steps", "steps_count", "step_count"]) {
    const v = c[k];
    if (typeof v === "number" && v > 0) return Math.trunc(v);
    if (Array.isArray(v) && v.length > 0) return v.length;
  }
  return 0;
}
const UNGROUPED = "Ungrouped";
const RUNWAY_WARN_DAYS = 7;
const BOUNCE_WARN_PCT = 3;
const WINDOW_DAYS = 30; // the analytics range the page requests

type Obj = Record<string, unknown>;

/** Project a date N calendar days out, as YYYY-MM-DD. */
function addDays(from: Date, days: number): string {
  const capped = Math.min(days, 3650); // don't render dates a century away
  return new Date(from.getTime() + capped * 86400000).toISOString().slice(0, 10);
}

export interface PlannerMailbox {
  email: string;
  dailyLimit: number; // effective (live limit, or the planned fallback)
  active: boolean;
  warmingUp: boolean;
  warmupScore: number;
  excluded: boolean;
  campaignIds: string[]; // ACTIVE campaigns only
  allCampaignIds: string[]; // every campaign, any status — what a swap must touch
  groups: string[];
  shareCount: number; // active campaigns sharing this mailbox
  idle: boolean; // attached to no campaign at all
  pausedOnly: boolean; // attached only to non-active campaigns — free to reuse
  // Dropped because it falls outside the "inboxes I'm actually using" count,
  // rather than being excluded by hand.
  beyondCount: boolean;
  // --- raw health signals (consumed by mailboxHealth.ts) --------------------
  warmupScoreKnown: boolean; // false => score absent, NOT a genuine zero
  warmupOn: boolean;
  setupPending: boolean;
  statusRaw: number | string;
  createdAt: string | null; // separates "new and ramping" from "mature and burned"
  lastUsedAt: string | null;
  providerCode: number | null;
}

/**
 * Picks the N mailboxes most plausibly in use, when the operator has told us
 * they only run campaigns from some of their connected inboxes. Ranking is
 * deterministic: attached to an active campaign first, then the bigger daily
 * limit, then alphabetical. Returns the set to KEEP.
 */
export function rankAndTrim<T extends { email: string; dailyLimit: number }>(
  boxes: T[],
  attached: Set<string>,
  count: number,
): Set<string> {
  if (!count || count <= 0 || count >= boxes.length) {
    return new Set(boxes.map((b) => b.email));
  }
  const ranked = [...boxes].sort((a, b) => {
    const aA = attached.has(a.email) ? 1 : 0;
    const bA = attached.has(b.email) ? 1 : 0;
    if (aA !== bA) return bA - aA;
    if (a.dailyLimit !== b.dailyLimit) return b.dailyLimit - a.dailyLimit;
    return a.email.localeCompare(b.email);
  });
  return new Set(ranked.slice(0, count).map((b) => b.email));
}

/** Emails attached to at least one ACTIVE campaign, from `email_list`. */
export function attachedEmails(campaignsData: unknown): Set<string> {
  const out = new Set<string>();
  for (const c of asItems<Obj>(campaignsData)) {
    if (!isActiveCampaign(c)) continue;
    const list = Array.isArray(c.email_list) ? (c.email_list as unknown[]) : [];
    for (const e of list) {
      const email = String(e ?? "").trim().toLowerCase();
      if (email) out.add(email);
    }
  }
  return out;
}

export interface PlannerCampaign {
  id: string;
  name: string;
  group: string;
  /**
   * Tags as Instantly reports them, when this workspace exposes any. Read
   * opportunistically off the payload we already fetch — no extra endpoint, and
   * an empty array simply means the field wasn't there.
   */
  instantlyTags: string[];
  active: boolean;
  dailyLimit: number;
  dailyMaxLeads: number;
  prioritizeNewLeads: boolean | null;
  emails: string[];
  mailboxCount: number;
  supplyDaily: number; // contention-aware
  gapDaily: number; // demand - supply, positive = short
  leadsTotal: number;
  leadsContacted: number;
  leadsRemaining: number; // = notYetContacted when known; the real "leads left"
  pctContacted: number;
  // Instantly's per-status breakdown, read straight from its numbers rather than
  // derived by subtraction (which used to overshoot and declare a live list
  // "done"). Null fields = Instantly didn't report that status.
  leadsCompleted: number | null;
  leadsInProgress: number | null;
  notYetContacted: number | null;
  pctComplete: number | null; // completed / total — Instantly's headline "Progress"
  countsSource: LeadStatusCounts["source"];
  // What this campaign ACTUALLY sent, against all the capacity figures above.
  // Already read from analytics for the reply/bounce rates — surfaced so a row
  // can show sending vs. capacity rather than only capacity.
  sentLast30: number;
  sentPerDay: number; // per sending day, to compare against supplyDaily

  // --- Capacity-based completion -------------------------------------------
  // The other completion question, and the one worth planning against: if these
  // mailboxes ran flat out, when would the list be finished? Contacting a lead
  // costs one email per sequence step, so the work is leads x steps, and the
  // rate is the mailbox supply — nothing to do with how fast Instantly happens
  // to be introducing leads today.
  sequenceSteps: number;
  sequenceStepsKnown: boolean; // false => fell back to the app-wide setting
  emailsNeeded: number; // leadsRemaining x sequenceSteps
  daysAtCapacity: number | null; // SENDING days at full mailbox supply
  daysAtCapacityCalendar: number | null;
  capacityFinishDate: string | null;
  // New leads/day the campaign would have to introduce to run at capacity.
  leadsPerDayAtCapacity: number | null;
  newLeadsPerDay: number; // per SENDING day — what the operator recognises
  newLeadsPerCalendarDay: number; // per calendar day — drives the ETA
  newLeadRateObserved: boolean; // false = derived from config, not real sends
  daysToFinish: number | null; // calendar days until every lead is contacted
  finishDate: string | null; // YYYY-MM-DD projection
  replyRate: number;
  bounceRate: number;
  opportunities: number;
  health: HealthScore;
}

export interface PlannerGroup {
  key: string;
  campaigns: PlannerCampaign[];
  activeCampaigns: number;
  demandDaily: number;
  supplyDaily: number;
  gapDaily: number;
  surplusDaily: number; // supply - demand, positive = spare capacity
  mailboxes: number;
  exclusiveMailboxes: number;
  sharedMailboxes: number;
  inboxesNeeded: number;
  domainsNeeded: number;
  leadsRemaining: number;
  newLeadsPerDay: number; // per sending day, summed across the group
  daysToFinish: number | null;
  finishDate: string | null;
  replyRate: number;
  health: HealthScore;
}

export interface GoalResult {
  kind: "emails" | "leads";
  value: number;
  emailsPerDay: number; // steady-state email volume the goal implies
  newLeadsPerDay: number;
  inboxesRequired: number;
  inboxesToAdd: number;
  domainsToAdd: number;
  monthlyCostAdd: number | null; // null when no per-unit cost item exists
  daysToReady: number;
  providerCeiling: number; // tightest provider daily cap
  providerOk: boolean;
}

export interface PlannerAction {
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
}

export interface Plan {
  linkageAvailable: boolean;
  groups: PlannerGroup[];
  campaigns: PlannerCampaign[];
  mailboxes: PlannerMailbox[];
  idleMailboxes: PlannerMailbox[];
  excludedCount: number;
  usableInboxes: number;
  connectedInboxes: number; // active in Instantly, before any manual trimming
  attachedInboxes: number; // attached to at least one active campaign
  beyondCountInboxes: number; // dropped by the "inboxes I'm using" count
  activeInboxCount: number; // the configured count (0 = use all)
  perBoxCap: number;
  totalDemand: number;
  totalSupply: number;
  totalGap: number;
  warmupAdjustedSupply: number;
  truncated: boolean;
  health: HealthScore; // whole-workspace rollup
  goal: GoalResult;
  actions: PlannerAction[];
}

export interface PlanInput {
  accountsData: unknown;
  campaignsData: unknown;
  analyticsData: unknown;
  cap: CapacityResult;
  settings: AppSettings;
  costs?: CostItem[];
  // Inbox-vs-spam rates, when warmup analytics has been fetched. Optional
  // throughout: without it health falls back to warmup score alone.
  placement?: PlacementInput;
  // Exact per-campaign lead counts from the per-lead `leads` resource, fetched
  // on demand. When present for a campaign, they override the analytics-derived
  // counts — the guaranteed-correct source that matches Instantly's own numbers.
  leadCounts?: Map<string, LeadStatusCounts>;
  today?: Date; // injected so completion dates stay deterministic in tests
}

function limitOf(o: Obj, keys: string[]): number {
  const v = pick(o, keys, MISSING);
  if (!Number.isFinite(v) || v === MISSING) return MISSING;
  return Math.max(0, v);
}

function mode(nums: number[]): number {
  const counts = new Map<number, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = 0;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function rate(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}

/** A mailbox whose capacity actually counts towards supply. */
function inUse(b: PlannerMailbox | undefined): b is PlannerMailbox {
  return Boolean(b && b.active && !b.excluded && !b.beyondCount);
}

export type HealthBand = "good" | "fair" | "at-risk" | "critical" | "unknown";

export interface HealthScore {
  score: number; // 0-100
  band: HealthBand;
  mailboxes: number;
  scored: number; // how many contributed a known warmup score
  unknown: number;
  broken: number;
  weakest: { email: string; score: number } | null;
  placementChecked: number; // mailboxes with a measured inbox-vs-spam rate
  worstPlacement: { email: string; inboxRate: number } | null;
  note: string; // one line explaining what drove it
}

/** Inbox-vs-spam rate per mailbox, as supplied by placement.ts. */
export type PlacementInput = Map<string, { inboxRate: number | null }>;

export function bandFor(score: number, scored: number): HealthBand {
  if (scored === 0) return "unknown";
  if (score >= 85) return "good";
  if (score >= 70) return "fair";
  if (score >= 50) return "at-risk";
  return "critical";
}

/**
 * Health of a set of mailboxes, 0-100.
 *
 * Weighted by daily limit rather than a flat mean, because a burned 50/day
 * mailbox does far more damage than a burned 5/day one. Broken accounts score
 * 0 outright — they send nothing — and mailboxes with no reported score are
 * excluded from the mean but counted, so a campaign can't look healthy purely
 * because its scores are missing.
 *
 * When placement data is supplied, each mailbox's contribution is scaled by the
 * share of its warmup mail actually reaching the inbox. A 90-score mailbox that
 * lands half its mail in spam contributes 45, because from the campaign's point
 * of view that is what it is worth. Mailboxes with no measured rate are scaled
 * by nothing — absent data must never read as a penalty.
 */
export function healthOf(boxes: PlannerMailbox[], placement?: PlacementInput): HealthScore {
  const broken = boxes.filter((b) => !b.active || b.setupPending);
  const unknown = boxes.filter((b) => b.active && !b.setupPending && !b.warmupScoreKnown);
  const scored = boxes.filter((b) => b.active && !b.setupPending && b.warmupScoreKnown);

  const rateFor = (email: string): number | null => {
    const r = placement?.get(email)?.inboxRate;
    return typeof r === "number" && Number.isFinite(r) ? Math.min(100, Math.max(0, r)) : null;
  };

  let weighted = 0;
  let weight = 0;
  let placementChecked = 0;
  let worstPlacement: { email: string; inboxRate: number } | null = null;

  for (const b of scored) {
    const w = Math.max(1, b.dailyLimit);
    const rate = rateFor(b.email);
    if (rate !== null) {
      placementChecked++;
      if (worstPlacement === null || rate < worstPlacement.inboxRate) {
        worstPlacement = { email: b.email, inboxRate: rate };
      }
    }
    const effective = rate === null ? b.warmupScore : b.warmupScore * (rate / 100);
    weighted += effective * w;
    weight += w;
  }
  // Broken mailboxes drag the score down at their full weight, scoring zero.
  for (const b of broken) weight += Math.max(1, b.dailyLimit);

  const score = weight > 0 ? Math.round(weighted / weight) : 0;
  const weakest = scored.reduce<{ email: string; score: number } | null>(
    (min, b) => (min === null || b.warmupScore < min.score ? { email: b.email, score: b.warmupScore } : min),
    null,
  );

  // Each part is a DIFFERENT fact — an overall blended score, a single worst
  // warmup, a single worst placement — so label them. Left unlabelled ("49 ·
  // weakest 57 · 57%") they read as one broken equation.
  const parts: string[] = [];
  if (broken.length) parts.push(`${broken.length} not sending`);
  if (unknown.length) parts.push(`${unknown.length} with no score`);
  if (weakest && weakest.score < 80) parts.push(`weakest inbox ${weakest.score}/100`);
  if (worstPlacement && worstPlacement.inboxRate < 80) {
    parts.push(`worst placement ${Math.round(worstPlacement.inboxRate)}% (${worstPlacement.email})`);
  }

  return {
    score,
    band: bandFor(score, scored.length),
    mailboxes: boxes.length,
    scored: scored.length,
    unknown: unknown.length,
    broken: broken.length,
    weakest,
    placementChecked,
    worstPlacement,
    note: parts.length ? parts.join(" · ") : scored.length ? "all mailboxes healthy" : "no scores reported",
  };
}

// "AEO - US SaaS" -> "AEO". Splits on the separators operators actually use in
// campaign names, then falls back to the whole name.
/**
 * Tags off a raw Instantly payload, if this workspace has them.
 *
 * Written defensively because the shape is unverified — the API docs were
 * unreachable when this was built. Accepts a list of strings or of objects
 * carrying a name/label/tag field, and yields nothing for anything else rather
 * than throwing. Costs no extra request: the payload is already in hand.
 */
export function tagsFromPayload(payload: unknown): string[] {
  const raw = (payload as { tags?: unknown; labels?: unknown } | null)?.tags
    ?? (payload as { labels?: unknown } | null)?.labels;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.trim()) out.push(entry.trim());
      continue;
    }
    if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      const v = o.name ?? o.label ?? o.tag ?? o.title;
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }
  return out;
}

export function groupFromName(name: string): string {
  const token = name.trim().split(/[\s\-–—:|/_]+/).filter(Boolean)[0];
  if (!token) return UNGROUPED;
  return token.toUpperCase();
}

// Instantly campaign status: 0 draft, 1 active, 2 paused, 3 completed,
// 4 running subsequences, negative = suspended. 1 and 4 both send.
function isActiveCampaign(c: Obj): boolean {
  const s = Number(c.status);
  return s === 1 || s === 4;
}

function isActiveAccount(a: Obj): boolean {
  return (Number(a.status) === 1 || a.status === "active") && a.setup_pending !== true;
}

// Per-unit monthly cost from the operator's own cost items, so estimates use
// real pricing rather than a made-up figure.
export function perUnitMonthly(costs: CostItem[], category: string): number | null {
  const items = costs.filter((c) => c.active && c.category === category && c.quantity > 0);
  if (items.length === 0) return null;
  let total = 0;
  for (const i of items) total += monthlyCost(i) / i.quantity;
  return total;
}

export function computePlan({
  accountsData,
  campaignsData,
  analyticsData,
  cap,
  settings,
  costs = [],
  placement,
  leadCounts,
  today,
}: PlanInput): Plan {
  // Weekends still pass on the calendar even though nothing sends, so ETAs are
  // in calendar days while the displayed rate is per sending day.
  const sendingDayFactor = Math.min(7, Math.max(1, settings.sending_days_per_week)) / 7;
  const excluded = new Set(
    (settings.excluded_mailboxes ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  const overrides = settings.campaign_group_overrides ?? {};

  // --- Accounts -------------------------------------------------------------
  const rawAccounts = asItems<Obj>(accountsData);
  const accountsTruncated = Boolean(
    (accountsData as { truncated?: boolean } | null)?.truncated,
  );
  const boxes = new Map<string, PlannerMailbox>();
  for (const a of rawAccounts) {
    const email = String(a.email ?? "").trim().toLowerCase();
    if (!email || boxes.has(email)) continue;
    const lim = limitOf(a, F.acctDailyLimit);
    const scoreRaw = limitOf(a, F.warmupScore); // MISSING when the field is absent
    const scoreKnown = scoreRaw !== MISSING;
    const score = scoreKnown ? scoreRaw : 0;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
    boxes.set(email, {
      email,
      dailyLimit: lim === MISSING ? Math.max(0, settings.per_mailbox_daily_limit) : lim,
      active: isActiveAccount(a),
      // Warming = warmup on and the score hasn't matured yet; such a mailbox
      // cannot safely carry its full limit today.
      warmingUp: Number(a.warmup_status) === 1 && score > 0 && score < 90,
      warmupScore: score,
      excluded: excluded.has(email),
      campaignIds: [],
      allCampaignIds: [],
      groups: [],
      shareCount: 0,
      idle: false,
      pausedOnly: false,
      beyondCount: false,
      warmupScoreKnown: scoreKnown,
      warmupOn: Number(a.warmup_status) === 1,
      setupPending: a.setup_pending === true,
      statusRaw: (a.status as number | string) ?? "",
      createdAt: str(a.timestamp_created),
      lastUsedAt: str(a.timestamp_last_used),
      providerCode: typeof a.provider_code === "number" ? a.provider_code : null,
    });
  }

  // "I only run campaigns from 12 of my 20 inboxes" — keep the N most clearly
  // in-use mailboxes and ignore the rest. Explicit per-mailbox exclusions still
  // win, so the count only ever trims what's left.
  const candidates = Array.from(boxes.values()).filter((b) => b.active && !b.excluded);
  const attached = attachedEmails(campaignsData);
  const activeInboxCount = Math.max(0, Math.floor(settings.planner_active_inbox_count ?? 0));
  const keep = rankAndTrim(candidates, attached, activeInboxCount);
  for (const b of candidates) b.beyondCount = !keep.has(b.email);
  const attachedInboxes = candidates.filter((b) => attached.has(b.email)).length;

  // --- Campaigns + linkage --------------------------------------------------
  const rawCampaigns = asItems<Obj>(campaignsData);
  const campaignsTruncated = Boolean(
    (campaignsData as { truncated?: boolean } | null)?.truncated,
  );

  // Per-campaign analytics, keyed by id.
  const stats = new Map<string, Obj>();
  for (const row of asItems<Obj>(analyticsData)) {
    const id = String(row.campaign_id ?? row.id ?? "");
    if (id) stats.set(id, row);
  }

  let sawEmailList = false;
  const parsed = rawCampaigns.map((c) => {
    const id = String(c.id ?? c.campaign_id ?? "");
    const name = String(c.name ?? c.campaign_name ?? "Campaign");
    const list = Array.isArray(c.email_list) ? (c.email_list as unknown[]) : [];
    if (list.length > 0) sawEmailList = true;
    // emailsRaw is the campaign's ACTUAL mailbox list. `emails` drops the ones
    // the operator excluded, which is right for supply math but would silently
    // detach them if it were ever written back to Instantly — so any write path
    // must use emailsRaw.
    const emailsRaw = list.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean);
    const emails = emailsRaw.filter((e) => !excluded.has(e));
    const active = isActiveCampaign(c);
    const lim = limitOf(c, F.campDailyLimit);
    const maxLeads = limitOf(c, F.campMaxLeads);
    return {
      id,
      name,
      group: overrides[id] || groupFromName(name),
      instantlyTags: tagsFromPayload(c),
      active,
      dailyLimit: lim === MISSING ? 0 : lim,
      dailyMaxLeads: maxLeads === MISSING ? 0 : maxLeads,
      sequenceSteps: sequenceStepsOf(c),
      prioritizeNewLeads:
        typeof c.prioritize_new_leads === "boolean" ? c.prioritize_new_leads : null,
      emails,
      emailsRaw,
      status: Number(c.status),
      raw: c,
    };
  });

  // Attribute mailboxes to campaigns. `shareCount` counts only ACTIVE campaigns
  // (that's what the fair-share split needs), but `allCampaignIds` records every
  // campaign regardless of status — without it a mailbox sitting in a paused
  // campaign looks orphaned, and a swap has no way to know which campaigns to
  // touch. Note this walks emailsRaw and skips the inUse() gate so that an
  // excluded or disconnected mailbox still records its linkage; every consumer
  // re-filters by inUse, so no arithmetic changes.
  for (const p of parsed) {
    for (const email of p.emailsRaw) {
      const box = boxes.get(email);
      if (!box) continue;
      if (!box.allCampaignIds.includes(p.id)) box.allCampaignIds.push(p.id);
      if (!p.active) continue;
      box.campaignIds.push(p.id);
      if (!box.groups.includes(p.group)) box.groups.push(p.group);
      box.shareCount++;
    }
  }
  for (const box of boxes.values()) {
    box.idle = inUse(box) && box.allCampaignIds.length === 0;
    // Attached, but only to campaigns that aren't sending — parked, not orphaned,
    // and therefore free to reuse elsewhere.
    box.pausedOnly = inUse(box) && box.shareCount === 0 && box.allCampaignIds.length > 0;
  }

  // --- Per-campaign figures -------------------------------------------------
  const campaigns: PlannerCampaign[] = parsed.map((p) => {
    let supply = 0;
    for (const email of p.emails) {
      const box = boxes.get(email);
      if (!inUse(box)) continue;
      // Fair share: a mailbox in 3 campaigns contributes a third to each.
      supply += box.shareCount > 0 ? box.dailyLimit / box.shareCount : box.dailyLimit;
    }
    const s = stats.get(p.id) ?? {};
    // Real per-status counts, mirroring Instantly — the exact per-lead
    // aggregation when it's been loaded, else reconciled from the analytics row.
    // Never derived by the old total − contacted subtraction, which overshot and
    // declared a live list "done".
    const counts = leadCounts?.get(p.id) ?? leadStatusOf(s);
    const leadsTotal = counts.total;
    // "Leads left" is the real not-yet-contacted count. When Instantly gave only
    // the cumulative counter (notYetContacted unknown), fall back to a clamped
    // total − contacted so we never claim more than the list — but this path is
    // flagged (countsSource "counter") so the UI can say the number is partial.
    const leadsRemaining =
      counts.notYetContacted !== null
        ? counts.notYetContacted
        : Math.max(0, leadsTotal - (counts.contacted ?? 0));
    const leadsContacted = counts.contacted ?? Math.min(pick(s, F.contacted, 0), leadsTotal);
    const sent = pick(s, F.sent, 0);
    const newContacted = pick(s, F.newContacted, 0);

    // Two different rates, because they answer two different questions:
    //  - per SENDING day is what the operator recognises ("I contact 14/day")
    //  - per CALENDAR day is what an ETA has to be built from, since weekends
    //    still pass on the calendar even though nothing sends.
    const observedPerCalendarDay = newContacted > 0 ? newContacted / WINDOW_DAYS : 0;
    const configuredPerSendingDay =
      Math.min(p.dailyMaxLeads > 0 ? p.dailyMaxLeads : Infinity, supply) || 0;
    // Only fall back to the configured rate when the campaign actually has a
    // list — otherwise we'd report a confident rate for a campaign that has
    // never contacted anyone and has nobody to contact.
    const perCalendarDay =
      observedPerCalendarDay > 0
        ? observedPerCalendarDay
        : leadsTotal > 0
          ? configuredPerSendingDay * sendingDayFactor
          : 0;
    const perSendingDay = sendingDayFactor > 0 ? perCalendarDay / sendingDayFactor : perCalendarDay;
    // A campaign only counts as finished when Instantly's OWN not-yet-contacted
    // is a real zero. When we only had the cumulative counter (notYetContacted
    // unknown), never claim "done" — that was the original bug.
    const remainingKnown = counts.notYetContacted !== null;
    const daysToFinish =
      perCalendarDay > 0 && Number.isFinite(perCalendarDay) && leadsRemaining > 0
        ? leadsRemaining / perCalendarDay
        : remainingKnown && leadsRemaining === 0 && leadsTotal > 0
          ? 0 // whole list already contacted
          : null;

    // --- The capacity answer -------------------------------------------------
    // "If these mailboxes ran flat out, when is this list finished?" Working
    // the remaining leads through the sequence costs leads x steps emails, and
    // the mailboxes deliver `supply` of them per sending day. Entirely
    // independent of the observed intake rate above — that one says what WILL
    // happen at today's pace, this says what COULD happen.
    const steps =
      p.sequenceSteps > 0 ? p.sequenceSteps : Math.max(1, settings.default_sends_per_lead || 1);
    const emailsNeeded = leadsRemaining * steps;
    const daysAtCapacity = supply > 0 && emailsNeeded > 0 ? emailsNeeded / supply : null;
    const daysAtCapacityCalendar =
      daysAtCapacity !== null && sendingDayFactor > 0 ? daysAtCapacity / sendingDayFactor : null;

    return {
      id: p.id,
      name: p.name,
      group: p.group,
      instantlyTags: p.instantlyTags,
      active: p.active,
      dailyLimit: p.dailyLimit,
      dailyMaxLeads: p.dailyMaxLeads,
      prioritizeNewLeads: p.prioritizeNewLeads,
      emails: p.emails,
      mailboxCount: p.emails.filter((e) => inUse(boxes.get(e))).length,
      supplyDaily: supply,
      gapDaily: Math.max(0, p.dailyLimit - supply),
      leadsTotal,
      leadsContacted,
      leadsRemaining,
      pctContacted: rate(leadsContacted, leadsTotal),
      leadsCompleted: counts.completed,
      leadsInProgress: counts.inProgress,
      notYetContacted: counts.notYetContacted,
      pctComplete: counts.pctComplete,
      countsSource: counts.source,
      sentLast30: sent,
      // Per SENDING day, so it lines up with supplyDaily rather than being
      // deflated by the weekends nothing goes out on.
      sentPerDay: sendingDayFactor > 0 ? sent / WINDOW_DAYS / sendingDayFactor : 0,

      sequenceSteps: steps,
      sequenceStepsKnown: p.sequenceSteps > 0,
      emailsNeeded,
      daysAtCapacity,
      daysAtCapacityCalendar,
      capacityFinishDate:
        daysAtCapacityCalendar !== null ? addDays(today ?? new Date(), daysAtCapacityCalendar) : null,
      leadsPerDayAtCapacity:
        daysAtCapacity !== null && daysAtCapacity > 0 ? leadsRemaining / daysAtCapacity : null,
      newLeadsPerDay: Number.isFinite(perSendingDay) ? perSendingDay : 0,
      newLeadsPerCalendarDay: Number.isFinite(perCalendarDay) ? perCalendarDay : 0,
      newLeadRateObserved: observedPerCalendarDay > 0,
      daysToFinish,
      finishDate: daysToFinish !== null ? addDays(today ?? new Date(), daysToFinish) : null,
      replyRate: rate(pick(s, F.replies, 0), sent),
      bounceRate: rate(pick(s, F.bounced, 0), sent),
      opportunities: pick(s, F.opps, 0),
      // Scored over the campaign's REAL mailbox list, so an excluded-but-still-
      // attached mailbox can't hide a deliverability problem.
      health: healthOf(
        p.emailsRaw.map((e) => boxes.get(e)).filter((b): b is PlannerMailbox => !!b),
        placement,
      ),
    };
  });

  const mailboxes = Array.from(boxes.values());
  const usable = mailboxes.filter((b) => inUse(b));
  const perBoxCap =
    mode(usable.map((b) => b.dailyLimit)) || Math.max(0, settings.per_mailbox_daily_limit);

  // --- Groups ---------------------------------------------------------------
  const groupMap = new Map<string, PlannerCampaign[]>();
  for (const c of campaigns) {
    const list = groupMap.get(c.group) ?? [];
    list.push(c);
    groupMap.set(c.group, list);
  }

  const groups: PlannerGroup[] = Array.from(groupMap.entries()).map(([key, list]) => {
    const activeList = list.filter((c) => c.active);
    const demandDaily = activeList.reduce((n, c) => n + c.dailyLimit, 0);
    // Sum of member campaigns' fair shares — consistent with per-campaign supply.
    const supplyDaily = activeList.reduce((n, c) => n + c.supplyDaily, 0);
    const emails = new Set<string>();
    for (const c of activeList) for (const e of c.emails) emails.add(e);
    const groupBoxes = Array.from(emails)
      .map((e) => boxes.get(e))
      .filter((b): b is PlannerMailbox => inUse(b));
    const shared = groupBoxes.filter((b) => b.groups.length > 1).length;
    const gap = Math.max(0, demandDaily - supplyDaily);
    const inboxesNeeded = perBoxCap > 0 ? Math.ceil(gap / perBoxCap) : 0;
    const leadsRemaining = activeList.reduce((n, c) => n + c.leadsRemaining, 0);
    const leadRateCalendar = activeList.reduce((n, c) => n + c.newLeadsPerCalendarDay, 0);
    const groupLeadsTotal = activeList.reduce((n, c) => n + c.leadsTotal, 0);
    // "Fully contacted" only if every active campaign's remaining is a REAL zero
    // (Instantly's own not-yet-contacted), never off a partial counter fallback.
    const groupRemainingKnown = activeList.every((c) => c.notYetContacted !== null);
    const groupDaysToFinish =
      leadsRemaining > 0 && leadRateCalendar > 0
        ? leadsRemaining / leadRateCalendar
        : groupRemainingKnown && groupLeadsTotal > 0
          ? 0 // list fully contacted
          : null; // no list to finish
    const groupFinishDate =
      groupDaysToFinish !== null ? addDays(today ?? new Date(), groupDaysToFinish) : null;
    const totalSent = activeList.reduce((n, c) => n + c.leadsContacted, 0);

    return {
      key,
      campaigns: list,
      activeCampaigns: activeList.length,
      demandDaily,
      supplyDaily,
      gapDaily: gap,
      surplusDaily: Math.max(0, supplyDaily - demandDaily),
      mailboxes: groupBoxes.length,
      exclusiveMailboxes: groupBoxes.length - shared,
      sharedMailboxes: shared,
      inboxesNeeded,
      domainsNeeded: Math.ceil(inboxesNeeded / Math.max(1, settings.emails_per_domain)),
      leadsRemaining,
      newLeadsPerDay: activeList.reduce((n, c) => n + c.newLeadsPerDay, 0),
      daysToFinish: groupDaysToFinish,
      finishDate: groupFinishDate,
      health: healthOf(
        Array.from(new Set(activeList.flatMap((c) => c.emails)))
          .map((e) => boxes.get(e))
          .filter((b): b is PlannerMailbox => !!b),
        placement,
      ),
      replyRate:
        totalSent > 0
          ? activeList.reduce((n, c) => n + c.replyRate * c.leadsContacted, 0) / totalSent
          : 0,
    };
  });
  groups.sort((a, b) => b.gapDaily - a.gapDaily || b.demandDaily - a.demandDaily);

  const totalDemand = campaigns.filter((c) => c.active).reduce((n, c) => n + c.dailyLimit, 0);
  const totalSupply = usable.reduce((n, b) => n + b.dailyLimit, 0);
  // Today's realistic capacity: warming mailboxes can't carry their full limit.
  const warmupAdjustedSupply = usable.reduce(
    (n, b) => n + (b.warmingUp ? Math.min(b.dailyLimit, settings.warmup_ramp_per_day * 4) : b.dailyLimit),
    0,
  );

  // --- Goal planner ---------------------------------------------------------
  const sendsPerLead = Math.max(1, settings.default_sends_per_lead);
  const goalKind = settings.planner_goal_kind ?? "emails";
  const goalValue = Math.max(0, settings.planner_goal_value ?? 0);
  // Contacting L new leads/day means L*S emails/day once the pipeline is full,
  // because every lead keeps receiving follow-ups after its first touch.
  const emailsPerDay = goalKind === "emails" ? goalValue : goalValue * sendsPerLead;
  const newLeadsPerDay = goalKind === "leads" ? goalValue : goalValue / sendsPerLead;
  const inboxesRequired = perBoxCap > 0 ? Math.ceil(emailsPerDay / perBoxCap) : 0;
  const inboxesToAdd = Math.max(0, inboxesRequired - usable.length);
  const domainsToAdd = Math.ceil(inboxesToAdd / Math.max(1, settings.emails_per_domain));
  const perDomain = perUnitMonthly(costs, "Domains");
  const perMailbox = perUnitMonthly(costs, "Email Infrastructure");
  const monthlyCostAdd =
    perDomain === null && perMailbox === null
      ? null
      : domainsToAdd * (perDomain ?? 0) + inboxesToAdd * (perMailbox ?? 0);
  const providerDailies = cap.sources
    .filter((s) => s.kind === "sending" && s.daily > 0)
    .map((s) => s.daily);
  const providerCeiling = providerDailies.length > 0 ? Math.min(...providerDailies) : Infinity;

  const goal: GoalResult = {
    kind: goalKind,
    value: goalValue,
    emailsPerDay,
    newLeadsPerDay,
    inboxesRequired,
    inboxesToAdd,
    domainsToAdd,
    monthlyCostAdd,
    daysToReady:
      settings.warmup_ramp_per_day > 0
        ? Math.ceil(settings.warmup_target / settings.warmup_ramp_per_day)
        : 0,
    providerCeiling: Number.isFinite(providerCeiling) ? providerCeiling : 0,
    providerOk: emailsPerDay <= providerCeiling,
  };

  // --- Ranked actions -------------------------------------------------------
  const actions: PlannerAction[] = [];
  for (const g of groups) {
    if (g.gapDaily > 0 && g.activeCampaigns > 0) {
      actions.push({
        severity: "high",
        title: `${g.key}: short ${Math.round(g.gapDaily)} emails/day`,
        detail: `${g.activeCampaigns} campaign(s) allow ${Math.round(g.demandDaily)}/day but ${g.mailboxes} mailbox(es) only supply ${Math.round(g.supplyDaily)}/day. Add ${g.inboxesNeeded} inbox(es) (~${g.domainsNeeded} domain(s)).`,
      });
    }
  }
  const idleMailboxes = mailboxes.filter((b) => b.idle);
  if (idleMailboxes.length > 0) {
    actions.push({
      severity: "medium",
      title: `${idleMailboxes.length} mailbox(es) attached to no active campaign`,
      detail: `You're paying for ${idleMailboxes.length} connected inbox(es) sending nothing — worth ${Math.round(idleMailboxes.reduce((n, b) => n + b.dailyLimit, 0))} emails/day. Attach them to a campaign or exclude them.`,
    });
  }
  for (const c of campaigns) {
    if (!c.active) continue;
    if (c.daysToFinish !== null && c.daysToFinish > 0 && c.daysToFinish < RUNWAY_WARN_DAYS) {
      actions.push({
        severity: "high",
        title: `${c.name}: ${Math.round(c.daysToFinish)} days of leads left`,
        detail: `${Math.round(c.leadsRemaining)} uncontacted leads at ~${Math.round(c.newLeadsPerDay)}/day. Import more before it stalls.`,
      });
    }
    if (c.bounceRate > BOUNCE_WARN_PCT) {
      actions.push({
        severity: "high",
        title: `${c.name}: ${c.bounceRate.toFixed(1)}% bounce rate`,
        detail: "Above the 3% danger line — pause and clean the list before it hurts domain reputation.",
      });
    }
  }
  for (const g of groups) {
    const modes = new Set(
      g.campaigns.filter((c) => c.active && c.prioritizeNewLeads !== null).map((c) => c.prioritizeNewLeads),
    );
    if (modes.size > 1) {
      actions.push({
        severity: "low",
        title: `${g.key}: mixed send priority`,
        detail: "Some campaigns prioritise new leads and others follow-ups. Inconsistent priority makes group volume unpredictable.",
      });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  actions.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    // Without email_list there is no campaign -> mailbox linkage to plan from.
    linkageAvailable: sawEmailList,
    groups,
    campaigns,
    mailboxes,
    idleMailboxes,
    excludedCount: excluded.size,
    usableInboxes: usable.length,
    connectedInboxes: candidates.length,
    attachedInboxes,
    beyondCountInboxes: candidates.filter((b) => b.beyondCount).length,
    activeInboxCount,
    perBoxCap,
    totalDemand,
    totalSupply,
    totalGap: totalDemand - totalSupply,
    warmupAdjustedSupply,
    truncated: accountsTruncated || campaignsTruncated,
    health: healthOf(usable, placement),
    goal,
    actions,
  };
}
