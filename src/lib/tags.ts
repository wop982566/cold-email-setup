// ---------------------------------------------------------------------------
// Which mailbox is allowed into which campaign.
//
// A mailbox warmed on CBD outreach has a reputation built against that
// audience. Dropping it into a kratom campaign because it happened to be the
// healthiest spare wastes the warmup and pollutes both niches — and until this
// module existed, that is exactly what the swapper would do: mailboxHealth.ts
// contained no notion of niche at all.
//
// A niche is a TAG, set in Instantly, and never derived from a campaign name.
// Name derivation was the first attempt and it was wrong in a way worth
// recording: it binds a mailbox to one campaign's name, so an AEO mailbox is
// excluded from the next AEO campaign you create. A tag spans every campaign
// carrying it, including ones that don't exist yet — that is the whole point.
//
// Mailboxes need an explicit tag too, and can't have one derived: a swap
// candidate is by definition attached to no active campaign, so there is no
// history to infer from.
//
// The rule is deliberately strict: an untagged mailbox matches nothing. The
// permissive reading — untagged goes anywhere — is the behaviour that caused
// the problem, so "we don't know" must mean "don't touch it", not "anything
// goes". The cost is that tagging is required before any swap happens, which is
// why every caller reports untagged spares rather than silently finding none.
//
// Pure module.
// ---------------------------------------------------------------------------

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


export interface CampaignTagInput {
  id: string;
  name: string;
  /** Whatever Instantly returned, if this workspace exposes tags at all. */
  instantlyTags?: readonly string[] | null;
}

/**
 * A campaign's niche:
 *
 *   1. tags set in Instantly — the source of truth, where you set them
 *   2. an explicit per-campaign override in the app, for workspaces or
 *      campaigns where Instantly tags aren't available
 *   3. nothing. An untagged campaign takes no swaps.
 *
 * The campaign NAME is deliberately not a source. Deriving a tag from the name
 * ties a mailbox to one campaign and excludes it from every sibling in the same
 * niche — the exact opposite of what a tag is for. A tag like AEO is meant to
 * span every AEO campaign, including ones that don't exist yet.
 *
 * Plural because a campaign can legitimately serve two niches.
 */
export function campaignTagsOf(
  campaign: CampaignTagInput,
  overrides: Record<string, string> = {},
): string[] {
  const fromInstantly = normaliseTags(campaign.instantlyTags);
  if (fromInstantly.length > 0) return fromInstantly;

  // Comma-separated, so one campaign can be bridged into two niches by hand.
  const override = normaliseTags((overrides[campaign.id] ?? "").split(","));
  return override;
}

/**
 * May this mailbox be swapped into this campaign?
 *
 * Both sides must be known and must overlap. An untagged mailbox is never
 * eligible, and an untagged campaign accepts nothing — both fail closed.
 *
 * Overlap, not equality: an AEO mailbox is eligible for EVERY AEO campaign,
 * which is the behaviour a tag exists to provide.
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

/**
 * Tag assignments read out of Instantly's custom-tags payload.
 *
 * The shape is unverified — the API and its docs are unreachable from the
 * environment this was written in — so both plausible directions are handled:
 *
 *   • a tag carrying the things it's on:  { label: "AEO", resource_ids: [...] }
 *   • an entity carrying its tags:        { id: "c1", tags: ["AEO"] }
 *
 * Anything unrecognised yields nothing rather than throwing. Ids are kept
 * verbatim and lower-cased separately, because a campaign id and a mailbox
 * address both arrive through the same field and only the latter is an email.
 */
export interface TagAssignments {
  /** Campaign id (as given) -> tags. */
  byCampaign: Map<string, string[]>;
  /** Mailbox address (lowercased) -> tags. */
  byEmail: Map<string, string[]>;
  /** Every distinct tag seen, for the chip list. */
  all: string[];
}

function addTag(map: Map<string, string[]>, key: string, tag: string): void {
  if (!key || !tag) return;
  const existing = map.get(key) ?? [];
  if (!existing.includes(tag)) map.set(key, [...existing, tag]);
}

const EMAILISH = /^[^@\s]+@[^@\s]+$/;

export function parseTagPayload(payload: unknown): TagAssignments {
  const byCampaign = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  const all = new Set<string>();

  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { items?: unknown[] } | null)?.items)
      ? ((payload as { items: unknown[] }).items)
      : Array.isArray((payload as { data?: unknown[] } | null)?.data)
        ? ((payload as { data: unknown[] }).data)
        : [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;

    const label = normaliseTag(
      String(o.label ?? o.name ?? o.tag ?? o.title ?? ""),
    );

    // Direction 1: the row IS a tag, listing what it's attached to.
    if (label) {
      all.add(label);
      const ids = [
        o.resource_ids, o.resourceIds, o.entity_ids, o.entityIds,
        o.campaign_ids, o.campaignIds, o.account_ids, o.accountIds, o.emails,
      ].filter(Array.isArray) as unknown[][];
      for (const list of ids) {
        for (const raw of list) {
          const v = typeof raw === "string" ? raw.trim() : "";
          if (!v) continue;
          if (EMAILISH.test(v)) addTag(byEmail, v.toLowerCase(), label);
          else addTag(byCampaign, v, label);
        }
      }
    }

    // Direction 2: the row is an entity, carrying its own tags. Handled in the
    // same pass because a payload may legitimately mix the two.
    const own = normaliseTags(
      (Array.isArray(o.tags) ? o.tags : Array.isArray(o.labels) ? o.labels : [])
        .map((t) => (typeof t === "string" ? t : String((t as Record<string, unknown>)?.name ?? (t as Record<string, unknown>)?.label ?? ""))),
    );
    if (own.length > 0) {
      const email = typeof o.email === "string" ? o.email.trim().toLowerCase() : "";
      const id = typeof o.id === "string" ? o.id.trim() : "";
      for (const t of own) {
        all.add(t);
        if (email) addTag(byEmail, email, t);
        else if (id) addTag(byCampaign, id, t);
      }
    }
  }

  return { byCampaign, byEmail, all: [...all].sort() };
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

/**
 * Combine the app's own mailbox tags with whatever Instantly reports.
 *
 * Union rather than precedence: tagging an inbox AEO in Instantly and tagging
 * it AEO here should not fight, and a mailbox legitimately serving two niches
 * may have one tag from each source.
 */
export function mergeTagMaps(...maps: (TagMap | undefined)[]): TagMap {
  const out: TagMap = new Map();
  for (const map of maps) {
    if (!map) continue;
    for (const [email, tags] of map) {
      out.set(email, normaliseTags([...(out.get(email) ?? []), ...tags]));
    }
  }
  return out;
}

/** Spares that can never be used until someone tags them. */
export function untaggedAmong(emails: readonly string[], map: TagMap | undefined): string[] {
  return emails.filter((e) => tagsFor(map, e).length === 0);
}
