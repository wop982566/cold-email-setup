import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  Send,
  MailOpen,
  Reply,
  Target,
  DollarSign,
  Flame,
  Plug,
  KeyRound,
  AlertTriangle,
  Trophy,
  ChevronDown,
} from "lucide-react";
import { Card, StatCard, Badge, Spinner, EmptyState } from "../components/ui/primitives";
import { ProviderLogo } from "../components/ui/badges";
import { SendingHealthCard, SENDING_HEALTH_DAYS } from "../components/dashboard/SendingHealthCard";
import { useToast } from "../components/ui/toast";
import { useCollection, useSettings } from "../lib/hooks";
import { CapacitySource, Domain, TABLES } from "../lib/types";
import { computeCapacity } from "../lib/capacity";
import { instantly, asItems, pick, type DateRange, type InstantlyResult } from "../lib/instantly";
import { fmtNumber, fmtPercent, fmtMoney } from "../lib/format";
import { cn } from "../lib/utils";

const RANGES: { value: DateRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

// Candidate field names — Instantly's payloads vary, so we look across a few.
const F = {
  sent: ["emails_sent_count", "sent_count", "emails_sent", "contacted_count", "total_sent"],
  opens: ["open_count", "opened_count", "unique_opens", "total_opens"],
  replies: ["reply_count", "replied_count", "total_replies"],
  bounced: ["bounced_count", "bounce_count"],
  opps: ["total_opportunities", "opportunities_count", "opportunities"],
  oppValue: ["total_opportunity_value", "opportunity_value"],
  leads: ["leads_count", "total_leads"],
  clicks: ["link_click_count", "click_count"],
};

function rate(n: number, d: number) {
  return d > 0 ? (n / d) * 100 : 0;
}

function ConnectCard() {
  return (
    <Card className="p-6">
      <EmptyState
        icon={<Plug size={32} />}
        title="Connect Instantly"
        description="Pull live campaign analytics, mailbox warmup health, and sending volume straight from your Instantly workspace."
      />
      <div className="mt-4 rounded-xl border-2 border-ink bg-canvas p-4 text-sm">
        <p className="flex items-center gap-2 font-bold">
          <KeyRound size={16} /> Setup (2 steps)
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            In Instantly → <b>Settings → Integrations → API</b>, create a <b>v2</b> API key with read scopes
            (<code>all:read</code>, or granular <code>campaigns:read accounts:read analytics:read leads:read</code>).
          </li>
          <li>
            In Netlify → Environment variables, add <code>INSTANTLY_API_KEY</code> (Functions scope), then redeploy.
          </li>
        </ol>
        <p className="mt-2 text-xs text-muted">
          The key never touches the browser — calls run through a server-side function. Live data appears only on the
          deployed site (functions don't run in local preview).
        </p>
      </div>
    </Card>
  );
}

export default function Instantly() {
  const toast = useToast();
  const qc = useQueryClient();
  const [range, setRange] = useState<DateRange>("30d");
  const { data: capacity = [] } = useCollection<CapacitySource>(TABLES.capacity);
  const { data: domains = [] } = useCollection<Domain>(TABLES.domains);
  const { data: settings } = useSettings();

  const cap = useMemo(
    () => (settings ? computeCapacity(domains, capacity, settings) : null),
    [domains, capacity, settings],
  );

  const overviewQ = useQuery({ queryKey: ["inst", "overview", range], queryFn: () => instantly.analyticsOverview(range) });
  const campQ = useQuery({ queryKey: ["inst", "camp", range], queryFn: () => instantly.campaignAnalytics(range) });
  const acctQ = useQuery({ queryKey: ["inst", "acct"], queryFn: () => instantly.accounts() });
  // Same keys as SendingHealthCard, so react-query serves these from one fetch.
  // They exist here purely to expose the payloads in the raw-data explorer.
  const campListQ = useQuery({ queryKey: ["inst", "camplist"], queryFn: () => instantly.campaigns() });
  const dailyQ = useQuery({
    queryKey: ["inst", "daily", SENDING_HEALTH_DAYS],
    queryFn: () => instantly.analyticsDaily(SENDING_HEALTH_DAYS),
  });

  const notConfigured =
    overviewQ.data?.configured === false ||
    acctQ.data?.configured === false ||
    campQ.data?.configured === false;

  const loading = overviewQ.isLoading || campQ.isLoading || acctQ.isLoading;

  const overview = (overviewQ.data?.ok ? (overviewQ.data.data as Record<string, unknown>) : {}) ?? {};
  const sent = pick(overview, F.sent);
  const opens = pick(overview, F.opens);
  const replies = pick(overview, F.replies);
  const bounced = pick(overview, F.bounced);
  const opps = pick(overview, F.opps);
  const oppValue = pick(overview, F.oppValue);

  const campaigns = useMemo(() => {
    const items = asItems<Record<string, unknown>>(campQ.data?.data);
    return items
      .map((c) => {
        const s = pick(c, F.sent);
        const o = pick(c, F.opens);
        const r = pick(c, F.replies);
        return {
          id: String(c.campaign_id ?? c.id ?? ""),
          name: String(c.campaign_name ?? c.name ?? "Campaign"),
          sent: s,
          opens: o,
          replies: r,
          opps: pick(c, F.opps),
          openRate: rate(o, s),
          replyRate: rate(r, s),
        };
      })
      .sort((a, b) => b.replyRate - a.replyRate);
  }, [campQ.data]);

  const accounts = useMemo(() => asItems<Record<string, unknown>>(acctQ.data?.data), [acctQ.data]);
  const activeAccounts = accounts.filter((a) => Number(a.status) === 1 || a.status === "active").length;
  const warmupOn = accounts.filter((a) => Number(a.warmup_status) === 1).length;

  function refresh() {
    qc.invalidateQueries({ queryKey: ["inst"] });
    toast.push("Refreshing Instantly data…", "info");
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-2">
          <ProviderLogo name="instantly" size={26} />
          <div>
            <h2 className="text-lg leading-none">Instantly insights</h2>
            <p className="text-xs text-muted">Live campaign, deliverability & warmup data</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border-2 border-ink">
            {RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={cn(
                  "px-3 py-1.5 text-xs font-bold first:rounded-l-lg last:rounded-r-lg",
                  range === r.value ? "bg-ink text-paper" : "bg-paper hover:bg-canvas",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button className="btn-ghost btn-sm" onClick={refresh}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </Card>

      {notConfigured ? (
        <ConnectCard />
      ) : loading ? (
        <Card className="p-8">
          <Spinner label="Loading Instantly data…" />
        </Card>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Emails sent" value={fmtNumber(sent)} tone="pink" icon={<Send size={18} />} />
            <StatCard label="Open rate" value={fmtPercent(rate(opens, sent))} sublabel={`${fmtNumber(opens)} opens`} tone="sky" icon={<MailOpen size={18} />} />
            <StatCard label="Reply rate" value={`${rate(replies, sent).toFixed(1)}%`} sublabel={`${fmtNumber(replies)} replies`} tone="mint" icon={<Reply size={18} />} />
            <StatCard label="Opportunities" value={fmtNumber(opps)} tone="sun" icon={<Target size={18} />} />
            <StatCard label="Pipeline value" value={fmtMoney(oppValue)} tone="lavender" icon={<DollarSign size={18} />} />
            <StatCard label="Bounce rate" value={`${rate(bounced, sent).toFixed(1)}%`} tone={rate(bounced, sent) > 3 ? "danger" : "white"} icon={<AlertTriangle size={18} />} />
          </div>

          {/* Live sending vs mailbox + campaign limits */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <SendingHealthCard cap={cap} settings={settings} />
          </div>

          {/* Account health */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Card className="p-5">
              <h3 className="mb-3 flex items-center gap-2 text-lg">
                <Flame size={18} /> Mailbox health
              </h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span>Connected accounts</span>
                  <span className="font-bold">{accounts.length}</span>
                </div>
                <div className="flex justify-between">
                  <span>Active</span>
                  <Badge tone={activeAccounts === accounts.length ? "mint" : "sun"}>{activeAccounts}/{accounts.length}</Badge>
                </div>
                <div className="flex justify-between">
                  <span>Warmup running</span>
                  <Badge tone={warmupOn === accounts.length ? "mint" : "coral"}>{warmupOn}/{accounts.length}</Badge>
                </div>
              </div>
            </Card>
          </div>

          {/* Per-campaign analytics — winners surface to the top */}
          <Card className="overflow-hidden p-0">
            <div className="flex items-center justify-between border-b-2 border-ink p-4">
              <h3 className="text-lg">Campaign performance</h3>
              <Badge tone="pink"><Trophy size={12} /> top reply rate first</Badge>
            </div>
            {campaigns.length === 0 ? (
              <div className="p-6 text-sm text-muted">No campaign analytics returned for this range.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                      <th className="table-cell">Campaign</th>
                      <th className="table-cell">Sent</th>
                      <th className="table-cell">Open</th>
                      <th className="table-cell">Reply</th>
                      <th className="table-cell">Opps</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c, i) => (
                      <tr key={c.id || i} className="border-b border-ink/10">
                        <td className="table-cell">
                          <span className="flex items-center gap-2 font-bold">
                            {i === 0 && c.replyRate > 0 ? <Trophy size={13} className="text-pink-dark" /> : null}
                            {c.name}
                          </span>
                        </td>
                        <td className="table-cell">{fmtNumber(c.sent)}</td>
                        <td className="table-cell">{fmtPercent(c.openRate)}</td>
                        <td className="table-cell">
                          <Badge tone={c.replyRate >= 3 ? "mint" : c.replyRate >= 1 ? "sun" : "white"}>
                            {c.replyRate.toFixed(1)}%
                          </Badge>
                        </td>
                        <td className="table-cell font-bold">{fmtNumber(c.opps)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Accounts list */}
          {accounts.length > 0 ? (
            <Card className="overflow-hidden p-0">
              <div className="border-b-2 border-ink p-4">
                <h3 className="text-lg">Connected mailboxes ({accounts.length})</h3>
              </div>
              <div className="max-h-80 overflow-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="sticky top-0">
                    <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                      <th className="table-cell">Email</th>
                      <th className="table-cell">Status</th>
                      <th className="table-cell">Warmup</th>
                      <th className="table-cell">Warmup score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a, i) => {
                      const active = Number(a.status) === 1 || a.status === "active";
                      const wOn = Number(a.warmup_status) === 1;
                      const score = pick(a, ["stat_warmup_score", "warmup_score"]);
                      return (
                        <tr key={String(a.email ?? i)} className="border-b border-ink/10">
                          <td className="table-cell">{String(a.email ?? "—")}</td>
                          <td className="table-cell">
                            <Badge tone={active ? "mint" : "coral"}>{active ? "active" : String(a.status ?? "—")}</Badge>
                          </td>
                          <td className="table-cell">
                            <Badge tone={wOn ? "mint" : "white"}>{wOn ? "on" : "off"}</Badge>
                          </td>
                          <td className="table-cell">{score ? score : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {/* Raw data explorer — room to accommodate any extra fields */}
          <Card className="p-4">
            <details>
              <summary className="flex cursor-pointer items-center gap-2 text-sm font-bold">
                <ChevronDown size={14} /> Raw API data (everything Instantly returned)
              </summary>
              <div className="mt-3 space-y-3">
                {(
                  [
                    ["Analytics overview", overviewQ.data],
                    ["Campaign analytics", campQ.data],
                    ["Accounts (check daily_limit)", acctQ.data],
                    ["Campaign list (check daily_limit)", campListQ.data],
                    ["Daily sends (check date + sent keys)", dailyQ.data],
                  ] as [string, InstantlyResult | undefined][]
                ).map(([label, res]) => (
                  <div key={label}>
                    <p className="text-xs font-bold uppercase text-muted">{label}</p>
                    <pre className="mt-1 max-h-60 overflow-auto rounded-xl border-2 border-ink bg-canvas p-3 text-xs">
                      {JSON.stringify(res?.data ?? res?.error ?? null, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          </Card>
        </>
      )}
    </div>
  );
}
