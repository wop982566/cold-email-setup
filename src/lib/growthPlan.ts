// ---------------------------------------------------------------------------
// The growth calculator: given a daily-send goal and the structure you build
// with (a per-campaign cap, a per-mailbox limit, and mailboxes per domain),
// work out what you already have and exactly what to add — campaigns, connected
// (sending) inboxes, the matching ROTATION inboxes, and the domains to host them.
//
// The rotation strategy sizes the fleet: every connected inbox needs a same-niche
// partner to swap in every ~15 days, so you own TWICE the sending count — the
// connected set plus an equal rotation set that rests and re-warms until its turn.
// Sizing is per campaign (a campaign is capped, so a big goal needs several, and
// each needs ceil(cap / per-mailbox) inboxes to fill it), then doubled.
//
// Pure module — the caller resolves the live numbers and passes them in as plain
// values, so this stays testable with no network or DOM.
// ---------------------------------------------------------------------------

export interface GrowthInput {
  /** Emails/day to reach — already in email terms (leads → emails applied upstream). */
  goalPerDay: number;
  /** Daily cap you set per campaign, e.g. 200. */
  perCampaignLimit: number;
  /** Safe sends per inbox/day (the planner's perBoxCap), e.g. 15. */
  perMailboxLimit: number;
  /** Sending mailboxes hosted per domain (1..3). */
  mailboxesPerDomain: number;
  /** Active campaigns you already run. */
  activeCampaigns: number;
  /** Sum of your active campaigns' configured daily limits. */
  configuredDemand: number;
  /** Usable inboxes you already have (connected + free spares you can rotate in). */
  usableInboxes: number;
  /** Sum of your usable mailboxes' daily limits — what you can actually send. */
  currentSupply: number;
  /** Tightest provider daily cap; 0 = unknown. */
  providerCeiling: number;
  costPerDomainMonthly: number | null;
  costPerMailboxMonthly: number | null;
}

export interface GrowthPlan {
  goalPerDay: number;
  perMailboxLimit: number;
  // --- Campaign layer ------------------------------------------------------
  campaignsRequired: number;
  campaignsToAdd: number;
  /** More emails/day of campaign capacity to configure to reach the goal. */
  demandGap: number;
  /** Connected (sending) inboxes one campaign needs to fill its cap. */
  inboxesPerCampaign: number;
  // --- Rotation fleet (connected + an equal rotation set) -------------------
  /** Connected (sending) inboxes across all campaigns. */
  connectedRequired: number;
  /** The matching rotation partners — equal to the connected set (1:1 mirror). */
  rotationRequired: number;
  /** The whole fleet you must own = connected × 2. */
  totalMailboxesRequired: number;
  mailboxesToAdd: number;
  domainsToAdd: number;
  // --- Reality checks ------------------------------------------------------
  /** Emails/day the current mailbox supply still can't cover. */
  supplyGap: number;
  providerCeiling: number;
  providerOk: boolean;
  monthlyCostAdd: number | null;
}

const nonneg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
const ceilDiv = (n: number, d: number) => (d > 0 ? Math.ceil(nonneg(n) / d) : 0);

export function computeGrowthPlan(input: GrowthInput): GrowthPlan {
  const goal = nonneg(input.goalPerDay);
  const perCampaign = nonneg(input.perCampaignLimit);
  const perMailbox = nonneg(input.perMailboxLimit);
  const perDomain = Math.max(1, Math.floor(nonneg(input.mailboxesPerDomain) || 1));

  // Campaigns: each is capped, so a big goal needs several.
  const campaignsRequired = perCampaign > 0 ? ceilDiv(goal, perCampaign) : goal > 0 ? 1 : 0;
  const campaignsToAdd = Math.max(0, campaignsRequired - Math.max(0, input.activeCampaigns));
  const demandGap = Math.max(0, goal - Math.max(0, input.configuredDemand));

  // Connected (sending) inboxes: one campaign needs ceil(cap / per-mailbox) to
  // fill it (200 / 15 = 14); the whole goal needs that across every campaign.
  // With no campaign cap set, fall back to sizing the raw volume directly.
  const inboxesPerCampaign = perCampaign > 0 ? ceilDiv(perCampaign, perMailbox) : ceilDiv(goal, perMailbox);
  const connectedRequired = perCampaign > 0 ? campaignsRequired * inboxesPerCampaign : ceilDiv(goal, perMailbox);

  // The rotation mirror: an equal same-niche partner set to swap in on schedule.
  const rotationRequired = connectedRequired;
  const totalMailboxesRequired = connectedRequired + rotationRequired; // = connected × 2

  const mailboxesToAdd = Math.max(0, totalMailboxesRequired - Math.max(0, input.usableInboxes));
  const domainsToAdd = ceilDiv(mailboxesToAdd, perDomain);

  const supplyGap = Math.max(0, goal - Math.max(0, input.currentSupply));
  const providerCeiling = nonneg(input.providerCeiling);
  const providerOk = providerCeiling <= 0 || goal <= providerCeiling;

  const { costPerDomainMonthly: cd, costPerMailboxMonthly: cm } = input;
  const monthlyCostAdd =
    cd === null && cm === null ? null : domainsToAdd * (cd ?? 0) + mailboxesToAdd * (cm ?? 0);

  return {
    goalPerDay: goal,
    perMailboxLimit: perMailbox,
    campaignsRequired,
    campaignsToAdd,
    demandGap,
    inboxesPerCampaign,
    connectedRequired,
    rotationRequired,
    totalMailboxesRequired,
    mailboxesToAdd,
    domainsToAdd,
    supplyGap,
    providerCeiling,
    providerOk,
    monthlyCostAdd,
  };
}
