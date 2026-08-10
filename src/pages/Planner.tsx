import { useMemo, useState, Fragment } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
} from "lucide-react";
import { Card, StatCard, Badge, Spinner, ProgressBar, EmptyState } from "../components/ui/primitives";
import { useToast } from "../components/ui/toast";
import { useCollection, useSettings, useSaveSettings } from "../lib/hooks";
import { AppSettings, CapacitySource, CostItem, Domain, TABLES } from "../lib/types";
import { computeCapacity } from "../lib/capacity";
import { computePlan, type PlannerGroup, type HealthScore } from "../lib/campaignPlan";
import { instantly, asItems } from "../lib/instantly";
import {
  batchEmails,
  mergePlacement,
  parseWarmupAnalytics,
  toHealthInput,
  type PlacementMap,
} from "../lib/placement";
import { computeMaintenance, type MailboxHealth } from "../lib/mailboxHealth";
import { CampaignMaintenance } from "../components/planner/CampaignMaintenance";
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

  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [showMailboxes, setShowMailboxes] = useState(false);
  const [tab, setTab] = useState<"plan" | "maintenance">("plan");

  // Same keys as the Instantly page and the Sending Health card, so all three
  // share one fetch and the Instantly Refresh button invalidates them.
  const acctQ = useQuery({ queryKey: ["inst", "acct"], queryFn: () => instantly.accounts(), staleTime: 60_000 });
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
    });
  }, [acctQ.data, campQ.data, statsQ.data, cap, settings, costs, placementHealthInput]);

  // Computed once here and shared: the Maintenance tab and the per-campaign
  // mailbox breakdown must never disagree about an address.
  const maintenance = useMemo(() => {
    if (!plan || !settings) return null;
    return computeMaintenance({
      plan,
      domains,
      settings,
      placement: placementHealthInput,
    });
  }, [plan, domains, settings, placementHealthInput]);

  const healthByEmail = useMemo(() => {
    const m = new Map<string, MailboxHealth>();
    for (const h of maintenance?.mailboxes ?? []) m.set(h.box.email, h);
    return m;
  }, [maintenance]);

  const queries = [acctQ, campQ, statsQ];
  const notConfigured = queries.some((q) => q.data?.configured === false);
  const loading = queries.some((q) => q.isLoading);
  const allFailed = queries.every((q) => q.data && !q.data.ok);

  function refresh() {
    qc.invalidateQueries({ queryKey: ["inst"] });
    toast.push("Refreshing Instantly data…", "info");
  }

  async function patchSettings(patch: Partial<AppSettings>) {
    if (!settings) return;
    await saveSettings.mutateAsync({ ...settings, ...patch });
  }

  function toggleExclude(email: string) {
    if (!settings) return;
    const cur = settings.excluded_mailboxes ?? [];
    const next = cur.includes(email) ? cur.filter((e) => e !== email) : [...cur, email];
    void patchSettings({ excluded_mailboxes: next });
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
        <button className="btn-ghost btn-sm" onClick={refresh}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
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
        {([["plan", "Plan"], ["maintenance", "Maintenance"]] as const).map(([k, label]) => (
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

      {/* Goal planner */}
      <Card className="p-5">
        <h3 className="mb-3 flex items-center gap-2 text-lg">
          <Target size={18} /> Goal planner
        </h3>
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
                  {k === "emails" ? "Send emails / day" : "Contact new leads / day"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="label">Target</p>
            <input
              type="number"
              min={0}
              className="input w-32"
              defaultValue={p.goal.value}
              onBlur={(e) => void patchSettings({ planner_goal_value: Number(e.target.value) || 0 })}
            />
          </div>
        </div>

        <div className="mt-4 rounded-xl border-2 border-ink bg-pink/20 p-4 text-sm">
          {p.goal.value <= 0 ? (
            <p>Enter a target to size the infrastructure you'd need.</p>
          ) : (
            <>
              <p>
                To {p.goal.kind === "leads" ? "contact" : "send"}{" "}
                <span className="font-extrabold">
                  {fmtNumber(p.goal.value)} {p.goal.kind === "leads" ? "new leads" : "emails"}/day
                </span>
                {p.goal.kind === "leads" ? (
                  <>
                    {" "}you need <span className="font-extrabold">{fmtNumber(p.goal.emailsPerDay)} emails/day</span>{" "}
                    once follow-ups are flowing ({settings.default_sends_per_lead} touches per lead)
                  </>
                ) : (
                  <>
                    {" "}you'd be contacting about{" "}
                    <span className="font-extrabold">{fmtNumber(p.goal.newLeadsPerDay)} new leads/day</span>
                  </>
                )}
                .
              </p>
              <p className="mt-1">
                That needs <span className="font-extrabold">{p.goal.inboxesRequired} inboxes</span> at{" "}
                {fmtNumber(p.perBoxCap)}/day. You have {p.usableInboxes} usable →{" "}
                {p.goal.inboxesToAdd > 0 ? (
                  <span className="font-extrabold">
                    add {p.goal.inboxesToAdd} inboxes (~{p.goal.domainsToAdd} domains)
                  </span>
                ) : (
                  <span className="font-extrabold">you already have enough</span>
                )}
                {p.goal.monthlyCostAdd !== null && p.goal.inboxesToAdd > 0
                  ? ` — about ${fmtMoney(p.goal.monthlyCostAdd, currency)}/mo more`
                  : ""}
                .
              </p>
              <p className="mt-1 text-muted">
                {p.goal.inboxesToAdd > 0
                  ? `New inboxes need roughly ${p.goal.daysToReady} days of warmup before they carry full volume. `
                  : ""}
                {p.goal.providerOk
                  ? `Your provider caps allow it (ceiling ${fmtNumber(p.goal.providerCeiling)}/day).`
                  : `⚠ This exceeds your provider ceiling of ${fmtNumber(p.goal.providerCeiling)}/day — raise the plan or SES limit too.`}
              </p>
            </>
          )}
        </div>
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
        <div className="border-b-2 border-ink p-4">
          <h3 className="text-lg">Campaign groups</h3>
          <p className="text-xs text-muted">
            Grouped by the first word of the campaign name. Supply is split when a mailbox runs in
            more than one campaign, so shared inboxes aren't counted twice.
          </p>
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
              />
            ))}
          </div>
        )}
      </Card>

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
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                  <th className="w-12 px-3 py-2">Use</th>
                  <th className="px-3 py-2">Mailbox</th>
                  <th className="w-20 px-3 py-2">Limit</th>
                  <th className="px-3 py-2">Campaigns</th>
                  <th className="w-28 px-3 py-2">State</th>
                </tr>
              </thead>
              <tbody>
                {p.mailboxes.map((b) => (
                  <tr
                    key={b.email}
                    className={cn("border-b border-ink/10", (b.excluded || b.beyondCount) && "opacity-50")}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={!b.excluded}
                        onChange={() => toggleExclude(b.email)}
                        title={b.excluded ? "Excluded — click to count it" : "Counted — click to exclude"}
                      />
                    </td>
                    <td className="truncate px-3 py-2 font-semibold">{b.email}</td>
                    <td className="px-3 py-2">{fmtNumber(b.dailyLimit)}</td>
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
}: {
  g: PlannerGroup;
  open: boolean;
  onToggle: () => void;
  healthByEmail: Map<string, MailboxHealth>;
  placement: PlacementMap | null;
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
              {short ? `short ${fmtNumber(g.gapDaily)}/day` : `${fmtNumber(-g.gapDaily || 0)} spare`}
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
          <table className="w-full min-w-[1020px] border-collapse text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-muted">
                <th className="py-2 pr-3">Campaign</th>
                <th className="w-20 py-2 pr-3">Limit</th>
                <th className="w-20 py-2 pr-3">Supply</th>
                <th className="w-16 py-2 pr-3">Boxes</th>
                <th className="w-32 py-2 pr-3">Priority</th>
                <th className="w-44 py-2 pr-3">Leads contacted</th>
                <th className="w-20 py-2 pr-3">Health</th>
                <th className="w-24 py-2 pr-3">New leads/day</th>
                <th className="w-32 py-2">Finishes in</th>
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
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <ProgressBar value={c.pctContacted} max={100} color="#23A094" height={10} />
                        </div>
                        <span className="whitespace-nowrap text-xs text-muted">
                          {fmtNumber(c.leadsContacted)}/{fmtNumber(c.leadsTotal)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {fmtNumber(c.leadsRemaining)} left · {fmtPercent(c.pctContacted)} done
                      </p>
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
                    <td className="py-2 text-xs">
                      {c.daysToFinish === null ? (
                        <span className="text-muted">—</span>
                      ) : c.daysToFinish === 0 ? (
                        <Badge tone="mint">list done</Badge>
                      ) : (
                        <>
                          <Badge
                            tone={c.daysToFinish < 7 ? "danger" : c.daysToFinish < 21 ? "sun" : "white"}
                          >
                            {c.daysToFinish > 365 ? "1yr+" : `${Math.round(c.daysToFinish)}d`}
                          </Badge>
                          {c.finishDate && c.daysToFinish <= 365 ? (
                            <p className="mt-0.5 text-[11px] text-muted">{fmtDateShort(c.finishDate)}</p>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                  {openBoxes.has(c.id) ? (
                    <tr key={`${c.id}-boxes`} className="border-t border-ink/10 bg-canvas/70">
                      <td colSpan={8} className="px-1 py-3">
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
