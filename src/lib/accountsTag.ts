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
import { campaignTagsOf, eligibleFor, normaliseTag, normaliseTags, type TagMap, tagsFor } from "./tags";

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

// ---------------------------------------------------------------------------
// Why a Verify came back empty — so the tab can explain it instead of just
// saying "no campaign matches", which reads as a bug when the real cause is
// that NO campaign is tagged at all, or the account's tag simply differs.
// ---------------------------------------------------------------------------
export type NoMatchReason =
  | { kind: "match" }
  /** The account carries no tag, so it's eligible for nothing. */
  | { kind: "account_untagged" }
  /** Not one campaign has a tag — tagging the account can't help until they do. */
  | { kind: "no_campaign_tagged" }
  /** Both sides are tagged, they just don't overlap. Carries both, to show them. */
  | { kind: "tag_mismatch"; accountTags: string[]; campaignTags: string[] };

export function diagnoseNoMatch(
  accountTags: readonly string[] | null | undefined,
  resolved: ResolvedCampaign[],
): NoMatchReason {
  if (eligibleCampaignsFor(accountTags, resolved).length > 0) return { kind: "match" };
  // No campaign has a tag → the account tag is irrelevant; this is the case the
  // user actually hit. Check it first so the message points at the real fix.
  if (resolved.every((c) => c.tags.length === 0)) return { kind: "no_campaign_tagged" };
  const mine = normaliseTags(accountTags);
  if (mine.length === 0) return { kind: "account_untagged" };
  const campaignTags = [...new Set(resolved.flatMap((c) => c.tags))].sort();
  return { kind: "tag_mismatch", accountTags: mine, campaignTags };
}

// ---------------------------------------------------------------------------
// Manual match: bind an account to campaigns by giving both a shared niche tag.
//
// The swapper has one rule — eligibleFor(mailboxTags, campaignTags) — and it
// reads mailbox tags from `mailbox_tags` and campaign tags via campaignTagsOf,
// whose override fallback is `campaign_group_overrides`. So a durable manual
// match is: tag the account NICHE, and set each chosen campaign's override to
// NICHE. Then the existing rule (and the daily cron, which shares it) makes the
// account eligible with no change to the swap code.
//
// The one caveat, mirrored faithfully: campaignTagsOf lets an Instantly tag
// WIN over the override. So a campaign already tagged in Instantly can't be
// matched via the override — writing one would be a silent no-op. Those are
// reported (ignoredInstantly) rather than written, so the UI can say why.
//
// Pure — returns the writes to make; the caller persists them.
// ---------------------------------------------------------------------------
export interface ManualMatchResult {
  /** The full new campaign_group_overrides map, ready to persist. */
  overrides: Record<string, string>;
  /** The account's tags after folding in the niche (deduped, normalised). */
  tags: string[];
  /** Campaign ids whose override was appended — the ones actually bound. */
  changed: string[];
  /** Campaign ids that already resolve to the niche — no write needed. */
  alreadyEligible: string[];
  /** Campaign ids carrying a different Instantly tag — override would be ignored. */
  ignoredInstantly: string[];
}

export function applyManualMatch(
  currentOverrides: Record<string, string>,
  niche: string,
  campaignIds: readonly string[],
  existingAccountTags: readonly string[] | null | undefined,
  campaigns: CampaignLite[],
  byCampaign?: Map<string, string[]>,
): ManualMatchResult {
  const N = normaliseTag(niche);
  const overrides = { ...(currentOverrides ?? {}) };
  const result: ManualMatchResult = {
    overrides,
    tags: normaliseTags(existingAccountTags ?? []),
    changed: [],
    alreadyEligible: [],
    ignoredInstantly: [],
  };
  if (!N) return result;

  result.tags = normaliseTags([...(existingAccountTags ?? []), N]);
  const byId = new Map(campaigns.map((c) => [c.id, c]));

  for (const id of campaignIds) {
    const c = byId.get(id);
    // A campaign's Instantly-only tags — exactly what campaignTagsOf sees before
    // it falls back to the override.
    const inst = normaliseTags([
      ...((c?.instantlyTags ?? []) as string[]),
      ...(byCampaign?.get(id) ?? []),
    ]);
    if (inst.length > 0) {
      if (inst.includes(N)) result.alreadyEligible.push(id);
      else result.ignoredInstantly.push(id); // Instantly wins — override is inert.
      continue;
    }
    // No Instantly tag → the override takes effect. Append, dedup, keep any
    // niche this campaign was already bridged into.
    const merged = normaliseTags([...(overrides[id] ?? "").split(","), N]);
    overrides[id] = merged.join(",");
    result.changed.push(id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Writing tags safely: exactly one mailbox_tags row per email.
//
// The old save decided update-vs-insert from a possibly-stale snapshot, so a
// retag could insert a SECOND row for the same address; buildTagMap then unions
// duplicates, so the old tag never cleared. This plans the writes so a retag
// REPLACES: reuse the first existing row for each email, delete any duplicates,
// and mint a fresh id only when the address has no row yet. One shape drives
// both the single-row Save and the bulk operations.
//
// Pure — `newId` is injected so it's deterministic under test.
// ---------------------------------------------------------------------------
export interface TagWritePlan {
  upserts: { id: string; email: string; tags: string[]; source: "manual" }[];
  /** Extra duplicate rows for an address, to delete so only one remains. */
  removeIds: string[];
}

export function planTagWrites(
  targets: readonly { email: string; tags: readonly string[] }[],
  existingRows: readonly { id: string; email: string }[],
  newId: () => string,
): TagWritePlan {
  // All existing rows grouped by lowercased email, in stable order.
  const byEmail = new Map<string, string[]>();
  for (const r of existingRows) {
    const key = (r.email ?? "").trim().toLowerCase();
    if (!key || !r.id) continue;
    (byEmail.get(key) ?? byEmail.set(key, []).get(key)!).push(r.id);
  }

  const upserts: TagWritePlan["upserts"] = [];
  const removeIds: string[] = [];
  const seen = new Set<string>();

  for (const t of targets) {
    const email = (t.email ?? "").trim().toLowerCase();
    if (!email || seen.has(email)) continue; // one write per address
    seen.add(email);
    const ids = byEmail.get(email) ?? [];
    const id = ids[0] ?? newId(); // reuse the first row, or a fresh one
    for (const extra of ids.slice(1)) removeIds.push(extra); // kill duplicates
    upserts.push({ id, email, tags: normaliseTags(t.tags as string[]), source: "manual" });
  }
  return { upserts, removeIds };
}
