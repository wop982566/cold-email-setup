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
import { asItems, pick } from "./instantly";

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
  campaignIds: string[];
  groups: string[];
  shareCount: number; // active campaigns sharing this mailbox
  idle: boolean; // connected but attached to no active campaign
  // Dropped because it falls outside the "inboxes I'm actually using" count,
  // rather than being excluded by hand.
  beyondCount: boolean;
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
  leadsRemaining: number;
  pctContacted: number;
  newLeadsPerDay: number; // per SENDING day — what the operator recognises
  newLeadsPerCalendarDay: number; // per calendar day — drives the ETA
  newLeadRateObserved: boolean; // false = derived from config, not real sends
  daysToFinish: number | null; // calendar days until every lead is contacted
  finishDate: string | null; // YYYY-MM-DD projection
  replyRate: number;
  bounceRate: number;
  opportunities: number;
}

export interface PlannerGroup {
  key: string;
  campaigns: PlannerCampaign[];
  activeCampaigns: number;
  demandDaily: number;
  supplyDaily: number;
  gapDaily: number;
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

// "AEO - US SaaS" -> "AEO". Splits on the separators operators actually use in
// campaign names, then falls back to the whole name.
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
function perUnitMonthly(costs: CostItem[], category: string): number | null {
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
    const score = pick(a, F.warmupScore, 0);
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
      groups: [],
      shareCount: 0,
      idle: false,
      beyondCount: false,
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
    const emails = list
      .map((e) => String(e ?? "").trim().toLowerCase())
      .filter((e) => e && !excluded.has(e));
    const active = isActiveCampaign(c);
    const lim = limitOf(c, F.campDailyLimit);
    const maxLeads = limitOf(c, F.campMaxLeads);
    return {
      id,
      name,
      group: overrides[id] || groupFromName(name),
      active,
      dailyLimit: lim === MISSING ? 0 : lim,
      dailyMaxLeads: maxLeads === MISSING ? 0 : maxLeads,
      prioritizeNewLeads:
        typeof c.prioritize_new_leads === "boolean" ? c.prioritize_new_leads : null,
      emails,
      raw: c,
    };
  });

  // Attribute mailboxes to campaigns, counting how many ACTIVE campaigns share
  // each one — this is what makes the fair-share split possible.
  for (const p of parsed) {
    if (!p.active) continue;
    for (const email of p.emails) {
      const box = boxes.get(email);
      if (!inUse(box)) continue;
      box.campaignIds.push(p.id);
      if (!box.groups.includes(p.group)) box.groups.push(p.group);
      box.shareCount++;
    }
  }
  for (const box of boxes.values()) {
    box.idle = inUse(box) && box.shareCount === 0;
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
    const leadsTotal = pick(s, F.leadsTotal, 0);
    const leadsContacted = pick(s, F.contacted, 0);
    const leadsRemaining = Math.max(0, leadsTotal - leadsContacted);
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
    const daysToFinish =
      perCalendarDay > 0 && Number.isFinite(perCalendarDay) && leadsRemaining > 0
        ? leadsRemaining / perCalendarDay
        : leadsRemaining === 0 && leadsTotal > 0
          ? 0 // whole list already contacted
          : null;

    return {
      id: p.id,
      name: p.name,
      group: p.group,
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
      newLeadsPerDay: Number.isFinite(perSendingDay) ? perSendingDay : 0,
      newLeadsPerCalendarDay: Number.isFinite(perCalendarDay) ? perCalendarDay : 0,
      newLeadRateObserved: observedPerCalendarDay > 0,
      daysToFinish,
      finishDate: daysToFinish !== null ? addDays(today ?? new Date(), daysToFinish) : null,
      replyRate: rate(pick(s, F.replies, 0), sent),
      bounceRate: rate(pick(s, F.bounced, 0), sent),
      opportunities: pick(s, F.opps, 0),
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
    const groupDaysToFinish =
      leadsRemaining > 0 && leadRateCalendar > 0
        ? leadsRemaining / leadRateCalendar
        : groupLeadsTotal > 0
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
      mailboxes: groupBoxes.length,
      exclusiveMailboxes: groupBoxes.length - shared,
      sharedMailboxes: shared,
      inboxesNeeded,
      domainsNeeded: Math.ceil(inboxesNeeded / Math.max(1, settings.emails_per_domain)),
      leadsRemaining,
      newLeadsPerDay: activeList.reduce((n, c) => n + c.newLeadsPerDay, 0),
      daysToFinish: groupDaysToFinish,
      finishDate: groupFinishDate,
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
    goal,
    actions,
  };
}
