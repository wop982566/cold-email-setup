// ---------------------------------------------------------------------------
// Which mailbox is allowed into which campaign.
//
// A mailbox warmed on CBD outreach has a reputation built against that
// audience. Dropping it into a kratom campaign because it happened to be the
// healthiest spare wastes the warmup and pollutes both niches — and until this
// module existed, that is exactly what the swapper would do: mailboxHealth.ts
// contained no notion of niche at all.
//
// Campaigns already carry one, via groupFromName() and the operator's
// campaign_group_overrides. Mailboxes could not: a swap candidate is by
// definition attached to no active campaign, so there is no history to derive a
// niche from. Hence explicit tags, assigned when the mailbox is created.
//
// The rule is deliberately strict: an untagged mailbox matches nothing. The
// permissive reading — untagged goes anywhere — is the behaviour that caused
// the problem, so "we don't know" must mean "don't touch it", not "anything
// goes". The cost is that tagging is required before any swap happens, which is
// why every caller reports untagged spares rather than silently finding none.
//
// Pure module.
// ---------------------------------------------------------------------------
import { groupFromName } from "./campaignPlan";

/** Tags compare case- and whitespace-insensitively. CBD, cbd and " Cbd " are one. */
export function normaliseTag(raw: string): string {
  return raw.trim().toUpperCase();
}

export function normaliseTags(raw: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const t of raw ?? []) {
    const n = normaliseTag(t);
    if (n) seen.add(n);
  }
  return [...seen];
}

/**
 * groupFromName's sentinel for a campaign it can't read a token out of.
 *
 * It is the ABSENCE of a niche, not a niche called "Ungrouped" — treating it as
 * a real tag would put every unparseable campaign in one shared bucket, so a
 * mailbox tagged there would be eligible for all of them at once. Exactly the
 * cross-niche swap this module exists to prevent.
 */
const UNGROUPED_SENTINEL = "UNGROUPED";

export interface CampaignTagInput {
  id: string;
  name: string;
  /** Whatever Instantly returned, if this workspace exposes tags at all. */
  instantlyTags?: readonly string[] | null;
}

/**
 * A campaign's niche, by a single resolution order used everywhere:
 *
 *   1. the operator's explicit override — always wins, it's a correction
 *   2. tags from Instantly, when the workspace has them
 *   3. the first token of the campaign name, which is the existing convention
 *
 * Returning an array rather than one value because Instantly tags are plural
 * and a campaign can legitimately serve two niches.
 */
export function campaignTagsOf(
  campaign: CampaignTagInput,
  overrides: Record<string, string> = {},
): string[] {
  const override = overrides[campaign.id];
  if (override && normaliseTag(override)) return [normaliseTag(override)];

  const fromInstantly = normaliseTags(campaign.instantlyTags);
  if (fromInstantly.length > 0) return fromInstantly;

  const derived = normaliseTag(groupFromName(campaign.name ?? ""));
  return derived && derived !== UNGROUPED_SENTINEL ? [derived] : [];
}

/**
 * May this mailbox be swapped into this campaign?
 *
 * Both sides must be known and must overlap. An untagged mailbox is never
 * eligible; a campaign whose niche can't be resolved matches nothing rather
 * than everything, so an unparseable campaign name fails closed.
 */
export function eligibleFor(
  mailboxTags: readonly string[] | null | undefined,
  campaignTags: readonly string[] | null | undefined,
): boolean {
  const mine = normaliseTags(mailboxTags);
  const theirs = normaliseTags(campaignTags);
  if (mine.length === 0 || theirs.length === 0) return false;
  return mine.some((t) => theirs.includes(t));
}

/** Why a candidate was refused, in words that go straight into the UI. */
export function explainIneligible(
  email: string,
  mailboxTags: readonly string[] | null | undefined,
  campaignTags: readonly string[] | null | undefined,
): string | null {
  if (eligibleFor(mailboxTags, campaignTags)) return null;
  const mine = normaliseTags(mailboxTags);
  const theirs = normaliseTags(campaignTags);
  if (theirs.length === 0) {
    return `this campaign has no tag, so nothing is eligible for it — set one in the planner`;
  }
  if (mine.length === 0) {
    return `${email} has no tag, so it can't be used anywhere`;
  }
  return `${email} is tagged ${mine.join(", ")}, not ${theirs.join(" or ")}`;
}

/**
 * Every tag worth offering as a chip: the niches your campaigns are in, plus
 * anything already assigned to a mailbox. Sorted so the list is stable.
 */
export function knownTags(
  campaigns: readonly CampaignTagInput[],
  overrides: Record<string, string> = {},
  assigned: readonly string[] = [],
): string[] {
  const all = new Set<string>();
  for (const c of campaigns) for (const t of campaignTagsOf(c, overrides)) all.add(t);
  for (const t of normaliseTags(assigned)) all.add(t);
  return [...all].sort();
}

/** email (lowercased) -> tags. The per-mailbox truth the swapper consults. */
export type TagMap = Map<string, string[]>;

export function buildTagMap(rows: readonly { email: string; tags: string[] }[]): TagMap {
  const map: TagMap = new Map();
  for (const r of rows) {
    const key = (r.email ?? "").trim().toLowerCase();
    if (!key) continue;
    // Merge rather than overwrite, so a duplicate row can't silently drop tags.
    map.set(key, normaliseTags([...(map.get(key) ?? []), ...r.tags]));
  }
  return map;
}

export function tagsFor(map: TagMap | undefined, email: string): string[] {
  return map?.get((email ?? "").trim().toLowerCase()) ?? [];
}

/** Spares that can never be used until someone tags them. */
export function untaggedAmong(emails: readonly string[], map: TagMap | undefined): string[] {
  return emails.filter((e) => tagsFor(map, e).length === 0);
}
