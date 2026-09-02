import { useMemo, useState, Fragment } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  // Aliased: this file already has its own `Bar` for the capacity meters.
  Bar as RechartsBar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import {
  Target,
  RefreshCw,
  Plug,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  Inbox,
  Zap,
  Ban,
  Flame,
  HeartPulse,
  Activity,
} from "lucide-react";
import { Card, StatCard, Badge, Spinner, ProgressBar, EmptyState } from "../components/ui/primitives";
import { useToast } from "../components/ui/toast";
import { useCollection, useInsert, useSettings, useSaveSettings, useUpdate } from "../lib/hooks";
import { AppSettings, CapacitySource, CostItem, Domain, RecoveryEntry, TABLES, MailboxTag, MailProfile, SetupBatch } from "../lib/types";
import { recoveringEmails } from "../lib/recovery";
import { computeCapacity } from "../lib/capacity";
import { computePlan, perUnitMonthly, type PlannerGroup, type HealthScore } from "../lib/campaignPlan";
import { resolveCampaignTags } from "../lib/accountsTag";
import { computeGrowthPlan } from "../lib/growthPlan";
import { aggregateLeadCounts, type LeadStatusCounts } from "../lib/leadStatus";
import { instantly, asItems } from "../lib/instantly";
import {
  batchEmails,
  mergePlacement,
  parseWarmupAnalytics,
  toHealthInput,
  type PlacementMap,
} from "../lib/placement";
import { computeMaintenance, type MailboxHealth } from "../lib/mailboxHealth";
import { rollupAll } from "../lib/inboxPlacement";
import type { InboxTest } from "../lib/types";
import { buildTagMap, mergeTagMaps, normaliseTag, parseTagPayload, tagsFor } from "../lib/tags";
import {
  accountCredentials,
  credsOf,
  groupByImap,
  mergeCredsFromDetail,
  emailsMissingImap,
  hasImapDetail,
  credsFromBatches,
  mergeCredsPreferLive,
  type AccountCreds,
} from "../lib/accountCreds";
import { computeSendingHealth } from "../lib/sendingHealth";
import { parseInboxSends, type InboxSendsResult } from "../lib/inboxSends";
import { CampaignMaintenance } from "../components/planner/CampaignMaintenance";
import { AutopopulatePanel } from "../components/planner/AutopopulatePanel";
import { AccountsTab } from "../components/planner/AccountsTab";
import { CampaignMailboxTable } from "../components/planner/CampaignMailboxTable";
import { fmtNumber, fmtPercent, fmtMoney, fmtDateShort } from "../lib/format";
import { cn } from "../lib/utils";

// Health bands share the app's badge tones so a score reads the same everywhere.
const HEALTH_TONE: Record<string, "mint" | "sky" | "sun" | "danger" | "white"> = {
  good: "mint",
  fair: "sky",
  "at-risk": "sun",
  critical: "danger",
  unknown: "white",
};

const SEV_TONE: Record<string, "danger" | "sun" | "sky"> = {
  high: "danger",
  medium: "sun",
  low: "sky",
};

/** What actually drove a health score, for the badge's tooltip. */
function healthTitle(h: HealthScore): string {
  const lines = [
    `${h.score}/100 across ${h.mailboxes} mailbox${h.mailboxes === 1 ? "" : "es"}`,
    h.broken ? `${h.broken} not sending (counted as 0)` : "",
    h.unknown ? `${h.unknown} with no warmup score` : "",
    h.weakest ? `weakest: ${h.weakest.email} at ${h.weakest.score}` : "",
    h.worstPlacement
      ? `lowest inbox rate: ${h.worstPlacement.email} at ${Math.round(h.worstPlacement.inboxRate)}%`
      : "",
    h.placementChecked
      ? `placement measured on ${h.placementChecked}`
      : "no placement data — warmup score only",
  ];
  return lines.filter(Boolean).join("\n");
}

