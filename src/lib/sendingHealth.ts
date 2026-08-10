// ---------------------------------------------------------------------------
// Sending health: planned capacity vs what Instantly is ACTUALLY sending.
// Three quantities decide whether an operation is healthy:
//   1. Inbox capacity  = Σ daily_limit over active Instantly mailboxes (supply)
//   2. Campaign limits = Σ daily_limit over active Instantly campaigns (demand)
//   3. Actual sends    = the per-day series from campaign analytics
// The ceiling is the min of those plus the provider caps (SES, plan). From the
// gap we derive whether you're exceeding, underutilising, and how many more
// inboxes would be needed to cover the campaign limits you've configured.
//
// Pure module — the component does the fetching and hands over raw payloads.
// ---------------------------------------------------------------------------
import { AppSettings } from "./types";
import { CapacityResult } from "./capacity";
import { asItems, pick } from "./instantly";
import { attachedEmails, rankAndTrim } from "./campaignPlan";

// Instantly's payloads vary by workspace and endpoint version, so every read
// goes through a candidate list (same approach as the Instantly page).
const F = {
  // GET /accounts
  acctDailyLimit: ["daily_limit", "daily_sending_limit", "sending_limit", "max_daily_limit"],
  // GET /campaigns
  campDailyLimit: ["daily_limit", "campaign_daily_limit"],
  // GET /campaigns/analytics/daily
  daySent: ["sent", "emails_sent_count", "sent_count", "emails_sent", "total_sent"],
};
const DATE_KEYS = ["date", "day", "dt", "start_date", "timestamp"];

// NOTE: campaigns also expose `daily_max_leads` — that's NEW LEADS per day, a
// different unit from `daily_limit` (emails per day). Never sum the two.

const HEALTHY_MIN_PCT = 70; // at/above this you're using what you pay for
const OVER_TOLERANCE = 1.02; // 2% slack before we call it "exceeding"
const MISSING = -1; // pick() returns 0 for absent keys, so limits need a sentinel
const PAGE_CAP = 100; // the proxy hard-caps /accounts and /campaigns at 100

export interface DayPoint {
  date: string; // YYYY-MM-DD (UTC)
  sent: number;
  isToday: boolean; // today's bucket is partial — excluded from every verdict
}

export interface SendingHealth {
  // Supply — what the mailboxes can carry, live from Instantly
  liveMailboxes: number;
  liveMailboxDaily: number;
  perMailboxLive: number; // mean, for display
  perMailboxMode: number; // most common limit — drives the recommendation
  perMailboxPlanned: number;
  plannedMailboxDaily: number;
  mailboxesMissingLimit: number;
  mailboxesZeroLimit: number;
  accountsTruncated: boolean;

  // Demand — what the campaigns are configured to send
  activeCampaigns: number;
  campaignDailyLimit: number;
  campaignsWithoutLimit: number;
  campaignLimitKnown: boolean; // false => demand is effectively unbounded
  campaignsTruncated: boolean;

  // Actuals
  days: DayPoint[]; // gap-filled, ascending, includes today (for the chart)
  sentLast7: number;
  sentLast30: number;
  avgPerSendingDay: number; // headline: ignores idle days
  avgPerCalendarDay: number;
  perMailboxActual: number;
  sendingDaysObserved: number;
  peakDay: DayPoint | null;
  skippedRows: number;

  // Verdict
  ceilingDaily: number;
  bottleneck: string;
  utilizationPct: number;
  status: "over" | "healthy" | "under" | "idle";
  overBy: number;
  underBy: number;

  // Recommendation
  inboxesNeeded: number;
  domainsNeeded: number;
  spareDaily: number;
  // Signed: how many more (+) or fewer (−) emails/day of inbox capacity are
  // needed to match what the campaigns are configured to send.
  emailDelta: number;
  excludedMailboxes: number;
  weeklyCapacity: number;
  weeklyActual: number;
  weeklyUtilizationPct: number;

