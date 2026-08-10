// ---------------------------------------------------------------------------
// Sending-capacity math. The real-world ceiling on a cold-email operation is
// the MINIMUM of three things:
//   1. Mailbox capacity  = (# sending mailboxes) × (safe sends per mailbox/day)
//   2. Mail server cap    = e.g. Amazon SES 50,000 / 24h
//   3. Sending-tool cap   = e.g. Instantly 125,000 / month
// We normalise everything to per-day and per-month and surface the bottleneck.
// ---------------------------------------------------------------------------
import { AppSettings, CapacitySource, Domain } from "./types";

const DAYS_PER_MONTH = 30.44;

export interface CapacityResult {
  mailboxes: number;
  activeMailboxes: number; // mailboxes connected to Instantly + warmed
  perMailboxDaily: number;
  mailboxDaily: number; // mailbox-based daily ceiling
  sendingDaysPerMonth: number;
  effectiveDaily: number;
  effectiveMonthly: number;
  bottleneck: string;
  perMailboxMonthly: number;
  sources: NormalizedSource[];
  // utilisation, only meaningful if a source has used_amount set
  monthlyUsed: number;
  monthlyUsedPct: number;
}

export interface NormalizedSource {
  id: string;
  name: string;
  color: string;
  kind: "sending" | "contacts";
  period: "day" | "week" | "month";
  limit: number;
  daily: number; // normalized to a day (sending sources only)
  monthly: number; // normalized to a month
  used: number;
  usedPct: number;
  notes: string;
}

export function countMailboxes(domains: Domain[]): number {
  let count = 0;
  for (const d of domains) {
    if (d.email_1?.trim()) count++;
    if (d.email_2?.trim()) count++;
  }
  return count;
}

function connectionFactor(d: Domain): number {
  if (d.connected_to_instantly === "Yes") return 1;
  if (d.connected_to_instantly === "Partially") return 0.5;
  return 0;
}

export function countActiveMailboxes(domains: Domain[]): number {
  // A mailbox counts as "active" when its domain is connected to Instantly.
  let count = 0;
  for (const d of domains) {
    const boxes = (d.email_1?.trim() ? 1 : 0) + (d.email_2?.trim() ? 1 : 0);
    count += boxes * connectionFactor(d);
  }
  return Math.round(count);
}

// Daily mailbox-based ceiling, honouring per-domain per-mailbox overrides.
export function mailboxDailyCeiling(domains: Domain[], settings: AppSettings): number {
  let total = 0;
  for (const d of domains) {
    const boxes = (d.email_1?.trim() ? 1 : 0) + (d.email_2?.trim() ? 1 : 0);
    const perBox =
      d.mailbox_daily_limit != null && d.mailbox_daily_limit > 0
        ? d.mailbox_daily_limit
        : settings.per_mailbox_daily_limit;
    total += boxes * connectionFactor(d) * perBox;
  }
  return total;
}

function toDaily(amount: number, period: "day" | "week" | "month"): number {
  if (period === "day") return amount;
  if (period === "week") return amount / 7;
  return amount / DAYS_PER_MONTH;
}

function toMonthly(amount: number, period: "day" | "week" | "month"): number {
  if (period === "day") return amount * DAYS_PER_MONTH;
  if (period === "week") return (amount / 7) * DAYS_PER_MONTH;
  return amount;
}

export function computeCapacity(
  domains: Domain[],
  sources: CapacitySource[],
  settings: AppSettings,
): CapacityResult {
  const mailboxes = countMailboxes(domains);
  const activeMailboxes = countActiveMailboxes(domains);
  const perMailboxDaily = Math.max(0, settings.per_mailbox_daily_limit);
  const sendingDaysPerMonth = (settings.sending_days_per_week / 7) * DAYS_PER_MONTH;

  // Honours per-domain overrides; falls back to the global per-mailbox limit.
  const mailboxDaily = mailboxDailyCeiling(domains, settings);

  const normalized: NormalizedSource[] = sources
    .filter((s) => s.enabled)
    .map((s) => {
      const daily = s.kind === "sending" ? toDaily(s.limit_amount, s.limit_period) : 0;
      const monthly = toMonthly(s.limit_amount, s.limit_period);
      const usedPct = s.limit_amount > 0 ? (s.used_amount / s.limit_amount) * 100 : 0;
      return {
        id: s.id,
        name: s.name,
        color: s.color,
        kind: s.kind,
        period: s.limit_period,
        limit: s.limit_amount,
        daily,
        monthly,
        used: s.used_amount,
        usedPct,
        notes: s.notes,
      };
    });

  // Candidate daily ceilings: mailbox-based + every sending source.
  const sendingSources = normalized.filter((s) => s.kind === "sending");
  const dailyCandidates: { label: string; value: number }[] = [
    { label: "Mailbox capacity", value: mailboxDaily },
    ...sendingSources.map((s) => ({ label: s.name, value: s.daily })),
  ];

  const effectiveDailyEntry = dailyCandidates.reduce((min, c) =>
    c.value < min.value ? c : min,
  );
  const effectiveDaily = Math.floor(effectiveDailyEntry.value);

  // Monthly ceiling = min(monthly caps, effectiveDaily * sendingDays).
  const monthlyCandidates: number[] = [
    effectiveDaily * sendingDaysPerMonth,
    ...sendingSources.map((s) => s.monthly),
  ];
  const effectiveMonthly = Math.floor(Math.min(...monthlyCandidates));

  // Monthly usage from the tightest sending source that has usage recorded.
  const usedSource = sendingSources.find((s) => s.used > 0);
  const monthlyUsed = usedSource?.used ?? 0;
  const monthlyUsedPct =
    effectiveMonthly > 0 ? Math.min(100, (monthlyUsed / effectiveMonthly) * 100) : 0;

  return {
    mailboxes,
    activeMailboxes,
    perMailboxDaily,
    mailboxDaily,
    sendingDaysPerMonth,
    effectiveDaily,
    effectiveMonthly,
    bottleneck: effectiveDailyEntry.label,
    perMailboxMonthly: perMailboxDaily * sendingDaysPerMonth,
    sources: normalized,
    monthlyUsed,
    monthlyUsedPct,
  };
}

// A simple warmup ramp: starting low and increasing per day to the target.
export function warmupRamp(settings: AppSettings, days = 30): number[] {
  const out: number[] = [];
  let current = settings.warmup_ramp_per_day;
  for (let i = 0; i < days; i++) {
    out.push(Math.min(current, settings.warmup_target));
    current += settings.warmup_ramp_per_day;
  }
  return out;
}