export default function Planner() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const saveSettings = useSaveSettings();
  const { data: capacity = [] } = useCollection<CapacitySource>(TABLES.capacity);
  const { data: domains = [] } = useCollection<Domain>(TABLES.domains);
  const { data: costs = [] } = useCollection<CostItem>(TABLES.costs);
  const { data: recovery = [] } = useCollection<RecoveryEntry>(TABLES.recovery);

  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [showMailboxes, setShowMailboxes] = useState(false);
  // Exact per-campaign lead counts, aggregated from the per-lead list on demand.
  // Empty until the operator asks — it's a heavier fetch than the analytics row.
  const [exactCounts, setExactCounts] = useState<Map<string, LeadStatusCounts>>(new Map());
  const [loadingExact, setLoadingExact] = useState(false);
  const [exactProgress, setExactProgress] = useState("");
  const [tab, setTab] = useState<"plan" | "maintenance" | "accounts">("plan");

  // Same keys as the Instantly page and the Sending Health card, so all three
  // share one fetch and the Instantly Refresh button invalidates them.
  // The health signals below (accounts, placement, per-mailbox sends) drive the
  // mailbox Health column. Refetch daily so an always-open tab stays current
  // without a manual refresh; they're already live on each load.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const acctQ = useQuery({
    queryKey: ["inst", "acct"],
    queryFn: () => instantly.accounts(),
    staleTime: 60_000,
    refetchInterval: DAY_MS,
    refetchOnWindowFocus: true,
  });
  const campQ = useQuery({ queryKey: ["inst", "camplist"], queryFn: () => instantly.campaigns(), staleTime: 60_000 });
  const statsQ = useQuery({
    queryKey: ["inst", "camp", "30d"],
    queryFn: () => instantly.campaignAnalytics("30d"),
    staleTime: 60_000,
  });

  // Inbox-vs-spam placement. Derived from the ACCOUNTS payload rather than the
  // plan, because the plan's own health now consumes placement — sourcing it
  // from the plan would be circular.
  const placementEmails = useMemo(() => {
    if (!acctQ.data?.ok) return [] as string[];
    return asItems<Record<string, unknown>>(acctQ.data.data)
      .map((a) => String(a.email ?? "").trim().toLowerCase())
      .filter(Boolean)
      .sort();
  }, [acctQ.data]);

  const placeQ = useQuery({
    // Keyed on the address list so adding a mailbox refetches, and the Refresh
    // button's ["inst"] invalidation still covers it.
    queryKey: ["inst", "placement", placementEmails],
    enabled: placementEmails.length > 0,
    staleTime: 5 * 60_000,
    refetchInterval: DAY_MS,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<PlacementMap> => {
      // The endpoint caps at 100 emails per call. Batches run in sequence to
      // stay polite with the API — 100 mailboxes is one request.
      const maps: PlacementMap[] = [];
      for (const batch of batchEmails(placementEmails)) {
        const res = await instantly.warmup(batch);
        if (res.ok) maps.push(parseWarmupAnalytics(res.data));
      }
      return mergePlacement(maps);
    },
  });

  const placement = placeQ.data ?? null;
  const placementHealthInput = useMemo(
    () => (placement ? toHealthInput(placement) : undefined),
    [placement],
  );
  // Mailboxes with a genuinely measured rate — entries exist for addresses the
  // endpoint returned nothing for, and those must not read as "checked".
  const placementChecked = useMemo(
    () => (placement ? [...placement.values()].filter((p) => p.inboxRate !== null).length : 0),
    [placement],
  );

  const cap = useMemo(
    () => (settings ? computeCapacity(domains, capacity, settings) : null),
    [domains, capacity, settings],
  );

  const plan = useMemo(() => {
    if (!cap || !settings) return null;
    return computePlan({
      accountsData: acctQ.data?.ok ? acctQ.data.data : null,
      campaignsData: campQ.data?.ok ? campQ.data.data : null,
      analyticsData: statsQ.data?.ok ? statsQ.data.data : null,
      cap,
      settings,
      costs,
      placement: placementHealthInput,
      leadCounts: exactCounts.size > 0 ? exactCounts : undefined,
    });
  }, [acctQ.data, campQ.data, statsQ.data, cap, settings, costs, placementHealthInput, exactCounts]);

  // Actual daily sends. Same query key as the Sending Health card, so this
  // shares that cache instead of refetching the series.
  const dailyQ = useQuery({
    queryKey: ["inst", "daily", 30],
    queryFn: () => instantly.analyticsDaily(30),
    staleTime: 60_000,
  });

  // Per-mailbox sends, if this workspace's API reports them at all.
  const inboxQ = useQuery({
    queryKey: ["inst", "acct-analytics", 30],
    queryFn: () => instantly.accountAnalytics(30),
    staleTime: 5 * 60_000,
    refetchInterval: DAY_MS,
    refetchOnWindowFocus: true,
  });

  const sends = useMemo(() => {
    if (!cap || !settings) return null;
    return computeSendingHealth({
      accountsData: acctQ.data?.ok ? acctQ.data.data : null,
      campaignsData: campQ.data?.ok ? campQ.data.data : null,
      dailyData: dailyQ.data?.ok ? dailyQ.data.data : null,
      cap,
      settings,
      days: 30,
      recentDays: 7,
    });
  }, [acctQ.data, campQ.data, dailyQ.data, cap, settings]);

  const inboxSends: InboxSendsResult | null = useMemo(() => {
    if (!inboxQ.data || !settings) return null;
    return parseInboxSends(inboxQ.data.data, {
      supported: inboxQ.data.supported,
      windowDays: 30,
      sendingDaysPerWeek: settings.sending_days_per_week,
    });
  }, [inboxQ.data, settings]);

  // Real per-mailbox sends + bounce, for the health score. Supplied to
  // computeMaintenance only when the workspace actually reports them, so its
  // presence doubles as the "sends are supported" signal (a live-campaign
  // mailbox absent from the map has genuinely sent nothing).
  const mailboxSends = useMemo(() => {
    if (!inboxSends?.supported) return undefined;
    const m = new Map<string, { sentLast30: number; bounced: number; bounceRate: number | null }>();
    for (const [email, s] of inboxSends.byEmail) {
      m.set(email, { sentLast30: s.sentLast30, bounced: s.bounced, bounceRate: s.bounceRate });
    }
    return m;
  }, [inboxSends]);

  // Seed-panel placement (the Inbox Tester ground truth) rolled up per mailbox,
  // fed into health as the top-priority signal when a mailbox has been tested.
  const inboxTestsQ = useCollection<InboxTest>(TABLES.inboxTests);
  const seedPlacement = useMemo(() => {
    const roll = rollupAll(inboxTestsQ.data ?? []);
    const m = new Map<string, { primaryRate: number | null; samples: number; testedAt: string | null }>();
    for (const [email, r] of roll) m.set(email, { primaryRate: r.primaryRate, samples: r.samples, testedAt: r.lastTestedAt });
    return m.size ? m : undefined;
  }, [inboxTestsQ.data]);

  // A mailbox pulled out to heal must not be proposed as the spare for the
  // next campaign, so the recovery list gates the candidate pool.
  const recovering = useMemo(() => recoveringEmails(recovery), [recovery]);

  // Computed once here and shared: the Maintenance tab and the per-campaign
  // Mailbox niches. Built here and passed down so the table, the maintenance
  // tab and the swap decision all read one source.
  const tagRowsQ = useCollection<MailboxTag>(TABLES.mailboxTags);
  // Tags set in Instantly are the source of truth; the app's own table covers
  // workspaces (or mailboxes) Instantly doesn't tag. Union, not precedence.
  const instTagsQ = useQuery({
    queryKey: ["inst", "tags"],
    queryFn: () => instantly.tags(),
    staleTime: 5 * 60_000,
  });
  const tagAssignments = useMemo(
    () => parseTagPayload(instTagsQ.data?.data),
    [instTagsQ.data],
  );
  const tagMap = useMemo(
    () => mergeTagMaps(buildTagMap(tagRowsQ.data ?? []), tagAssignments.byEmail),
    [tagRowsQ.data, tagAssignments],
  );

  // Which IMAP/SMTP each account is on — read from the live accounts payload,
  // never from the (possibly stale) saved profile. Passwords are never fetched.
  const [detailCreds, setDetailCreds] = useState<Map<string, AccountCreds>>(new Map());
  const [loadingImap, setLoadingImap] = useState(false);
  const creds = useMemo(() => {
    // Start from whatever the accounts list carried, then overlay anything the
    // on-demand account-detail fetch has filled in.
    const base = accountCredentials(
      acctQ.data?.ok ? asItems<Record<string, unknown>>(acctQ.data.data) : [],
    );
    let merged = base;
    for (const [email, c] of detailCreds) merged = mergeCredsFromDetail(merged, email, { imap_host: c.imapHost, imap_username: c.imapUsername, imap_port: c.imapPort, smtp_host: c.smtpHost, smtp_username: c.smtpUsername, smtp_port: c.smtpPort });
    return merged;
  }, [acctQ.data, detailCreds]);
  // The setup log as a second creds source: which credential profile created
  // each mailbox tells us the IMAP/SMTP it was born with, for accounts whose
  // live payload omits it. mail_profiles is gated behind APP_FUNCTION_TOKEN, so
  // it may 403 — retry:false keeps that from spamming, and we degrade to live.
  const batchesQ = useCollection<SetupBatch>(TABLES.setupBatches);
  const profilesQ = useCollection<MailProfile>(TABLES.mailProfiles, { retry: false });
  const profilesById = useMemo(
    () => new Map((profilesQ.data ?? []).map((p) => [p.id, p])),
    [profilesQ.data],
  );
  const logCreds = useMemo(
    () => credsFromBatches(batchesQ.data ?? [], profilesById),
    [batchesQ.data, profilesById],
  );
  // Live wins per field; the setup log fills gaps. Labelled per account so a
  // mailbox whose IMAP was changed in Instantly reads as live, not stale.
  const credsByEmail = useMemo(() => mergeCredsPreferLive(creds, logCreds), [creds, logCreds]);
  const imapGroups = useMemo(
    () => groupByImap(new Map([...credsByEmail].map(([e, v]) => [e, v.creds]))),
    [credsByEmail],
  );
  // Raw account JSON, so the tab's expander can reveal any IMAP key the mapper
  // doesn't yet catch (passwords are already scrubbed server-side).
  const rawAccountsByEmail = useMemo(() => {
    const m = new Map<string, Record<string, unknown>>();
    if (acctQ.data?.ok) {
      for (const a of asItems<Record<string, unknown>>(acctQ.data.data)) {
        const e = String(a.email ?? "").trim().toLowerCase();
        if (e) m.set(e, a);
      }
    }
    return m;
  }, [acctQ.data]);

  // When the list didn't carry IMAP, fetch it per account (scrubbed) on demand.
  async function loadImapDetails() {
    setLoadingImap(true);
    const filled = new Map(detailCreds);
    for (const email of emailsMissingImap(creds)) {
      const res = await instantly.accountDetail(email);
      if (res.ok && res.data) {
        const c = credsOf(res.data as Record<string, unknown>);
        if (c.imapHost || c.imapUsername) filled.set(email.toLowerCase(), c);
      }
    }
    setDetailCreds(filled);
    setLoadingImap(false);
  }

  // Count each active campaign's leads directly from the per-lead list — the
  // exact Completed / contacted / not-yet-contacted figures Instantly shows,
  // overriding the analytics row (whose cumulative counter can overshoot).
  async function loadExactCounts() {
    const active = (plan?.campaigns ?? []).filter((c) => c.active && c.id);
    if (active.length === 0) {
      toast.push("No active campaigns to count", "info");
      return;
    }
    setLoadingExact(true);
    const next = new Map<string, LeadStatusCounts>();
    let done = 0;
    for (const c of active) {
      setExactProgress(`${done}/${active.length}`);
      try {
        const res = await instantly.workspaceLeads(c.id);
        if (res.ok && res.data) {
          next.set(c.id, aggregateLeadCounts(asItems<{ status?: number; contacted?: boolean }>(res.data)));
        }
      } catch {
        // Skip a campaign that failed; the rest still get exact counts.
      }
      done++;
    }
    setExactProgress("");
    setLoadingExact(false);
    setExactCounts(next);
    toast.push(
      next.size > 0
        ? `Exact lead counts loaded for ${next.size} campaign${next.size === 1 ? "" : "s"}`
        : "Couldn't load exact counts",
      next.size > 0 ? "success" : "error",
    );
  }

  const insertTag = useInsert<MailboxTag>(TABLES.mailboxTags);
  const updateTag = useUpdate<MailboxTag>(TABLES.mailboxTags);

  // mailbox breakdown must never disagree about an address.
  const maintenance = useMemo(() => {
    if (!plan || !settings) return null;
    return computeMaintenance({
      plan,
      domains,
      settings,
      placement: placementHealthInput,
      recovering,
      // Real per-mailbox sends/bounce — flags a burned inbox even when its
      // warmup score reads a flat 100.
      sends: mailboxSends,
      // Seed-panel Primary-inbox rate — the ground truth, when tested.
      seedPlacement,
      // Supplying this at all turns niche gating on, so the tab refuses
      // cross-niche swaps exactly as the cron does.
      tagMap,
      campaignTagsById: tagAssignments.byCampaign,
    });
  }, [plan, domains, settings, placementHealthInput, recovering, mailboxSends, seedPlacement, tagMap, tagAssignments]);

  // The growth calculator: sizes the whole fleet (campaigns, sending inboxes,
  // per-niche spares, domains) for the goal, against what already exists. The
  // niches and current spare counts come from the tag system; the rest are
  // plain plan totals fed into the pure computeGrowthPlan.
  const growth = useMemo(() => {
    if (!plan || !settings) return null;
    const activeCamps = plan.campaigns.filter((c) => c.active);
    const resolvedCamps = resolveCampaignTags(
      activeCamps,
      settings.campaign_group_overrides ?? {},
      tagAssignments.byCampaign,
    );
    const niches = [...new Set(resolvedCamps.flatMap((c) => c.tags))];
    // A healthy spare tagged AEO counts toward the AEO buffer; untagged spares
    // count toward no niche (they can't be swapped anywhere until tagged).
    const currentSparesByNiche: Record<string, number> = {};
    for (const cand of maintenance?.candidates ?? []) {
      for (const t of tagsFor(tagMap, cand.box.email)) {
        currentSparesByNiche[t] = (currentSparesByNiche[t] ?? 0) + 1;
      }
    }
    return computeGrowthPlan({
      goalPerDay: plan.goal.emailsPerDay,
      perCampaignLimit: Math.max(0, settings.planner_per_campaign_limit ?? 200),
      perMailboxLimit: plan.perBoxCap,
      mailboxesPerDomain: Math.max(1, settings.emails_per_domain || 1),
      sparesPerNiche: Math.max(0, settings.planner_spares_per_niche ?? 2),
      niches,
      currentSparesByNiche,
      activeCampaigns: activeCamps.length,
      configuredDemand: plan.totalDemand,
      usableInboxes: plan.usableInboxes,
      currentSupply: plan.totalSupply,
      providerCeiling: plan.goal.providerCeiling,
      costPerDomainMonthly: perUnitMonthly(costs, "Domains"),
      costPerMailboxMonthly: perUnitMonthly(costs, "Email Infrastructure"),
    });
  }, [plan, settings, tagMap, tagAssignments, maintenance, costs]);

  const healthByEmail = useMemo(() => {
    const m = new Map<string, MailboxHealth>();
    for (const h of maintenance?.mailboxes ?? []) m.set(h.box.email, h);
    return m;
  }, [maintenance]);

  const queries = [acctQ, campQ, statsQ];
  const notConfigured = queries.some((q) => q.data?.configured === false);
  const loading = queries.some((q) => q.isLoading);
  const allFailed = queries.every((q) => q.data && !q.data.ok);
  // Everything the Health column is computed from — so the Refresh button spins
  // until the real health signals (accounts, placement, per-mailbox bounce) have
  // actually re-pulled, not just the first three.
  const healthFetching = [acctQ, campQ, statsQ, placeQ, inboxQ].some((q) => q.isFetching);

  function refresh() {
    qc.invalidateQueries({ queryKey: ["inst"] });
    toast.push("Re-pulling live accounts, placement and bounce data…", "info");
  }

  async function patchSettings(patch: Partial<AppSettings>) {
    if (!settings) return;
    await saveSettings.mutateAsync({ ...settings, ...patch });
  }

  /**
   * Set a mailbox's niche. Comma-separated for the rare address that genuinely
   * serves two, and blank clears it — which makes it swap-ineligible again, so
   * the toast says so rather than looking like nothing happened.
   */
  async function saveTag(email: string, raw: string) {
    const tags = raw.split(",").map(normaliseTag).filter(Boolean);
    const existing = (tagRowsQ.data ?? []).find(
      (r) => (r.email ?? "").trim().toLowerCase() === email.trim().toLowerCase(),
    );
    if (JSON.stringify(tags) === JSON.stringify(tagsFor(tagMap, email))) return;
    try {
      if (existing) await updateTag.mutateAsync({ id: existing.id, patch: { tags, source: "manual" } });
      else await insertTag.mutateAsync({ email, tags, source: "manual" } as Partial<MailboxTag>);
      toast.push(
        tags.length > 0
          ? `${email} tagged ${tags.join(", ")}`
          : `${email} untagged — it can't be swapped into any campaign now`,
        tags.length > 0 ? "success" : "info",
      );
    } catch (err) {
      toast.push(
        `Couldn't save that tag: ${err instanceof Error ? err.message : "unknown error"}`,
        "error",
      );
    }
  }

  /**
   * Count a mailbox, or stop counting it everywhere in the planner.
   *
   * Normalises to lowercase because every reader does the same
   * (campaignPlan.ts, sendingHealth.ts) — storing a mixed-case address here
   * would write an entry that nothing ever matches, and the box would appear
   * to do nothing.
   */
  async function toggleExclude(email: string) {
    if (!settings) {
      toast.push("Settings haven't loaded yet — try again in a moment", "error");
      return;
    }
    const key = email.trim().toLowerCase();
    const cur = (settings.excluded_mailboxes ?? []).map((e) => e.trim().toLowerCase());
    const removing = cur.includes(key);
    const next = removing ? cur.filter((e) => e !== key) : [...cur, key];
    try {
      await patchSettings({ excluded_mailboxes: next });
      toast.push(
        removing ? `${key} counted again` : `${key} excluded from all planning`,
        "success",
      );
    } catch (err) {
      // Previously this was fire-and-forget, so a failed save looked exactly
      // like a checkbox that refuses to move.
      toast.push(
        `Couldn't save that: ${err instanceof Error ? err.message : "unknown error"}`,
        "error",
      );
    }
  }

  function toggleGroup(key: string) {
    setOpenGroups((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  const currency = settings?.currency ?? "USD";

  const header = (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl border-2 border-ink bg-pink shadow-hard-sm">
          <Target size={18} />
        </span>
        <div>
          <h2 className="text-lg leading-none">Campaign planner</h2>
          <p className="text-xs text-muted">What each campaign group needs to hit its limits</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Link to="/instantly" className="btn-ghost btn-sm">
          Instantly
        </Link>
        <button
          className="btn-primary btn-sm"
          onClick={refresh}
          disabled={healthFetching}
          title="Re-pull live Instantly data now and recompute the mailbox Health column"
        >
          <RefreshCw size={14} className={healthFetching ? "animate-spin" : ""} />{" "}
          {healthFetching ? "Refreshing…" : "Refresh health"}
        </button>
      </div>
    </Card>
  );

  if (!settings || !cap) return null;

  if (loading) {
    return (
      <div className="space-y-5">
        {header}
        <Card className="p-8">
          <Spinner label="Loading campaigns and mailboxes…" />
        </Card>
      </div>
    );
  }

  if (notConfigured || allFailed || !plan) {
    const err = queries.find((q) => q.data && !q.data.ok)?.data?.error;
    return (
      <div className="space-y-5">
        {header}
        <Card className="p-6">
          <EmptyState
            icon={<Plug size={32} />}
            title={notConfigured ? "Connect Instantly" : "Live data unavailable"}
            description={
              notConfigured
                ? "The planner reads your campaigns, their daily limits and the mailboxes attached to each one straight from Instantly."
                : err ?? "Couldn't reach Instantly right now."
            }
            action={
              <Link to="/instantly" className="btn-primary btn-sm">
                Open Instantly
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const p = plan;
  const gapTone = p.totalGap > 0 ? "danger" : "mint";
  const activeCampaignCount = p.campaigns.filter((c) => c.active).length;
  // Instantly links campaigns to mailboxes by address (email_list); resolve the
  // ids back to names so the mailbox table can name the campaigns it serves.
  const campaignName = new Map(p.campaigns.map((c) => [c.id, c.name]));

  return (
    <div className="space-y-5">
      {header}

      {!p.linkageAvailable ? (
        <Card className="flex items-start gap-2 bg-sun/30 p-4 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p>
            Instantly didn't return the mailbox list attached to each campaign (<code>email_list</code>),
            so per-campaign supply can't be calculated. Totals and the goal planner below are still
            accurate. Check <b>Instantly → Raw API data</b> to confirm the field name.
          </p>
        </Card>
      ) : null}

      {p.truncated ? (
        <Card className="flex items-start gap-2 bg-danger/15 p-4 text-sm font-semibold">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          Instantly returned more records than could be paged in time — these totals are a floor.
        </Card>
      ) : null}

      <div className="flex rounded-xl border-2 border-ink">
        {([["plan", "Plan"], ["maintenance", "Maintenance"], ["accounts", "Accounts"]] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              "px-4 py-2 text-sm font-bold first:rounded-l-lg last:rounded-r-lg",
              tab === k ? "bg-ink text-paper" : "bg-paper hover:bg-canvas",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "maintenance" ? (
        <CampaignMaintenance
          plan={p}
          maintenance={maintenance}
          settings={settings}
          placement={placement}
          placementChecked={placementChecked}
          placementLoading={placeQ.isLoading}
          recovery={recovery}
          healthByEmail={healthByEmail}
          onApplied={refresh}
          onExclude={(email) => void toggleExclude(email)}
          tagMap={tagMap}
          campaignTagsById={tagAssignments.byCampaign}
          overrides={settings.campaign_group_overrides ?? {}}
          recovering={recovering}
        />
      ) : tab === "accounts" ? (
        <AccountsTab
          emails={placementEmails}
          campaigns={p.campaigns}
          overrides={settings?.campaign_group_overrides ?? {}}
          instantlyTagsByEmail={tagAssignments.byEmail}
          instantlyTagsByCampaign={tagAssignments.byCampaign}
          allInstantlyTags={tagAssignments.all}
          onPatchSettings={patchSettings}
          credsByEmail={credsByEmail}
          rawAccountsByEmail={rawAccountsByEmail}
          onLoadImap={() => void loadImapDetails()}
          loadingImap={loadingImap}
          canLoadImap={!hasImapDetail(creds) || emailsMissingImap(creds).length > 0}
        />
      ) : (
      <>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Campaign demand / day"
          value={fmtNumber(p.totalDemand)}
          sublabel={`${p.campaigns.filter((c) => c.active).length} active campaigns`}
          tone="pink"
          icon={<Zap size={18} />}
        />
        <StatCard
          label="Mailbox supply / day"
          value={fmtNumber(p.totalSupply)}
          sublabel={`${p.usableInboxes} inboxes × ${fmtNumber(p.perBoxCap)}/day`}
          tone="sky"
          icon={<Inbox size={18} />}
        />
        <StatCard
          label={p.totalGap > 0 ? "Short by / day" : "Spare / day"}
          value={fmtNumber(Math.abs(p.totalGap))}
          sublabel={p.totalGap > 0 ? "add inboxes to close it" : "room to raise limits"}
          tone={gapTone}
          icon={<Target size={18} />}
        />
        <StatCard
          label="Campaign health"
          value={p.health.band === "unknown" ? "—" : String(p.health.score)}
          sublabel={p.health.note}
          tone={HEALTH_TONE[p.health.band]}
          icon={<HeartPulse size={18} />}
        />
        <StatCard
          label="Today's real supply"
          value={fmtNumber(p.warmupAdjustedSupply)}
          sublabel={`${p.mailboxes.filter((b) => b.warmingUp).length} still warming · ${p.excludedCount} excluded`}
          tone="lavender"
          icon={<Flame size={18} />}
        />
      </div>

      {/* How many inboxes are actually in play */}
      <Card className="p-5">
        <h3 className="mb-1 flex items-center gap-2 text-lg">
          <Inbox size={18} /> Inboxes in use
        </h3>
        <p className="mb-3 text-xs text-muted">
          Instantly has {p.connectedInboxes} active inbox{p.connectedInboxes === 1 ? "" : "es"}
          {p.attachedInboxes > 0 ? `, ${p.attachedInboxes} attached to a running campaign` : ""}. If
          you only send from some of them, set the number here and the planner will ignore the rest.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <p className="label">Inboxes I'm using</p>
            <input
              type="number"
              min={0}
              max={p.connectedInboxes}
              className="input w-28"
              defaultValue={p.activeInboxCount || ""}
              placeholder={`All (${p.connectedInboxes})`}
              key={p.activeInboxCount}
              onBlur={(e) =>
                void patchSettings({ planner_active_inbox_count: Math.max(0, Number(e.target.value) || 0) })
              }
            />
          </div>
          <button
            className="btn-ghost btn-sm"
            onClick={() => void patchSettings({ planner_active_inbox_count: 0 })}
          >
            Use all {p.connectedInboxes}
          </button>
          {p.attachedInboxes > 0 && p.attachedInboxes < p.connectedInboxes ? (
            <button
              className="btn-ghost btn-sm"
              onClick={() => void patchSettings({ planner_active_inbox_count: p.attachedInboxes })}
            >
              Only campaign-attached ({p.attachedInboxes})
            </button>
          ) : null}
        </div>
        <p className="mt-3 rounded-xl border-2 border-ink bg-canvas p-3 text-sm">
          {p.activeInboxCount > 0 ? (
            <>
              Counting <span className="font-extrabold">{p.usableInboxes}</span> of{" "}
              {p.connectedInboxes} inboxes
              {p.beyondCountInboxes > 0 ? ` — ${p.beyondCountInboxes} ignored` : ""}
              {p.excludedCount > 0 ? ` · ${p.excludedCount} excluded by hand` : ""}. Kept the ones
              attached to running campaigns first.
            </>
          ) : (
            <>
              Counting all <span className="font-extrabold">{p.usableInboxes}</span> connected inbox
              {p.usableInboxes === 1 ? "" : "es"}
              {p.excludedCount > 0 ? ` (${p.excludedCount} excluded by hand)` : ""}.
            </>
          )}{" "}
          Untick individual mailboxes below for exact control.
        </p>
      </Card>

      {/* Growth calculator */}
      <Card className="p-5">
        <h3 className="mb-1 flex items-center gap-2 text-lg">
          <Target size={18} /> Growth calculator
        </h3>
        <p className="mb-3 text-xs text-muted">
          Size the whole fleet for your daily goal against what you already run — campaigns,
          sending inboxes, per-niche spares, and the domains to host them.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <p className="label">I want to</p>
            <div className="flex rounded-xl border-2 border-ink">
              {(["emails", "leads"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => void patchSettings({ planner_goal_kind: k })}
                  className={cn(
                    "px-3 py-1.5 text-xs font-bold first:rounded-l-lg last:rounded-r-lg",
                    p.goal.kind === k ? "bg-ink text-paper" : "bg-paper hover:bg-canvas",
                  )}
                >
                  {k === "emails" ? "Send emails / day" : "Contact leads / day"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="label">{p.goal.kind === "leads" ? "Leads / day" : "Emails / day"}</p>
            <input
              type="number"
              min={0}
              className="input w-28"
              defaultValue={p.goal.value}
              onBlur={(e) => void patchSettings({ planner_goal_value: Number(e.target.value) || 0 })}
            />
          </div>
          <div>
            <p className="label">Limit / campaign</p>
            <input
              type="number"
              min={0}
              className="input w-28"
              defaultValue={settings.planner_per_campaign_limit}
              onBlur={(e) => void patchSettings({ planner_per_campaign_limit: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>
          <div>
            <p className="label">Inboxes / domain</p>
            <input
              type="number"
              min={1}
              max={3}
              className="input w-24"
              defaultValue={settings.emails_per_domain}
              onBlur={(e) => void patchSettings({ emails_per_domain: Math.min(3, Math.max(1, Number(e.target.value) || 1)) })}
            />
          </div>
          <div>
            <p className="label">Spares / niche</p>
            <input
              type="number"
              min={0}
              className="input w-24"
              defaultValue={settings.planner_spares_per_niche}
              onBlur={(e) => void patchSettings({ planner_spares_per_niche: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>
        </div>

        {p.goal.value <= 0 || !growth ? (
          <div className="mt-4 rounded-xl border-2 border-ink bg-pink/20 p-4 text-sm">
            Enter a goal to size the campaigns, inboxes, spares and domains you'd need.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="rounded-xl border-2 border-ink bg-pink/20 p-4 text-sm">
              To send <b>{fmtNumber(growth.goalPerDay)} emails/day</b>
              {p.goal.kind === "leads" ? <> (~{fmtNumber(p.goal.newLeadsPerDay)} new leads/day)</> : null}: your{" "}
              <b>{activeCampaignCount}</b> active campaign{activeCampaignCount === 1 ? "" : "s"} allow{" "}
              <b>{fmtNumber(p.totalDemand)}/day</b> →{" "}
              {growth.demandGap > 0 ? (
                <span className="font-extrabold">{fmtNumber(growth.demandGap)} more emails/day needed</span>
              ) : (
                <span className="font-extrabold">already configured for the goal</span>
              )}
              .
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                label="Campaigns"
                value={growth.campaignsRequired}
                sublabel={growth.campaignsToAdd > 0 ? `add ${growth.campaignsToAdd} (have ${activeCampaignCount})` : "you have enough"}
                tone="pink"
              />
              <StatCard
                label="Sending inboxes"
                value={growth.sendingMailboxesRequired}
                sublabel={`at ${fmtNumber(p.perBoxCap)}/day each`}
                tone="sky"
              />
              <StatCard
                label="Inboxes to add"
                value={growth.mailboxesToAdd}
                sublabel={
                  growth.mailboxesToAdd > 0
                    ? `~${growth.domainsToAdd} domain${growth.domainsToAdd === 1 ? "" : "s"} @ ${settings.emails_per_domain}/domain`
                    : "your fleet is enough"
                }
                tone="mint"
              />
              <StatCard
                label="Healthy spares"
                value={growth.spareMailboxesRequired}
                sublabel={growth.spareShortfall > 0 ? `${growth.spareShortfall} more to tag` : "buffer met"}
                tone="sun"
              />
            </div>

            {growth.spares.length > 0 ? (
              <div className="overflow-hidden rounded-xl border-2 border-ink">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                      <th className="px-3 py-2">Niche</th>
                      <th className="w-28 px-3 py-2">Healthy spares</th>
                      <th className="w-20 px-3 py-2">Keep</th>
                      <th className="w-20 px-3 py-2">Add</th>
                    </tr>
                  </thead>
                  <tbody>
                    {growth.spares.map((s) => (
                      <tr key={s.niche} className="border-b border-ink/10">
                        <td className="px-3 py-2"><Badge tone="sky">{s.niche}</Badge></td>
                        <td className="px-3 py-2">{s.current}</td>
                        <td className="px-3 py-2">{s.target}</td>
                        <td className="px-3 py-2">
                          {s.shortfall > 0 ? <b className="text-danger">+{s.shortfall}</b> : <span className="text-muted">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-ink/10 px-3 py-2 text-[11px] text-muted">
                  A spare only replaces a mailbox in a campaign of its own niche, so keep a buffer
                  per niche. Tag spares on the <b>Accounts</b> tab; untagged spares count for none.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted">
                No campaign niches yet — tag your campaigns (Accounts tab) to size a per-niche spare buffer.
              </p>
            )}

            <p className="text-xs text-muted">
              {growth.mailboxesToAdd > 0 && growth.monthlyCostAdd !== null
                ? `Adding ${growth.mailboxesToAdd} inboxes across ${growth.domainsToAdd} domains ≈ ${fmtMoney(growth.monthlyCostAdd, currency)}/mo more. `
                : ""}
              {growth.mailboxesToAdd > 0 ? `New inboxes need roughly ${p.goal.daysToReady} days of warmup first. ` : ""}
              {settings.emails_per_domain > 2
                ? "Note: domain records store 2 mailbox slots today, so 3/domain is a planning target. "
                : ""}
              {growth.providerOk
                ? `Provider caps allow it${growth.providerCeiling > 0 ? ` (ceiling ${fmtNumber(growth.providerCeiling)}/day)` : ""}.`
                : `⚠ This exceeds your provider ceiling of ${fmtNumber(growth.providerCeiling)}/day — raise the plan or SES limit too.`}
              {growth.supplyGap > 0
                ? ` Your mailboxes currently supply ${fmtNumber(p.totalSupply)}/day — ${fmtNumber(growth.supplyGap)}/day short of the goal even before adding campaigns.`
                : ""}
            </p>
          </div>
        )}
      </Card>

      {/* Actions */}
      {p.actions.length > 0 ? (
        <Card className="p-5">
          <h3 className="mb-3 text-lg">Do this next</h3>
          <div className="space-y-2">
            {p.actions.slice(0, 8).map((a, i) => (
              <div key={i} className="rounded-xl border-2 border-ink bg-white p-3">
                <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  <Badge tone={SEV_TONE[a.severity]}>{a.severity}</Badge>
                  {a.title}
                </p>
                <p className="mt-1 text-xs text-muted">{a.detail}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* Groups */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b-2 border-ink p-4">
          <div>
            <h3 className="text-lg">Campaign groups</h3>
            <p className="text-xs text-muted">
              Grouped by the first word of the campaign name. Supply is split when a mailbox runs in
              more than one campaign, so shared inboxes aren't counted twice.
            </p>
          </div>
          <button
            className="btn-ghost btn-sm"
            onClick={() => void loadExactCounts()}
            disabled={loadingExact}
            title="Count each campaign's leads directly from Instantly (Completed / contacted / not-yet-contacted) — the exact figures Instantly shows"
          >
            {loadingExact ? <Spinner /> : <RefreshCw size={14} />}
            {loadingExact ? `Counting ${exactProgress}…` : "Load exact lead counts"}
          </button>
        </div>
        {p.groups.length === 0 ? (
          <p className="p-6 text-sm text-muted">No campaigns found in Instantly.</p>
        ) : (
          <div className="divide-y-2 divide-ink/10">
            {p.groups.map((g) => (
              <GroupRow
                key={g.key}
                g={g}
                open={openGroups.has(g.key)}
                onToggle={() => toggleGroup(g.key)}
                healthByEmail={healthByEmail}
                placement={placement}
                perBoxCap={p.perBoxCap}
                canLoadExact={exactCounts.size === 0}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Fill campaigns short of their daily limit with matching-niche idle
          inboxes, and keep a log of exactly what was populated. */}
      <AutopopulatePanel
        plan={p}
        tagMap={tagMap}
        campaignTagsById={tagAssignments.byCampaign}
        overrides={settings.campaign_group_overrides ?? {}}
        healthByEmail={healthByEmail}
        onApplied={refresh}
      />

      {/* What actually went out, against what the mailboxes could carry. */}
      {sends ? (
        <Card className="p-5">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-lg">
              <Activity size={18} /> Actual sends — last 7 days
            </h3>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge tone="white">{fmtNumber(sends.liveMailboxDaily)}/day capacity</Badge>
              <Badge tone={sends.avgPerSendingDayRecent > 0 ? "sky" : "sun"}>
                {fmtNumber(sends.avgPerSendingDayRecent)}/day actual
              </Badge>
              <Badge tone="lavender">{fmtNumber(sends.sentRecent)} sent in the window</Badge>
            </div>
          </div>
          <p className="mb-3 text-xs text-muted">
            Real campaign sends from Instantly — warmup email isn't counted. The dashed line is
            total mailbox capacity ({fmtNumber(sends.liveMailboxDaily)}/day). Today is still in
            progress, so it's excluded from the average.
          </p>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={sends.days.slice(-8).map((d) => ({ ...d, label: fmtDateShort(d.date) }))}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fontWeight: 700 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fontWeight: 700 }} width={44} />
                <Tooltip formatter={(v: number) => [`${fmtNumber(v)} sent`, "Emails"]} />
                {sends.liveMailboxDaily > 0 ? (
                  <ReferenceLine
                    y={sends.liveMailboxDaily}
                    stroke="#E03131"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                  />
                ) : null}
                <RechartsBar dataKey="sent" radius={[6, 6, 0, 0]}>
                  {sends.days.slice(-8).map((d) => (
                    <Cell key={d.date} fill={d.isToday ? "#9DB4FF" : "#3F6BFF"} />
                  ))}
                </RechartsBar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ) : null}

      {/* Accounts grouped by the IMAP login they share — so you can see which
          inboxes are on which mailbox, at a glance, after changing an IMAP. */}
      {imapGroups.length > 0 ? (
        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink p-4">
            <div>
              <h3 className="text-base font-extrabold">Accounts by IMAP</h3>
              <p className="mt-0.5 text-xs text-muted">
                Which login each inbox is on — live from Instantly, filled from your setup log where the
                API doesn't report it. Passwords are never shown.
              </p>
            </div>
            {!hasImapDetail(creds) || emailsMissingImap(creds).length > 0 ? (
              <button className="btn-ghost btn-sm" onClick={() => void loadImapDetails()} disabled={loadingImap}>
                {loadingImap ? <Spinner /> : <RefreshCw size={14} />} Load IMAP details
              </button>
            ) : null}
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                  <th className="px-3 py-2">IMAP login</th>
                  <th className="w-20 px-3 py-2">Inboxes</th>
                  <th className="px-3 py-2">Addresses</th>
                </tr>
              </thead>
              <tbody>
                {imapGroups.map((g) => (
                  <tr key={g.identity} className="border-b border-ink/10 align-top">
                    <td className="px-3 py-2 font-semibold">{g.identity}</td>
                    <td className="px-3 py-2 text-muted">{g.emails.length}</td>
                    <td className="px-3 py-2 text-[11px] text-muted">
                      <span className="break-words">{g.emails.join(", ")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* Mailboxes */}
      <Card className="overflow-hidden p-0">
        <button
          className="flex w-full items-center justify-between border-b-2 border-ink p-4 text-left"
          onClick={() => setShowMailboxes((v) => !v)}
        >
          <div>
            <h3 className="text-lg">Mailboxes ({p.mailboxes.length})</h3>
            <p className="text-xs text-muted">
              {p.idleMailboxes.length} idle · {p.excludedCount} excluded — untick to stop counting a
              mailbox everywhere in the planner
            </p>
          </div>
          {showMailboxes ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
        {showMailboxes ? (
          <div className="max-h-96 overflow-auto">
            {inboxSends && !inboxSends.supported ? (
              <p className="border-b border-ink/10 bg-sun/20 px-3 py-2 text-[11px]">
                <b>Sending &amp; per-mailbox bounce show n/a:</b> {inboxSends.reason} Without real
                bounce data, <b>Health</b> reads <b>“—” (unverified)</b> for inboxes that show no
                other problem — a flat warmup score and warmup-network placement can’t prove real
                inbox placement, so the tool won’t fake a green score. Provably-bad inboxes (spam
                placement, broken, stalled, expired domain) still score red/amber.
              </p>
            ) : null}
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                  <th className="w-12 px-3 py-2">Use</th>
                  <th className="px-3 py-2">Mailbox</th>
                  <th className="w-24 px-3 py-2" title="Composite deliverability score — bounce rate, inbox placement and account status, not the warmup number">
                    Health
                  </th>
                  <th className="w-20 px-3 py-2">Limit</th>
                  <th className="w-28 px-3 py-2">Sending</th>
                  <th className="w-24 px-3 py-2">Last used</th>
                  <th className="px-3 py-2">Campaigns</th>
                  <th className="px-3 py-2">IMAP</th>
                  <th className="w-28 px-3 py-2">Niche</th>
                  <th className="w-28 px-3 py-2">State</th>
                </tr>
              </thead>
              <tbody>
                {/* Rows dim with text colour, not opacity: opacity creates a
                    stacking context its children can't climb back out of, so
                    the old row-level opacity-50 dragged the checkbox down with
                    it and made a live control look permanently disabled. */}
                {p.mailboxes.map((b) => (
                  <tr
                    key={b.email}
                    className={cn(
                      "border-b border-ink/10",
                      (b.excluded || b.beyondCount) && "text-ink/40",
                    )}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-ink"
                        checked={!b.excluded}
                        disabled={!settings}
                        onChange={() => void toggleExclude(b.email)}
                        title={
                          !settings
                            ? "Waiting for settings to load…"
                            : b.excluded
                              ? "Excluded from all planning — click to count it again"
                              : "Counted — click to exclude it everywhere"
                        }
                      />
                    </td>
                    <td className="truncate px-3 py-2 font-semibold">{b.email}</td>
                    {/* Composite real-health score — bounce/placement/status, not
                        the warmup number. Reasons on hover; "—" when there isn't
                        enough real signal yet. */}
                    <td className="px-3 py-2">
                      {(() => {
                        const h = healthByEmail.get(b.email);
                        if (!h || h.healthScore === null) {
                          return (
                            <span
                              className="text-muted"
                              title={
                                h && h.healthReasons.length
                                  ? h.healthReasons.join(" · ")
                                  : "Not enough real deliverability data yet"
                              }
                            >
                              —
                            </span>
                          );
                        }
                        const tone =
                          h.healthBand === "good"
                            ? "mint"
                            : h.healthBand === "watch"
                              ? "sky"
                              : h.healthBand === "warn"
                                ? "sun"
                                : "danger";
                        return (
                          <span title={h.healthReasons.join(" · ") || undefined}>
                            <Badge tone={tone}>{h.healthScore}</Badge>
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2">{fmtNumber(b.dailyLimit)}</td>
                    {/* Real measured sends, or nothing. Never a share of a
                        campaign total dressed up as a per-inbox figure. */}
                    <td className="px-3 py-2">
                      {inboxSends?.supported ? (
                        (() => {
                          const s = inboxSends.byEmail.get(b.email);
                          if (!s || s.sentLast30 === 0) return <span className="text-muted">0</span>;
                          const pct = b.dailyLimit > 0 ? (s.sentPerDay / b.dailyLimit) * 100 : 0;
                          return (
                            <>
                              <span className="font-bold">{fmtNumber(s.sentPerDay)}/day</span>
                              {b.dailyLimit > 0 ? (
                                <p className={cn("text-[11px]", pct < 50 ? "text-danger" : "text-muted")}>
                                  {fmtPercent(pct)} of limit
                                </p>
                              ) : null}
                            </>
                          );
                        })()
                      ) : (
                        <span className="text-muted" title="Not reported by Instantly">
                          n/a
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {b.lastUsedAt ? fmtDateShort(b.lastUsedAt) : "never"}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {b.allCampaignIds.length === 0 ? (
                        <span className="text-muted">not in any campaign</span>
                      ) : (
                        <span
                          className="line-clamp-2"
                          title={b.allCampaignIds.map((id) => campaignName.get(id) ?? id).join("\n")}
                        >
                          {b.allCampaignIds.map((id) => campaignName.get(id) ?? id).join(", ")}
                          {b.pausedOnly ? " (paused)" : ""}
                        </span>
                      )}
                    </td>
                    {/* Live IMAP/SMTP identity — which login this account is on,
                        so a changed IMAP is visible per account. No password. */}
                    <td className="px-3 py-2 text-xs">
                      {(() => {
                        const cw = credsByEmail.get(b.email.toLowerCase());
                        const c = cw?.creds;
                        if (!c || (!c.imapHost && !c.imapUsername)) {
                          return <span className="text-muted">—</span>;
                        }
                        return (
                          <span
                            className="line-clamp-2"
                            title={
                              `IMAP: ${c.imapUsername ?? "?"} @ ${c.imapHost ?? "?"}${c.imapPort ? ":" + c.imapPort : ""}\n` +
                              `SMTP: ${c.smtpUsername ?? "?"} @ ${c.smtpHost ?? "?"}${c.smtpPort ? ":" + c.smtpPort : ""}\n` +
                              `source: ${cw?.source === "live" ? "live Instantly" : "setup log"}`
                            }
                          >
                            {c.imapUsername ?? c.imapHost}
                          </span>
                        );
                      })()}
                    </td>
                    {/* Editable here because a mailbox outlives the batch that
                        made it, and an untagged one is invisible to the swapper
                        until someone fixes it. */}
                    <td className="px-3 py-2">
                      <input
                        className="input h-7 w-24 text-xs"
                        defaultValue={tagsFor(tagMap, b.email).join(", ")}
                        placeholder="untagged"
                        title="Niche tag. Only mailboxes tagged for a campaign's niche can be swapped into it."
                        onBlur={(e) => void saveTag(b.email, e.target.value)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {!b.active ? (
                        <Badge tone="coral">inactive</Badge>
                      ) : b.excluded ? (
                        <Badge tone="white">
                          <Ban size={11} /> excluded
                        </Badge>
                      ) : b.beyondCount ? (
                        <Badge tone="white">not in use</Badge>
                      ) : b.pausedOnly ? (
                        <Badge tone="sky">parked</Badge>
                      ) : b.idle ? (
                        <Badge tone="sun">idle</Badge>
                      ) : b.warmingUp ? (
                        <Badge tone="lavender">warming</Badge>
                      ) : (
                        <Badge tone="mint">sending</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      </>
      )}
    </div>
  );
}

function GroupRow({
  g,
  open,
  onToggle,
  healthByEmail,
  placement,
  perBoxCap,
  canLoadExact,
}: {
  g: PlannerGroup;
  open: boolean;
  onToggle: () => void;
  healthByEmail: Map<string, MailboxHealth>;
  placement: PlacementMap | null;
  /** Most common per-mailbox daily limit — the "× 15/day" in the breakdown. */
  perBoxCap: number;
  /** Whether the "Load exact lead counts" action is available, for the hint. */
  canLoadExact?: boolean;
}) {
  const short = g.gapDaily > 0;
  const max = Math.max(g.demandDaily, g.supplyDaily, 1);
  // Which campaigns have their attached mailbox addresses revealed.
  const [openBoxes, setOpenBoxes] = useState<Set<string>>(new Set());
  const toggleBoxes = (id: string) =>
    setOpenBoxes((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  return (
    <div className={cn(open && "bg-canvas/60")}>
      <button className="flex w-full items-start gap-3 p-4 text-left" onClick={onToggle}>
        <span className="mt-1 shrink-0">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-extrabold">{g.key}</span>
            <Badge tone="white">{g.activeCampaigns} active</Badge>
            <Badge tone={short ? "danger" : "mint"}>
              {short
                ? `short ${fmtNumber(g.gapDaily)}/day`
                : g.surplusDaily > 0
                  ? `${fmtNumber(g.surplusDaily)}/day spare`
                  : "balanced"}
            </Badge>
            {g.health.band !== "unknown" ? (
              <span title={healthTitle(g.health)}>
                <Badge tone={HEALTH_TONE[g.health.band]}>health {g.health.score}</Badge>
              </span>
            ) : null}
            {g.sharedMailboxes > 0 ? (
              <Badge tone="sun">{g.sharedMailboxes} shared inbox{g.sharedMailboxes === 1 ? "" : "es"}</Badge>
            ) : null}
          </div>

          <div className="mt-2 space-y-1.5">
            <Bar label="Campaign limits" value={g.demandDaily} max={max} color="#FF90E8" />
            <Bar label="Mailbox supply" value={g.supplyDaily} max={max} color="#3F6BFF" />
          </div>

          <p className="mt-2 text-xs text-muted">
            {g.mailboxes} mailbox{g.mailboxes === 1 ? "" : "es"} ·{" "}
            {short
              ? `add ${g.inboxesNeeded} inbox${g.inboxesNeeded === 1 ? "" : "es"} (~${g.domainsNeeded} domain${g.domainsNeeded === 1 ? "" : "s"}) to reach ${fmtNumber(g.demandDaily)}/day`
              : "supply covers the configured limits"}
            {g.newLeadsPerDay > 0 ? ` · ${fmtNumber(g.newLeadsPerDay)} new leads/day` : ""}
            {g.daysToFinish !== null && g.daysToFinish > 0
              ? ` · list done in ${Math.round(g.daysToFinish)}d`
              : ""}
          </p>
        </div>
      </button>

      {open ? (
        <div className="overflow-x-auto border-t-2 border-ink/10 px-4 pb-4">
          <table className="w-full min-w-[1160px] border-collapse text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-muted">
                <th className="py-2 pr-3">Campaign</th>
                <th className="w-20 py-2 pr-3">Limit</th>
                <th className="w-20 py-2 pr-3">Supply</th>
                <th className="w-24 py-2 pr-3">Sending</th>
                <th className="w-16 py-2 pr-3">Boxes</th>
                <th className="w-32 py-2 pr-3">Priority</th>
                <th className="w-44 py-2 pr-3">Leads / progress</th>
                <th className="w-20 py-2 pr-3">Health</th>
                <th className="w-24 py-2 pr-3">New leads/day</th>
                <th className="w-36 py-2 pr-3">At full capacity</th>
                <th className="w-36 py-2">At current rate</th>
              </tr>
            </thead>
            <tbody>
              {g.campaigns.map((c) => (
                <Fragment key={c.id}>
                  <tr className="border-t border-ink/10">
                    <td className="py-2 pr-3">
                      <p className="font-bold">{c.name}</p>
                      {!c.active ? <span className="text-xs text-muted">not sending</span> : null}
                    </td>
                    <td className="py-2 pr-3">{c.dailyLimit > 0 ? fmtNumber(c.dailyLimit) : "—"}</td>
                    <td className={cn("py-2 pr-3 font-bold", c.gapDaily > 0 && "text-danger")}>
                      {fmtNumber(c.supplyDaily)}
                    </td>
                    {/* Actual sends, against all the capacity to its left. */}
                    <td className="py-2 pr-3">
                      {c.sentLast30 > 0 ? (
                        <>
                          <p className="font-bold">{fmtNumber(c.sentPerDay)}/day</p>
                          <p className="text-[11px] text-muted">
                            {/* Compared to the campaign's OWN Instantly daily
                                limit — a direct number — not the app's derived
                                fair-share supply, so the ratio is legible. */}
                            {c.dailyLimit > 0
                              ? `${fmtPercent((c.sentPerDay / c.dailyLimit) * 100)} of the ${fmtNumber(c.dailyLimit)} limit`
                              : `${fmtNumber(c.sentLast30)} in 30d`}
                          </p>
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {c.emails.length === 0 ? (
                        <span className="text-muted">0</span>
                      ) : (
                        <button
                          className="font-bold underline decoration-dotted underline-offset-2"
                          onClick={() => toggleBoxes(c.id)}
                          title="Show the exact mailboxes attached to this campaign"
                        >
                          {c.mailboxCount}
                        </button>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {c.prioritizeNewLeads === null ? (
                        <span className="text-xs text-muted">—</span>
                      ) : (
                        <Badge tone={c.prioritizeNewLeads ? "sky" : "lavender"}>
                          {c.prioritizeNewLeads ? "New leads first" : "Follow-ups first"}
                        </Badge>
                      )}
                    </td>
                    {/* Mirrors Instantly's own breakdown: progress = completed
                        ÷ total, and the real not-yet-contacted count as "left".
                        When Instantly returned only the cumulative counter, show
                        contacted with a ≈ and never a false "done". */}
                    <td className="py-2 pr-3">
                      {c.notYetContacted === null ? (
                        <>
                          <div className="flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <ProgressBar value={Math.min(100, c.pctContacted)} max={100} color="#23A094" height={10} />
                            </div>
                            <span className="whitespace-nowrap text-xs text-muted">
                              ≈{fmtNumber(c.leadsContacted)}/{fmtNumber(c.leadsTotal)}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted">
                            per-status counts unavailable{canLoadExact ? " — use Load exact lead counts" : ""}
                          </p>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <ProgressBar value={c.pctComplete ?? 0} max={100} color="#23A094" height={10} />
                            </div>
                            <span className="whitespace-nowrap text-xs font-semibold text-muted">
                              {fmtPercent(c.pctComplete ?? 0)}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted">
                            {fmtNumber(c.leadsCompleted ?? 0)} completed · {fmtNumber(c.notYetContacted)} not yet contacted
                            {c.leadsInProgress ? ` · ${fmtNumber(c.leadsInProgress)} in progress` : ""}
                          </p>
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {c.health.band === "unknown" ? (
                        <span className="text-muted" title={c.health.note}>—</span>
                      ) : (
                        <span title={healthTitle(c.health)}>
                          <Badge tone={HEALTH_TONE[c.health.band]}>{c.health.score}</Badge>
                        </span>
                      )}
                      <p className="mt-0.5 text-[11px] text-muted">{c.health.note}</p>
                    </td>
                    <td className="py-2 pr-3">
                      {c.newLeadsPerDay > 0 ? (
                        <>
                          <p className="font-bold">{fmtNumber(c.newLeadsPerDay)}</p>
                          <p className="text-[11px] text-muted">
                            {c.newLeadRateObserved ? "last 30d actual" : "from campaign settings"}
                          </p>
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    {/* What these mailboxes COULD do, running flat out. This is
                        the planning number: leads x sequence steps, divided by
                        mailbox supply. */}
                    <td className="py-2 pr-3 text-xs">
                      {c.daysAtCapacityCalendar === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <>
                          <Badge tone="mint">
                            {fmtNumber(Math.round(c.daysAtCapacityCalendar))}d
                          </Badge>
                          {c.capacityFinishDate ? (
                            <p className="mt-0.5 text-[11px] text-muted">
                              {fmtDateShort(c.capacityFinishDate)}
                            </p>
                          ) : null}
                          <p className="text-[11px] text-muted">
                            {fmtNumber(c.emailsNeeded)} emails ÷ {fmtNumber(c.supplyDaily)}/day
                          </p>
                        </>
                      )}
                    </td>
                    <td className="py-2 text-xs">
                      {c.daysToFinish === null ? (
                        <span className="text-muted">—</span>
                      ) : c.daysToFinish === 0 ? (
                        <Badge tone="mint">list done</Badge>
                      ) : (
                        <>
                          {/* Always the real figure. "1yr+" hid the two numbers
                              the column exists to give you, and hid them hardest
                              on exactly the campaigns that need attention. */}
                          <Badge
                            tone={c.daysToFinish < 7 ? "danger" : c.daysToFinish < 21 ? "sun" : "white"}
                          >
                            {fmtNumber(Math.round(c.daysToFinish))}d
                          </Badge>
                          {c.finishDate ? (
                            <p className="mt-0.5 text-[11px] text-muted">{fmtDateShort(c.finishDate)}</p>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                  {/* The whole sum on one line, in the order it gets asked:
                      capacity, rate, what's left, how long, what date. */}
                  <tr className="bg-canvas/40">
                    <td colSpan={11} className="px-1 pb-2 text-[11px] text-muted">
                      {/* The capacity sum, spelled out end to end. The left and
                          right of the "=" must reconcile: mailboxCount × perBox
                          is the raw ceiling; when mailboxes are shared across
                          campaigns the usable share is lower, shown separately. */}
                      <b>{fmtNumber(c.mailboxCount)}</b> inbox
                      {c.mailboxCount === 1 ? "" : "es"} ×{" "}
                      <b>{fmtNumber(perBoxCap)}</b>/day ={" "}
                      <b>{fmtNumber(c.mailboxCount * perBoxCap)}</b> emails/day
                      {Math.round(c.supplyDaily) !== Math.round(c.mailboxCount * perBoxCap) ? (
                        <>
                          {" "}(<b>{fmtNumber(c.supplyDaily)}</b>/day after sharing)
                        </>
                      ) : null}{" "}
                      · <b>{fmtNumber(c.leadsRemaining)}</b> leads ×{" "}
                      <b>{fmtNumber(c.sequenceSteps)}</b> step
                      {c.sequenceSteps === 1 ? "" : "s"}
                      {!c.sequenceStepsKnown ? (
                        <span title="Instantly didn't report the sequence length — using Settings › emails per lead">
                          {" "}(assumed)
                        </span>
                      ) : null}{" "}
                      = <b>{fmtNumber(c.emailsNeeded)}</b> emails
                      {c.daysAtCapacityCalendar !== null ? (
                        <>
                          {" "}→ <b>{fmtNumber(Math.round(c.daysAtCapacityCalendar))} days</b> at
                          full capacity
                          {c.capacityFinishDate ? (
                            <> (<b>{fmtDateShort(c.capacityFinishDate)}</b>)</>
                          ) : null}
                        </>
                      ) : null}

                      {/* And what's actually happening, when it differs. */}
                      {c.daysToFinish !== null && c.daysToFinish > 0 ? (
                        <>
                          {" · "}
                          <span
                            className={cn(
                              c.daysAtCapacityCalendar !== null &&
                                c.daysToFinish > c.daysAtCapacityCalendar * 1.5 &&
                                "font-bold text-danger",
                            )}
                          >
                            but contacting only <b>{fmtNumber(c.newLeadsPerDay)}</b> new leads/day
                            {c.leadsPerDayAtCapacity !== null ? (
                              <> instead of {fmtNumber(c.leadsPerDayAtCapacity)}</>
                            ) : null}
                            , so on track for{" "}
                            <b>{fmtNumber(Math.round(c.daysToFinish))} days</b>
                            {c.finishDate ? <> ({fmtDateShort(c.finishDate)})</> : null}
                          </span>
                        </>
                      ) : c.daysToFinish === 0 ? (
                        <> · every lead contacted</>
                      ) : null}
                    </td>
                  </tr>

                  {openBoxes.has(c.id) ? (
                    <tr key={`${c.id}-boxes`} className="border-t border-ink/10 bg-canvas/70">
                      <td colSpan={11} className="px-1 py-3">
                        <CampaignMailboxTable
                          emails={c.emails}
                          health={c.health}
                          healthByEmail={healthByEmail}
                          placement={placement}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function Bar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-xs">
        <span className="font-bold">{label}</span>
        <span className="text-muted">{fmtNumber(value)}/day</span>
      </div>
      <ProgressBar value={value} max={max} color={color} height={12} />
    </div>
  );
}
