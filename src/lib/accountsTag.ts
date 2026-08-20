// ---------------------------------------------------------------------------
// The Accounts tab's tag view: which campaigns each account is swap-eligible for.
//
// This MUST use the same rule the swapper uses, or the tab would promise a swap
// the maintenance/cron path then refuses. So it's built on the same primitives:
// `campaignTagsOf` to resolve a campaign's niche and `eligibleFor` for the
// intersection test. A campaign appears as eligible here IF AND ONLY IF the
// swapper would let this account into it.
//
// Pure module.
// ---------------------------------------------------------------------------
import { campaignTagsOf, eligibleFor, type TagMap, tagsFor } from "./tags";

export interface CampaignLite {
  id: string;
  name: string;
  /** Tags carried inline on the campaign payload (Instantly), if any. */
  instantlyTags?: string[];
}

export interface ResolvedCampaign {
  id: string;
  name: string;
  tags: string[];
}

/**
 * Resolve every campaign's niche once, exactly as the swapper does:
 * inline Instantly tags + the tags endpoint's per-campaign entry, then
 * `campaignTagsOf` (Instantly → per-campaign override).
 */
export function resolveCampaignTags(
  campaigns: CampaignLite[],
  overrides: Record<string, string> = {},
  byCampaign?: Map<string, string[]>,
): ResolvedCampaign[] {
  return campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    tags: campaignTagsOf(
      {
        id: c.id,
        name: c.name,
        instantlyTags: [...(c.instantlyTags ?? []), ...(byCampaign?.get(c.id) ?? [])],
      },
      overrides,
    ),
  }));
}

/** Campaigns this account may be swapped into — the swapper's rule, listed. */
export function eligibleCampaignsFor(
  accountTags: readonly string[] | null | undefined,
  resolved: ResolvedCampaign[],
): ResolvedCampaign[] {
  return resolved.filter((c) => eligibleFor(accountTags, c.tags));
}

export type TagState = "untagged" | "tagged";

export interface AccountTagRow {
  email: string;
  tags: string[];
  state: TagState;
  /** null until verified — the columns the "Verify" action fills in. */
  eligible: ResolvedCampaign[] | null;
}

/**
 * One row per account for the tab, tags pulled from the merged tag map (app +
 * Instantly). Eligibility starts null — it's populated only when the operator
 * presses Verify, matching the described flow.
 */
export function buildAccountRows(emails: string[], tagMap: TagMap): AccountTagRow[] {
  return emails
    .map((email) => {
      const tags = tagsFor(tagMap, email);
      return {
        email,
        tags,
        state: (tags.length === 0 ? "untagged" : "tagged") as TagState,
        eligible: null,
      };
    })
    .sort((a, b) => {
      // Untagged first — those are the ones needing attention.
      if (a.state !== b.state) return a.state === "untagged" ? -1 : 1;
      return a.email.localeCompare(b.email);
    });
}

export interface TagCoverage {
  total: number;
  tagged: number;
  untagged: number;
}

export function tagCoverage(rows: AccountTagRow[]): TagCoverage {
  const tagged = rows.filter((r) => r.state === "tagged").length;
  return { total: rows.length, tagged, untagged: rows.length - tagged };
}
