// ---------------------------------------------------------------------------
// Why the mailboxes aren't full.
//
// Sending health reports the gap between capacity and actual volume. This
// answers the follow-up: a mailbox only sends what a campaign hands it, so a
// workspace at 29% usually has a lead problem, not an inbox problem.
//
// The estimate is deliberately simple and stated openly rather than dressed up:
//
//     steady-state emails/day  ≈  new leads/day  ×  emails per lead
//
// Add 45 leads a day to a 3-step sequence and, once the follow-ups stack up,
// you land near 135 emails/day — no matter how much inbox capacity you own.
// `emails per lead` is a configured assumption (`default_sends_per_lead`), not
// a measurement, so `confidence` reports how much of the input was observed
// and the UI shows the arithmetic.
//
// The point of all this is one recommendation: never tell someone to buy
// inboxes when the inboxes they already have are idle.
//
// Pure module — the card fetches and renders, this decides.
// ---------------------------------------------------------------------------
import { AppSettings } from "./types";
import { Plan, PlannerCampaign } from "./campaignPlan";
import { SendingHealth } from "./sendingHealth";

export type Binding = "leads" | "mailboxes" | "campaign limits" | "unknown";

export type ReasonCode =
  | "no_active_campaigns"
  | "out_of_leads"
  | "new_lead_throttle"
  | "finishing_soon"
  | "idle_mailboxes";

export interface SupplyReason {
  code: ReasonCode;
  severity: "high" | "medium";
  headline: string;
  detail: string;
  campaigns: { id: string; name: string }[];
}

export interface SupplyDiagnosis {
  binding: Binding;
  /** Steady-state emails/day the current lead intake supports. null = unknown. */
  leadCeilingDaily: number | null;
  newLeadsDaily: number;
  sendsPerLead: number;
  /** How much of newLeadsDaily came from real sends rather than config. */
  confidence: "observed" | "mixed" | "configured" | "none";
  /** Extra new leads/day needed to fill the inboxes already owned. */
  leadsNeededDaily: number;
  reasons: SupplyReason[];
  summary: string;
  /** True when recommending more inboxes would be wrong. */
  suppressInboxAdvice: boolean;
  /** Set when the estimate and observed volume disagree badly. */
  estimateWarning: string | null;
}

/** Below this share of mailbox capacity, lead intake is the real constraint. */
const THROTTLE_RATIO = 0.8;
const FINISHING_SOON_DAYS = 7;
/** Observed volume this far from the estimate means the model doesn't fit. */
const ESTIMATE_TOLERANCE = 2;

function names(cs: PlannerCampaign[]) {
  return cs.map((c) => ({ id: c.id, name: c.name }));
}