  // Drift between the app's model and Instantly's live config
  perMailboxDrift: number; // signed: live − planned
  mailboxCountDrift: number; // signed: live − planned
  hasDrift: boolean;

  hasLiveData: boolean;
}

export interface SendingHealthInput {
  accountsData: unknown;
  campaignsData: unknown;
  dailyData: unknown;
  cap: CapacityResult;
  settings: AppSettings;
  days?: number;
  today?: Date; // injected so the maths stay deterministic
}

type Obj = Record<string, unknown>;

// pick() is numeric-only, so dates need their own tolerant getter.
function pickDate(o: Obj, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      // Epoch seconds vs milliseconds.
      const ms = v < 1e11 ? v * 1000 : v;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return isoDay(d);
    }
    if (typeof v === "string" && v.trim() !== "") {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return isoDay(d);
    }
  }
  return null;
}

// A limit field that is genuinely absent must not read as 0 — 0 means "sending
// is switched off for this box", which is a different fact.
function limitOf(o: Obj, keys: string[]): number {
  const v = pick(o, keys, MISSING);
  if (!Number.isFinite(v)) return MISSING;
  if (v === MISSING) return MISSING;
  return Math.max(0, v);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  return isoDay(new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000));
}

// Most common value; ties resolve to the largest.
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

