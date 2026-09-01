// ---------------------------------------------------------------------------
// Autopopulate: fill each campaign with IDLE inboxes of its own niche until the
// campaign's attached daily sending capacity reaches its daily limit.
//
// Two rules, both borrowed from the swapper so the tool never contradicts
// itself:
//   1. Niche gating — an idle inbox is only ever added to a campaign that shares
//      one of its tags (an AEO inbox to an AEO campaign). Untagged matches
//      nothing.
//   2. One inbox, one campaign — a global reservation, worst-gap-first, so the
//      same idle inbox is never proposed to two campaigns at once.
//
// An idle inbox sits in no campaign (shareCount 0), so attaching it to one
// campaign contributes its FULL daily limit — no contention division. Pure
// module: the page fetches and writes, this only decides.
// ---------------------------------------------------------------------------
import { PlannerCampaign, PlannerMailbox } from "./campaignPlan";
import { campaignTagsOf, eligibleFor, tagsFor, untaggedAmong, type TagMap } from "./tags";

export interface AutopopulateAdd {
  email: string;
  dailyLimit: number;
  mature: boolean;
}

export interface AutopopulateCampaignPlan {
  campaignId: string;
  campaignName: string;
  campaignTags: string[];
  add: AutopopulateAdd[];
  /** Contention-aware daily capacity before / after the additions. */
  supplyBefore: number;
  supplyAfter: number;
  dailyLimit: number;
  /** Remaining gap after adding — 0 when the campaign is filled. */
  stillShort: number;
  /** Set when nothing could be added, explaining why. */
  reason?: string;
}

export interface AutopopulatePlan {
  plans: AutopopulateCampaignPlan[];
  totals: { campaignsFilled: number; inboxesUsed: number; idleRemaining: number };
  /** Idle inboxes usable but tagged for nothing — unusable until tagged. */
  untaggedIdle: string[];
}

export interface AutopopulateInput {
  campaigns: PlannerCampaign[];
  /** Idle mailboxes (attached to no campaign of any status). */
  idle: PlannerMailbox[];
  tagMap: TagMap;
  /** Campaign id -> tags from Instantly's tags endpoint (merged with inline). */
  campaignTagsById?: Map<string, string[]>;
  /** campaign_group_overrides — the manual niche fallback. */
  overrides?: Record<string, string>;
  /** Optional health, only for ranking better spares first — never a hard gate. */
  healthByEmail?: Map<string, { mature: boolean; healthScore: number | null }>;
}

export function planAutopopulate(input: AutopopulateInput): AutopopulatePlan {
  const overrides = input.overrides ?? {};
  const health = input.healthByEmail;
  const matureOf = (email: string) => health?.get(email.toLowerCase())?.mature ?? false;
  const scoreOf = (email: string) => health?.get(email.toLowerCase())?.healthScore ?? -1;

  // An idle inbox we'd actually attach: active, not excluded by hand, and past
  // setup. (Idle already means "in no campaign".)
  const usableIdle = input.idle.filter((b) => b.active && !b.excluded && !b.setupPending);

  const reserved = new Set<string>();
  const plans: AutopopulateCampaignPlan[] = [];

  // Active campaigns that are short, worst gap first — the same ordering the
  // swapper uses so the scarcest capacity is covered first.
  const needy = input.campaigns
    .filter((c) => c.active && c.gapDaily > 0)
    .sort((a, b) => b.gapDaily - a.gapDaily || a.name.localeCompare(b.name));

  for (const c of needy) {
    const campaignTags = campaignTagsOf(
      {
        id: c.id,
        name: c.name,
        instantlyTags: [...c.instantlyTags, ...(input.campaignTagsById?.get(c.id) ?? [])],
      },
      overrides,
    );

    const plan: AutopopulateCampaignPlan = {
      campaignId: c.id,
      campaignName: c.name,
      campaignTags,
      add: [],
      supplyBefore: c.supplyDaily,
      supplyAfter: c.supplyDaily,
      dailyLimit: c.dailyLimit,
      stillShort: c.gapDaily,
    };

    if (campaignTags.length === 0) {
      plan.reason = "Campaign has no niche tag — tag it so idle inboxes can be matched to it.";
      plans.push(plan);
      continue;
    }

    const free = usableIdle.filter((b) => !reserved.has(b.email.toLowerCase()));
    const pool = free.filter((b) => eligibleFor(tagsFor(input.tagMap, b.email), campaignTags));

    if (pool.length === 0) {
      // Being blocked by tags is a different problem from having no idle inboxes
      // at all, and needs a different fix, so the two are not merged into silence.
      const untagged = untaggedAmong(
        free.map((b) => b.email),
        input.tagMap,
      );
      plan.reason =
        free.length === 0
          ? "No idle inboxes left to add."
          : untagged.length === free.length
            ? `${free.length} idle inbox${free.length === 1 ? "" : "es"} free but none tagged — tag them ${campaignTags.join(" or ")} to use them here.`
            : `${free.length} idle inbox${free.length === 1 ? "" : "es"} free, none tagged ${campaignTags.join(" or ")}.`;
      plans.push(plan);
      continue;
    }

    // Rank: mature first, then healthier, then bigger daily limit (fills the gap
    // in fewer inboxes), then a stable tiebreak.
    const ranked = [...pool].sort((a, b) => {
      const ma = matureOf(a.email) ? 1 : 0;
      const mb = matureOf(b.email) ? 1 : 0;
      if (ma !== mb) return mb - ma;
      const sa = scoreOf(a.email);
      const sb = scoreOf(b.email);
      if (sa !== sb) return sb - sa;
      if (a.dailyLimit !== b.dailyLimit) return b.dailyLimit - a.dailyLimit;
      return a.email.localeCompare(b.email);
    });

    let supply = c.supplyDaily;
    for (const b of ranked) {
      if (supply >= c.dailyLimit) break;
      plan.add.push({ email: b.email, dailyLimit: b.dailyLimit, mature: matureOf(b.email) });
      reserved.add(b.email.toLowerCase());
      supply += b.dailyLimit;
    }

    plan.supplyAfter = supply;
    plan.stillShort = Math.max(0, c.dailyLimit - supply);
    plans.push(plan);
  }

  const idleRemaining = usableIdle.filter((b) => !reserved.has(b.email.toLowerCase())).length;

  return {
    plans,
    totals: {
      campaignsFilled: plans.filter((p) => p.add.length > 0).length,
      inboxesUsed: reserved.size,
      idleRemaining,
    },
    untaggedIdle: untaggedAmong(
      usableIdle.map((b) => b.email),
      input.tagMap,
    ),
  };
}