function list(cs: PlannerCampaign[], max = 3): string {
  const shown = cs.slice(0, max).map((c) => c.name);
  const extra = cs.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} and ${extra} more` : shown.join(", ");
}

function round(n: number): number {
  return Math.round(n);
}

export function diagnoseSupply({
  plan,
  health,
  settings,
}: {
  plan: Plan;
  health: SendingHealth;
  settings: AppSettings;
}): SupplyDiagnosis {
  const active = plan.campaigns.filter((c) => c.active);
  const sendsPerLead = Math.max(1, settings.default_sends_per_lead || 1);
  const mailboxCapacity = health.liveMailboxDaily;

  const reasons: SupplyReason[] = [];

  // --- No campaigns at all -------------------------------------------------
  if (active.length === 0) {
    reasons.push({
      code: "no_active_campaigns",
      severity: "high",
      headline: "No active campaigns",
      detail:
        "Every campaign is paused, draft or complete, so nothing is asking the mailboxes to send. Capacity is irrelevant until one is running.",
      campaigns: [],
    });
    return {
      binding: "unknown",
      leadCeilingDaily: 0,
      newLeadsDaily: 0,
      sendsPerLead,
      confidence: "none",
      leadsNeededDaily: 0,
      reasons,
      summary: "Nothing is sending because no campaign is active.",
      suppressInboxAdvice: true,
      estimateWarning: null,
    };
  }

  // --- Lead intake ---------------------------------------------------------
  const newLeadsDaily = active.reduce((n, c) => n + c.newLeadsPerDay, 0);
  const observed = active.filter((c) => c.newLeadRateObserved).length;
  const confidence: SupplyDiagnosis["confidence"] =
    observed === 0 ? "configured" : observed === active.length ? "observed" : "mixed";

  const outOfLeads = active.filter((c) => c.leadsTotal > 0 && c.leadsRemaining <= 0);
  const withLeadsLeft = active.filter((c) => c.leadsRemaining > 0);

  // A zero intake rate means two very different things. If campaigns still hold
  // uncontacted leads, we simply have no rate to work from and must say so
  // rather than publishing a ceiling of zero.
  const rateUnknown = newLeadsDaily <= 0 && withLeadsLeft.length > 0;
  const leadCeilingDaily = rateUnknown ? null : round(newLeadsDaily * sendsPerLead);

  // --- Binding constraint --------------------------------------------------
  const candidates: { label: Binding; value: number }[] = [];
  if (mailboxCapacity > 0) candidates.push({ label: "mailboxes", value: mailboxCapacity });
  if (health.campaignLimitKnown && health.campaignDailyLimit > 0) {
    candidates.push({ label: "campaign limits", value: health.campaignDailyLimit });
  }
  if (leadCeilingDaily !== null) candidates.push({ label: "leads", value: leadCeilingDaily });

  const tightest =
    candidates.length > 0 ? candidates.reduce((min, c) => (c.value < min.value ? c : min)) : null;
  const binding: Binding = tightest?.label ?? "unknown";

  // --- Reasons, worst first ------------------------------------------------
  if (outOfLeads.length > 0) {
    reasons.push({
      code: "out_of_leads",
      severity: "high",
      headline: `${outOfLeads.length} campaign${outOfLeads.length === 1 ? "" : "s"} out of leads`,
      detail: `${list(outOfLeads)} — every lead has been contacted. ${
        outOfLeads.length === 1 ? "It" : "They"
      } can only send remaining follow-ups, then go quiet. Load more leads or the volume disappears.`,
      campaigns: names(outOfLeads),
    });
  }

  if (leadCeilingDaily !== null && mailboxCapacity > 0 && leadCeilingDaily < mailboxCapacity * THROTTLE_RATIO) {
    reasons.push({
      code: "new_lead_throttle",
      severity: "high",
      headline: `Lead intake supports about ${leadCeilingDaily}/day, not ${round(mailboxCapacity)}`,
      detail: `You're introducing ${round(newLeadsDaily)} new leads a day across ${active.length} active campaign${
        active.length === 1 ? "" : "s"
      }. At ${sendsPerLead} emails per lead that sustains roughly ${leadCeilingDaily} emails/day. The inboxes aren't the limit — the lead list is.`,
      campaigns: [],
    });
  }

  const finishingSoon = active.filter(
    (c) => c.daysToFinish !== null && c.daysToFinish > 0 && c.daysToFinish <= FINISHING_SOON_DAYS,
  );
  if (finishingSoon.length > 0) {
    reasons.push({
      code: "finishing_soon",
      severity: "medium",
      headline: `${finishingSoon.length} campaign${finishingSoon.length === 1 ? "" : "s"} finishing within ${FINISHING_SOON_DAYS} days`,
      detail: `${list(finishingSoon)} will contact the last of their leads shortly. Volume drops when they do, so queue replacements now rather than after the cliff.`,
      campaigns: names(finishingSoon),
    });
  }

  const idle = plan.mailboxes.filter((b) => b.idle || b.pausedOnly);
  if (idle.length > 0) {
    const idleDaily = idle.reduce((n, b) => n + b.dailyLimit, 0);
    reasons.push({
      code: "idle_mailboxes",
      severity: "medium",
      headline: `${idle.length} inbox${idle.length === 1 ? "" : "es"} attached to nothing live`,
      detail: `That's ${round(idleDaily)} emails/day of capacity you're paying for and not using. Attach them to a running campaign or exclude them so they stop inflating your ceiling.`,
      campaigns: [],
    });
  }

  // --- Sanity-check the estimate against reality ---------------------------
  // If the model is badly wrong, say so instead of quietly presenting it.
  let estimateWarning: string | null = null;
  const actual = health.avgPerSendingDayRecent || health.avgPerSendingDay;
  if (leadCeilingDaily !== null && leadCeilingDaily > 0 && actual > 0) {
    const ratio = actual / leadCeilingDaily;
    if (ratio > ESTIMATE_TOLERANCE || ratio < 1 / ESTIMATE_TOLERANCE) {
      estimateWarning = `This estimate (${leadCeilingDaily}/day) is a long way from what you're actually sending (${round(
        actual,
      )}/day). Your sequences probably don't average ${sendsPerLead} emails per lead — adjust "emails per lead" in Settings to sharpen it.`;
    }
  }

  const leadsNeededDaily =
    binding === "leads" && mailboxCapacity > 0 && leadCeilingDaily !== null
      ? Math.max(0, Math.ceil((mailboxCapacity - leadCeilingDaily) / sendsPerLead))
      : 0;

  // Recommending more inboxes is only honest when inboxes are what's short.
  const suppressInboxAdvice = binding === "leads" || binding === "unknown" || idle.length > 0;

  let summary: string;
  if (binding === "leads") {
    summary = `Leads are the constraint, not inboxes. ${round(
      newLeadsDaily,
    )} new leads/day × ${sendsPerLead} emails per lead ≈ ${leadCeilingDaily}/day, against ${round(
      mailboxCapacity,
    )}/day of inbox capacity. Add about ${leadsNeededDaily} more new leads a day to fill what you already own.`;
  } else if (binding === "mailboxes") {
    summary = `Inbox capacity is the constraint — your campaigns and lead supply could push more than ${round(
      mailboxCapacity,
    )}/day.`;
  } else if (binding === "campaign limits") {
    summary = `Campaign daily limits are the constraint at ${round(
      health.campaignDailyLimit,
    )}/day, below your ${round(mailboxCapacity)}/day of inbox capacity. Raise them before buying inboxes.`;
  } else {
    summary =
      "Not enough lead data to say what's holding volume back. Instantly hasn't reported a new-lead rate for these campaigns yet.";
  }

  return {
    binding,
    leadCeilingDaily,
    newLeadsDaily: round(newLeadsDaily),
    sendsPerLead,
    confidence,
    leadsNeededDaily,
    reasons,
    summary,
    suppressInboxAdvice,
    estimateWarning,
  };
}