export function computeSendingHealth({
  accountsData,
  campaignsData,
  dailyData,
  cap,
  settings,
  days: windowDays = 30,
  today,
}: SendingHealthInput): SendingHealth {
  // --- A. Accounts -> supply ------------------------------------------------
  const rawAccounts = asItems<Obj>(accountsData);
  const accountsTruncated = rawAccounts.length >= PAGE_CAP;

  const seen = new Set<string>();
  const accounts: Obj[] = [];
  for (const a of rawAccounts) {
    const key = String(a.email ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    accounts.push(a);
  }

  // Mailboxes the operator has explicitly excluded (warmup-only, parked,
  // client-owned) must not count towards capacity anywhere in the planner.
  const excluded = new Set(
    (settings.excluded_mailboxes ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean),
  );

  // "setup_pending" mailboxes are connected but not sending yet — counting them
  // would inflate supply.
  const active = accounts.filter(
    (a) =>
      (Number(a.status) === 1 || a.status === "active") &&
      a.setup_pending !== true &&
      !excluded.has(String(a.email ?? "").trim().toLowerCase()),
  );

  // Resolve each mailbox's effective limit first, so the "inboxes I'm actually
  // using" count can rank by it.
  let mailboxesMissingLimit = 0;
  let mailboxesZeroLimit = 0;
  const resolved = active.map((a) => {
    const lim = limitOf(a, F.acctDailyLimit);
    if (lim === MISSING) mailboxesMissingLimit++;
    else if (lim === 0) mailboxesZeroLimit++;
    return {
      email: String(a.email ?? "").trim().toLowerCase(),
      dailyLimit: lim === MISSING ? Math.max(0, settings.per_mailbox_daily_limit) : lim,
    };
  });

  // Same trimming rule as the planner, so the Dashboard card and the planner
  // can never disagree on how many inboxes are in play.
  const keep = rankAndTrim(
    resolved,
    attachedEmails(campaignsData),
    Math.max(0, Math.floor(settings.planner_active_inbox_count ?? 0)),
  );
  const counted = resolved.filter((r) => keep.has(r.email));

  let liveMailboxDaily = 0;
  const perBoxLimits: number[] = [];
  for (const r of counted) {
    liveMailboxDaily += r.dailyLimit;
    perBoxLimits.push(r.dailyLimit);
  }

  const liveMailboxes = counted.length;
  const perMailboxLive = liveMailboxes > 0 ? liveMailboxDaily / liveMailboxes : 0;
  // Mode, not mean: one paused box at 0 would drag the mean down and fabricate
  // a deficit that doesn't exist.
  const perMailboxMode = liveMailboxes > 0 ? mode(perBoxLimits) : 0;

  // --- B. Campaigns -> demand ----------------------------------------------
  const rawCampaigns = asItems<Obj>(campaignsData);
  const campaignsTruncated = rawCampaigns.length >= PAGE_CAP;
  // Instantly status: 0 draft, 1 active, 2 paused, 3 completed,
  // 4 running subsequences, negative = suspended/unhealthy. 1 and 4 both send.
  const activeCamps = rawCampaigns.filter((c) => Number(c.status) === 1 || Number(c.status) === 4);

  let campaignDailyLimit = 0;
  let campaignsWithoutLimit = 0;
  for (const c of activeCamps) {
    const lim = limitOf(c, F.campDailyLimit);
    if (lim === MISSING || lim === 0) campaignsWithoutLimit++;
    else campaignDailyLimit += lim;
  }
  // A campaign with no limit set is unbounded, so total demand isn't a finite
  // number and must not be used as a ceiling or sized against.
  const campaignLimitKnown = campaignsWithoutLimit === 0 && campaignDailyLimit > 0;

  // --- C. Daily series -> actuals ------------------------------------------
  const rows = asItems<Obj>(dailyData);
  const byDate = new Map<string, number>();
  let skippedRows = 0;
  for (const r of rows) {
    const d = pickDate(r, DATE_KEYS);
    if (!d) {
      skippedRows++;
      continue;
    }
    // Accumulate, never assign: without a campaign filter some workspaces
    // return one row per campaign per day.
    byDate.set(d, (byDate.get(d) ?? 0) + pick(r, F.daySent));
  }

  // Gap-fill a real calendar window (UTC, matching daysParams) so "last 7 days"
  // means 7 days rather than "7 rows Instantly happened to return".
  const todayIso = isoDay(today ?? new Date());
  const days: DayPoint[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const date = addDays(todayIso, -i);
    days.push({ date, sent: byDate.get(date) ?? 0, isToday: date === todayIso });
  }

  // Today is still in flight; including it would report a false "underutilising"
  // verdict every morning.
  const complete = days.filter((d) => !d.isToday);
  const sentLast30 = complete.reduce((n, d) => n + d.sent, 0);
  const sentLast7 = complete.slice(-7).reduce((n, d) => n + d.sent, 0);
  const sendingDaysObserved = complete.filter((d) => d.sent > 0).length;
  const avgPerSendingDay = sendingDaysObserved > 0 ? sentLast30 / sendingDaysObserved : 0;
  const avgPerCalendarDay = complete.length > 0 ? sentLast30 / complete.length : 0;
  const perMailboxActual = liveMailboxes > 0 ? avgPerSendingDay / liveMailboxes : 0;
  const peakDay = complete.reduce<DayPoint | null>(
    (best, d) => (best === null || d.sent > best.sent ? d : best),
    null,
  );

  // --- D. Ceiling and verdict ----------------------------------------------
  // Provider caps come from the already period-normalised capacity sources.
  // We deliberately do NOT fold in cap.effectiveDaily: it already contains the
  // app's *planned* mailbox model, which would double-count the mailbox term
  // and let a stale plan override the live Instantly numbers.
  const candidates: { label: string; value: number }[] = [];
  if (liveMailboxes > 0) {
    candidates.push({ label: "Mailbox limits (Instantly)", value: liveMailboxDaily });
  }
  if (campaignLimitKnown) {
    candidates.push({ label: "Campaign daily limits", value: campaignDailyLimit });
  }
  for (const s of cap.sources) {
    if (s.kind === "sending" && s.daily > 0) candidates.push({ label: s.name, value: s.daily });
  }
  if (candidates.length === 0) {
    candidates.push({ label: cap.bottleneck, value: cap.effectiveDaily });
  }

  const tightest = candidates.reduce((min, c) => (c.value < min.value ? c : min));
  const ceilingDaily = Math.floor(tightest.value);
  const bottleneck = tightest.label;

  const utilizationPct = ceilingDaily > 0 ? (avgPerSendingDay / ceilingDaily) * 100 : 0;

  let status: SendingHealth["status"];
  if (sendingDaysObserved === 0) {
    status = "idle";
  } else if (
    avgPerSendingDay > ceilingDaily * OVER_TOLERANCE ||
    // The peak clause catches what an average hides: one blast at 2x the cap
    // averaged down by four quiet days.
    (peakDay !== null && peakDay.sent > ceilingDaily && ceilingDaily > 0)
  ) {
    status = "over";
  } else if (utilizationPct >= HEALTHY_MIN_PCT) {
    status = "healthy";
  } else {
    status = "under";
  }

  const overBy = Math.max(0, Math.round(avgPerSendingDay - ceilingDaily));
  const underBy = Math.max(0, Math.round(ceilingDaily - avgPerSendingDay));

  // --- E. Recommendation ----------------------------------------------------
  const perBoxCap = perMailboxMode > 0 ? perMailboxMode : Math.max(0, settings.per_mailbox_daily_limit);
  // Deficit form, not ceil(total / perBox) − current: the latter credits
  // capacity that heterogeneous or paused mailboxes don't actually provide.
  const deficit = campaignLimitKnown ? Math.max(0, campaignDailyLimit - liveMailboxDaily) : 0;
  const inboxesNeeded = perBoxCap > 0 ? Math.ceil(deficit / perBoxCap) : 0;
  const domainsNeeded = Math.ceil(inboxesNeeded / Math.max(1, settings.emails_per_domain));
  const spareDaily = campaignLimitKnown ? Math.max(0, liveMailboxDaily - campaignDailyLimit) : 0;

  const weeklyCapacity = ceilingDaily * Math.max(0, settings.sending_days_per_week);
  const weeklyActual = sentLast7;
  const weeklyUtilizationPct = weeklyCapacity > 0 ? (weeklyActual / weeklyCapacity) * 100 : 0;

  // --- F. Drift -------------------------------------------------------------
  const perMailboxDrift = liveMailboxes > 0 ? perMailboxMode - settings.per_mailbox_daily_limit : 0;
  const mailboxCountDrift = liveMailboxes > 0 ? liveMailboxes - cap.activeMailboxes : 0;
  const hasDrift =
    liveMailboxes > 0 && (Math.abs(perMailboxDrift) >= 1 || Math.abs(mailboxCountDrift) >= 1);

  return {
    liveMailboxes,
    liveMailboxDaily,
    perMailboxLive,
    perMailboxMode,
    perMailboxPlanned: settings.per_mailbox_daily_limit,
    plannedMailboxDaily: cap.mailboxDaily,
    mailboxesMissingLimit,
    mailboxesZeroLimit,
    accountsTruncated,

    activeCampaigns: activeCamps.length,
    campaignDailyLimit,
    campaignsWithoutLimit,
    campaignLimitKnown,
    campaignsTruncated,

    days,
    sentLast7,
    sentLast30,
    avgPerSendingDay,
    avgPerCalendarDay,
    perMailboxActual,
    sendingDaysObserved,
    peakDay,
    skippedRows,

    ceilingDaily,
    bottleneck,
    utilizationPct,
    status,
    overBy,
    underBy,

    inboxesNeeded,
    domainsNeeded,
    spareDaily,
    emailDelta: campaignLimitKnown ? campaignDailyLimit - liveMailboxDaily : 0,
    excludedMailboxes: excluded.size,
    weeklyCapacity,
    weeklyActual,
    weeklyUtilizationPct,

    perMailboxDrift,
    mailboxCountDrift,
    hasDrift,

    hasLiveData: accounts.length > 0 || rows.length > 0,
  };
}
