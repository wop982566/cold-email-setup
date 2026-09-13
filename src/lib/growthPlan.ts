// ---------------------------------------------------------------------------
// The growth calculator: given a daily-send goal and the structure you build
// with (a per-campaign cap, a per-mailbox limit, mailboxes per domain, and a
// per-niche spare buffer), work out what you already have and exactly what to
// add — campaigns, sending inboxes, healthy spares per niche, and the domains
// to host them on.
//
// It extends the simple goal planner (which only sized inboxes/domains) with
// the two things that decide a real cold-email fleet: the per-campaign limit
// (campaigns are capped, so hitting a big number needs *many* campaigns) and a
// swap buffer of healthy spares kept PER NICHE, since a spare can only replace
// a mailbox in a campaign of its own niche.
//
// Pure module — the caller resolves niches and current spare counts (which need
// the tag system) and passes them in as plain numbers, so this stays testable.
// ---------------------------------------------------------------------------

export interface NicheSpare {
  niche: string;
  /** Healthy spares currently tagged this niche. */
  current: number;
  /** Spares you want to keep for this niche. */
  target: number;
  /** How many more tagged spares to add for this niche. */
  shortfall: number;
}

export interface GrowthInput {
  /** Emails/day to reach — already in email terms (leads → emails applied upstream). */
  goalPerDay: number;
  /** Daily cap you set per campaign, e.g. 200. */
  perCampaignLimit: number;
  /** Safe sends per inbox/day (the planner's perBoxCap). */
  perMailboxLimit: number;
  /** Sending mailboxes hosted per domain (1..3). */
  mailboxesPerDomain: number;
  /** Healthy spares to keep for each distinct niche. */
  sparesPerNiche: number;
  /** Distinct niches your active campaigns run in. */
  niches: readonly string[];
  /** Healthy spares you already have, per niche. */
  currentSparesByNiche: Record<string, number>;
  /** Active campaigns you already run. */
  activeCampaigns: number;
  /** Sum of your active campaigns' configured daily limits. */
  configuredDemand: number;
  /** Usable inboxes you already have. */
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
  // --- Sending mailboxes ---------------------------------------------------
  sendingMailboxesRequired: number;
  // --- Spare buffer, per niche ---------------------------------------------
  spares: NicheSpare[];
  spareMailboxesRequired: number;
  spareShortfall: number;
  // --- Whole fleet ---------------------------------------------------------
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
  const sparesPerNiche = Math.max(0, Math.floor(nonneg(input.sparesPerNiche)));

  // Campaigns: each is capped, so a big goal needs several.
  const campaignsRequired = ceilDiv(goal, perCampaign);
  const campaignsToAdd = Math.max(0, campaignsRequired - Math.max(0, input.activeCampaigns));
  const demandGap = Math.max(0, goal - Math.max(0, input.configuredDemand));

  // Sending mailboxes for the raw volume.
  const sendingMailboxesRequired = ceilDiv(goal, perMailbox);

  // Spares kept per niche — the swap buffer. A spare only helps its own niche,
  // so the target is per-niche and the shortfall is per-niche.
  const spares: NicheSpare[] = [...new Set(input.niches)].map((niche) => {
    const current = Math.max(0, input.currentSparesByNiche[niche] ?? 0);
    const shortfall = Math.max(0, sparesPerNiche - current);
    return { niche, current, target: sparesPerNiche, shortfall };
  });
  const spareMailboxesRequired = spares.length * sparesPerNiche;
  const spareShortfall = spares.reduce((n, s) => n + s.shortfall, 0);

  // The whole fleet you must own: sending inboxes + the spare buffer.
  const totalMailboxesRequired = sendingMailboxesRequired + spareMailboxesRequired;
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
    sendingMailboxesRequired,
    spares,
    spareMailboxesRequired,
    spareShortfall,
    totalMailboxesRequired,
    mailboxesToAdd,
    domainsToAdd,
    supplyGap,
    providerCeiling,
    providerOk,
    monthlyCostAdd,
  };
}
