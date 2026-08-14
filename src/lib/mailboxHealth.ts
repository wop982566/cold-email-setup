// ---------------------------------------------------------------------------
// Campaign maintenance: which mailboxes attached to live campaigns are hurting
// deliverability, and which healthy spare should replace each one.
//
// Two rules shape the whole module:
//   1. A NEW mailbox at score 45 is fine (still warming). A MATURE mailbox at
//      45 is burned. Without that split the feature nags about every inbox the
//      operator is deliberately warming.
//   2. Replacement candidates are ASSIGNED GLOBALLY with reservation. If five
//      campaigns each need a spare and only two exist, the two worst problems
//      get them and the shortfall is reported — never the same spare proposed
//      five times.
//
// Pure module — the page fetches, this computes.
// ---------------------------------------------------------------------------
import { AppSettings, Domain } from "./types";
import { Plan, PlannerCampaign, PlannerMailbox } from "./campaignPlan";
import { daysUntil } from "./format";
import { campaignTagsOf, eligibleFor, tagsFor, untaggedAmong, type TagMap } from "./tags";

export type IssueCode =
  | "account_broken"
  | "warmup_critical"
  | "warmup_low"
  | "warmup_off"
  | "warmup_unknown"
  | "spam_placement"
  | "domain_expired"
  | "domain_expiring"
  | "domain_dns"
  | "domain_untracked";

export type Severity = "critical" | "warn" | "watch";
export type Verdict = "replace" | "attention" | "watch" | "ok" | "ramping";

export interface Issue {
  code: IssueCode;
  severity: Severity;
  label: string;
  triggersReplacement: boolean;
}

export interface MailboxHealth {
  /** Set when a swap for this mailbox was blocked by tags, not by a lack of spares. */
  tagBlock?: string | null;
  box: PlannerMailbox;
  verdict: Verdict;
  issues: Issue[];
  score: number | null; // null when genuinely unknown
  inboxRate: number | null; // from warmup analytics, when available
  ageDays: number | null;
  mature: boolean;
  domain: Domain | null;
  domainName: string;
  activeCampaigns: string[]; // ids
  available: boolean; // eligible as a replacement
}

export interface SwapProposal {
  id: string;
  bad: MailboxHealth;
  replacement: MailboxHealth;
  alternatives: MailboxHealth[];
  reasons: string[];
  warnings: string[];
  capacityDelta: number;
  campaigns: { id: string; name: string; emailListNow: string[] }[];
}

export interface Maintenance {
  mailboxes: MailboxHealth[];
  flagged: MailboxHealth[];
  proposals: SwapProposal[];
  unassigned: MailboxHealth[];
  candidates: MailboxHealth[];
  shortfall: number;
  /** False when no tag map was supplied — gating is off and swaps ignore niche. */
  tagGatingActive: boolean;
  /** Healthy spares that can never be used until someone tags them. */
  untaggedSpares: string[];
  placementChecked: number;
  untrackedDomains: number;
  stats: { critical: number; warn: number; watch: number; ramping: number };
}

export interface MaintenanceInput {
  plan: Plan;
  domains: Domain[];
  placement?: Map<string, { inboxRate: number | null; score: number | null }>;
  recovering?: Set<string>; // emails currently convalescing — never proposed
  /**
   * Mailbox niches. Omitted entirely, tag gating is skipped — which keeps every
   * existing caller and test working exactly as before. Supplied, an untagged
   * mailbox becomes ineligible everywhere, which is the point.
   */
  tagMap?: TagMap;
  settings: AppSettings;
  today?: Date;
}

const DEF = {
  minScore: 80,
  criticalScore: 50,
  maturityDays: 21,
  minInboxRate: 80,
};

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Index Domains by mailbox address and by domain name, both normalised. */
export function buildDomainIndex(domains: Domain[]) {
  const byEmail = new Map<string, Domain>();
  const byDomain = new Map<string, Domain>();
  for (const d of domains) {
    for (const e of [d.email_1, d.email_2]) {
      const k = norm(e ?? "");
      if (k) byEmail.set(k, d);
    }
    // Domains.tsx writes raw text with no normalisation, so clean it here.
    const dn = norm(d.domain_name ?? "").replace(/^www\./, "").replace(/\.$/, "");
    if (dn && !byDomain.has(dn)) byDomain.set(dn, d);
  }
  return { byEmail, byDomain };
}

function domainFor(email: string, ix: ReturnType<typeof buildDomainIndex>): Domain | null {
  const e = norm(email);
  const exact = ix.byEmail.get(e);
  if (exact) return exact;
  const host = e.slice(e.lastIndexOf("@") + 1);
  return ix.byDomain.get(host) ?? null;
}

export function computeMaintenance({
  plan,
  domains,
  placement,
  recovering = new Set(),
  tagMap,
  settings,
  today,
}: MaintenanceInput): Maintenance {
  const now = today ?? new Date();
  // Reported on the result so "gating is off because nobody passed tags" is
  // visible in the UI and the cron log rather than being a silent no-op.
  const tagGatingActive = tagMap !== undefined;
  const groupOverrides = settings.campaign_group_overrides ?? {};
  const s = settings as unknown as Record<string, unknown>;
  const minScore = num(s.maintenance_min_warmup_score, DEF.minScore);
  const criticalScore = num(s.maintenance_critical_score, DEF.criticalScore);
  const maturityDays = num(s.maintenance_new_mailbox_days, DEF.maturityDays);
  const minInboxRate = num(s.maintenance_min_inbox_rate, DEF.minInboxRate);
  const expiryWindow = num(settings.reminder_window_days, 30);

  const ix = buildDomainIndex(domains);
  const campaignById = new Map(plan.campaigns.map((c) => [c.id, c]));

  const mailboxes: MailboxHealth[] = plan.mailboxes.map((box) => {
    const issues: Issue[] = [];
    const place = placement?.get(box.email);
    const inboxRate = place?.inboxRate ?? null;
    // Prefer the account's own score; fall back to whatever warmup analytics
    // reported, so a workspace that only exposes one of the two still works.
    const score = box.warmupScoreKnown ? box.warmupScore : (place?.score ?? null);

    const ageDays = box.createdAt ? Math.max(0, -(daysUntil(box.createdAt) ?? 0)) : null;
    const hasSent = Boolean(box.lastUsedAt);
    // Unknown age + never sent => assume new, so we never tell someone to
    // replace an inbox we know nothing about.
    const mature = ageDays === null ? hasSent : ageDays >= maturityDays || hasSent;

    const inActive = box.campaignIds.length > 0;
    const domain = domainFor(box.email, ix);
    const domainName = box.email.slice(box.email.lastIndexOf("@") + 1);

    const add = (code: IssueCode, severity: Severity, label: string, triggers = false) =>
      issues.push({ code, severity, label, triggersReplacement: triggers });

    // --- account level ---
    if (inActive && (!box.active || box.setupPending)) {
      add("account_broken", "critical", `Account not sending (status ${String(box.statusRaw)})`, true);
    }

    // --- warmup score ---
    if (score === null) {
      add("warmup_unknown", "watch", "No warmup score reported");
    } else if (!box.warmupOn && score === 0) {
      // A real 0 with warmup off means warmup was never switched on — that is
      // a different problem from a score that collapsed.
      if (inActive) add("warmup_off", "warn", "Warmup is off");
    } else if (mature && score < criticalScore) {
      add("warmup_critical", "critical", `Warmup score ${score} — badly degraded`, true);
    } else if (mature && score < minScore) {
      add("warmup_low", "warn", `Warmup score ${score}, below ${minScore}`, true);
    } else if (!mature && score < minScore) {
      // Still ramping — informational only.
      add("warmup_low", "watch", `Warming: score ${score}${ageDays !== null ? `, day ${ageDays}` : ""}`);
    }
    if (box.warmupOn === false && score !== null && score > 0 && inActive) {
      add("warmup_off", "warn", "Warmup is off");
    }

    // --- placement ---
    if (inboxRate !== null && inboxRate < minInboxRate) {
      const crit = inboxRate < 50;
      add(
        "spam_placement",
        crit ? "critical" : "warn",
        `Only ${Math.round(inboxRate)}% landing in inbox`,
        true,
      );
    }

    // --- domain ---
    if (!domain) {
      add("domain_untracked", "watch", `${domainName} isn't in your Domains list`);
    } else {
      const days = daysUntil(domain.expiry_date);
      if (days !== null && days < 0) {
        add("domain_expired", "critical", `${domain.domain_name} expired`, true);
      } else if (days !== null && days <= expiryWindow) {
        // Renew the domain — swapping the mailbox wouldn't fix this.
        add("domain_expiring", "warn", `${domain.domain_name} expires in ${days}d`);
      }
      if (domain.dns_status === "No") {
        add("domain_dns", "warn", `${domain.domain_name} DNS not verified`);
      } else if (domain.dns_status !== "Yes") {
        add("domain_dns", "watch", `${domain.domain_name} DNS ${domain.dns_status || "unset"}`);
      }
    }

    const triggers = issues.some((i) => i.triggersReplacement);
    const ramping = !mature && score !== null && score < minScore;
    const verdict: Verdict = triggers
      ? "replace"
      : ramping
        ? "ramping"
        : issues.some((i) => i.severity === "warn")
          ? "attention"
          : issues.length > 0
            ? "watch"
            : "ok";

    return {
      box,
      verdict,
      issues,
      score,
      inboxRate,
      ageDays,
      mature,
      domain,
      domainName,
      activeCampaigns: box.campaignIds,
      available: false, // filled below
    };
  });

  const byEmail = new Map(mailboxes.map((m) => [m.box.email, m]));

  // --- Candidate pool ------------------------------------------------------
  // The operator's rule: available if attached to nothing, OR attached only to
  // campaigns that aren't active. NOTE we deliberately do not exclude
  // beyondCount mailboxes — those trimmed by "inboxes I'm using" ARE the spare
  // pool, and filtering them would leave nothing to propose.
  for (const m of mailboxes) {
    m.available =
      m.box.active &&
      !m.box.setupPending &&
      !m.box.excluded &&
      m.box.shareCount === 0 && // in no ACTIVE campaign
      m.score !== null &&
      m.score >= minScore &&
      m.mature &&
      !recovering.has(m.box.email) &&
      m.verdict !== "replace";
  }
  const candidates = mailboxes.filter((m) => m.available);

  // --- Needs, worst first --------------------------------------------------
  const sevRank = (m: MailboxHealth) =>
    m.issues.some((i) => i.severity === "critical" && i.triggersReplacement) ? 0 : 1;
  const flagged = mailboxes.filter((m) => m.verdict === "replace");
  // Only mailboxes in a LIVE campaign can be swapped — a burned spare just sits.
  const needs = flagged
    .filter((m) => m.box.campaignIds.length > 0)
    .sort(
      (a, b) =>
        sevRank(a) - sevRank(b) ||
        b.box.campaignIds.length - a.box.campaignIds.length ||
        b.box.dailyLimit - a.box.dailyLimit ||
        a.box.email.localeCompare(b.box.email),
    );

  // --- Ranked, reserved assignment ----------------------------------------
  const reserved = new Set<string>();
  const proposals: SwapProposal[] = [];
  const unassigned: MailboxHealth[] = [];

  for (const need of needs) {
    const targets = need.box.campaignIds
      .map((id) => campaignById.get(id))
      .filter((c): c is PlannerCampaign => Boolean(c));
    const domainsInPlay = new Set(
      targets.flatMap((c) => c.emails.map((e) => e.slice(e.lastIndexOf("@") + 1))),
    );
    const badDomain = need.domainName;

    // The niche rule. A mailbox warmed for one audience must not be dropped
    // into another just because it happened to be the healthiest spare, so a
    // candidate has to share a tag with every campaign it would be entering.
    // Untagged matches nothing — "we don't know" means don't touch it.
    const needTags = [
      ...new Set(targets.flatMap((c) => campaignTagsOf({ id: c.id, name: c.name, instantlyTags: c.instantlyTags }, groupOverrides))),
    ];
    const free = candidates.filter((c) => !reserved.has(c.box.email));
    const pool = tagGatingActive
      ? free.filter((c) => eligibleFor(tagsFor(tagMap, c.box.email), needTags))
      : free;

    if (pool.length === 0) {
      // Being blocked by tags is a different problem from having no spares at
      // all, and needs a different fix, so the two are not merged into silence.
      const untagged = untaggedAmong(free.map((c) => c.box.email), tagMap);
      need.tagBlock =
        free.length === 0
          ? null
          : needTags.length === 0
            ? `No tag on ${targets.map((c) => c.name).join(", ") || "this campaign"}, so nothing is eligible for it.`
            : untagged.length === free.length
              ? `${free.length} healthy spare${free.length === 1 ? "" : "s"} available but none is tagged — tag them ${needTags.join(" or ")} to make them eligible.`
              : `${free.length} healthy spare${free.length === 1 ? "" : "s"} available, none tagged ${needTags.join(" or ")}.`;
      unassigned.push(need);
      continue;
    }

    const ranked = [...pool].sort((a, b) => {
      // Bucket the score so ±1 of noise between refreshes doesn't reshuffle
      // the proposal under the operator's cursor.
      const bucket = (m: MailboxHealth) => Math.round((m.score ?? 0) / 5) * 5;
      if (bucket(a) !== bucket(b)) return bucket(b) - bucket(a);
      // If the bad mailbox is bad because its DOMAIN is burned, its sibling on
      // that same domain is the next thing to burn.
      const sameBad = (m: MailboxHealth) => (m.domainName === badDomain ? 1 : 0);
      if (sameBad(a) !== sameBad(b)) return sameBad(a) - sameBad(b);
      // Diversity: prefer a domain the campaign isn't already leaning on.
      const inPlay = (m: MailboxHealth) => (domainsInPlay.has(m.domainName) ? 1 : 0);
      if (inPlay(a) !== inPlay(b)) return inPlay(a) - inPlay(b);
      const dTier = (m: MailboxHealth) => {
        if (!m.domain) return 2;
        const days = daysUntil(m.domain.expiry_date);
        if (m.domain.dns_status === "No" || (days !== null && days < 0)) return 3;
        return m.domain.dns_status === "Yes" && (days === null || days > expiryWindow) ? 0 : 1;
      };
      if (dTier(a) !== dTier(b)) return dTier(a) - dTier(b);
      if (a.box.dailyLimit !== b.box.dailyLimit) return b.box.dailyLimit - a.box.dailyLimit;
      return a.box.email.localeCompare(b.box.email);
    });

    const best = ranked[0];
    reserved.add(best.box.email);

    const reasons: string[] = [];
    if (best.score !== null) reasons.push(`warmup score ${best.score}`);
    if (best.ageDays !== null) reasons.push(`${best.ageDays}d old`);
    if (best.domainName !== badDomain) reasons.push("different domain from the failing one");
    if (!domainsInPlay.has(best.domainName)) reasons.push("adds a new domain to this campaign");
    if (best.domain?.dns_status === "Yes") reasons.push("DNS verified");
    reasons.push(`${best.box.dailyLimit}/day`);

    const warnings: string[] = [];
    if (best.box.beyondCount) {
      warnings.push("This inbox sits outside your “inboxes I'm using” count — applying will start using it.");
    }
    if (best.box.pausedOnly) warnings.push("Currently parked in a paused campaign.");

    proposals.push({
      id: need.box.email,
      bad: need,
      replacement: best,
      alternatives: ranked.slice(1, 4),
      reasons,
      warnings,
      capacityDelta: best.box.dailyLimit - need.box.dailyLimit,
      campaigns: targets.map((c) => ({ id: c.id, name: c.name, emailListNow: c.emails })),
    });
  }

  const stats = { critical: 0, warn: 0, watch: 0, ramping: 0 };
  for (const m of mailboxes) {
    if (m.verdict === "ramping") stats.ramping++;
    else if (m.issues.some((i) => i.severity === "critical")) stats.critical++;
    else if (m.issues.some((i) => i.severity === "warn")) stats.warn++;
    else if (m.issues.length > 0) stats.watch++;
  }

  return {
    mailboxes,
    flagged,
    proposals,
    unassigned,
    candidates,
    shortfall: unassigned.length,
    tagGatingActive,
    // Healthy, free, and unusable until tagged — the state that otherwise looks
    // identical to having no spares at all.
    untaggedSpares: tagGatingActive
      ? untaggedAmong(
          candidates.map((c) => c.box.email),
          tagMap,
        )
      : [],
    placementChecked: placement ? placement.size : 0,
    untrackedDomains: mailboxes.filter((m) => !m.domain).length,
    stats,
  };
}
