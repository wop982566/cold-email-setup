import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { Activity, ArrowUpRight, AlertTriangle, Plug, Search } from "lucide-react";
import { Card, Badge, ProgressBar, Spinner } from "../ui/primitives";
import { instantly } from "../../lib/instantly";
import { computeSendingHealth } from "../../lib/sendingHealth";
import { computePlan } from "../../lib/campaignPlan";
import { diagnoseSupply } from "../../lib/leadSupply";
import { CapacityResult } from "../../lib/capacity";
import { AppSettings } from "../../lib/types";
import { fmtNumber, fmtPercent, fmtDateShort } from "../../lib/format";
import { cn } from "../../lib/utils";

// Exported so the Instantly page can mirror the query keys in its raw-data
// explorer without triggering a second fetch.
export const SENDING_HEALTH_DAYS = 30; // analysis window
const DAYS = SENDING_HEALTH_DAYS;
const CHART_DAYS = 14;

const STATUS_TINT: Record<string, string> = {
  over: "bg-danger/15",
  under: "bg-sun/30",
  healthy: "bg-mint/20",
  idle: "bg-canvas",
};
const STATUS_COLOR: Record<string, string> = {
  over: "#E03131",
  under: "#FFC900",
  healthy: "#23A094",
  idle: "#6B6B6B",
};

function Header() {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-lg">
        <Activity size={18} /> Sending health
      </h2>
      <Link to="/instantly" className="btn-ghost btn-sm">
        Instantly <ArrowUpRight size={14} />
      </Link>
    </div>
  );
}

// A tinted stat tile — the same pattern the Dashboard uses for its capacity row.
// `sub2` carries a second window's figure, so a number can never sit next to a
// chart covering a different period without saying so.
function Tile({
  label,
  value,
  sub,
  sub2,
}: {
  label: string;
  value: string;
  sub: string;
  sub2?: string;
}) {
  return (
    <div className="rounded-xl border-2 border-ink bg-canvas p-3">
      <p className="text-xs font-bold uppercase text-muted">{label}</p>
      <p className="text-2xl font-extrabold">{value}</p>
      <p className="mt-0.5 text-[11px] font-semibold text-muted">{sub}</p>
      {sub2 ? <p className="text-[11px] font-semibold text-ink/70">{sub2}</p> : null}
    </div>
  );
}

/**
 * Compares live Instantly sending against mailbox capacity and campaign limits,
 * then says whether you're exceeding or underutilising — and how many more
 * inboxes would cover the campaign limits you've configured.
 *
 * Renders as a fragment (main card + side card) to fill a 3-column section grid.
 */
export function SendingHealthCard({
  cap,
  settings,
}: {
  cap: CapacityResult | null;
  settings: AppSettings | undefined;
}) {
  const acctQ = useQuery({
    queryKey: ["inst", "acct"], // exact match with the Instantly page — shared cache
    queryFn: () => instantly.accounts(),
    staleTime: 60_000,
  });
  const campQ = useQuery({
    queryKey: ["inst", "camplist"], // distinct from ["inst","camp",range] (analytics)
    queryFn: () => instantly.campaigns(),
    staleTime: 60_000,
  });
  const dailyQ = useQuery({
    queryKey: ["inst", "daily", DAYS],
    queryFn: () => instantly.analyticsDaily(DAYS),
    staleTime: 60_000,
  });
  // Per-campaign analytics, for the lead-supply diagnosis. Same key the planner
  // uses, so this shares that cache rather than firing a second request.
  const statsQ = useQuery({
    queryKey: ["inst", "camp", "30d"],
    queryFn: () => instantly.campaignAnalytics("30d"),
    staleTime: 60_000,
  });

  const queries = [acctQ, campQ, dailyQ];
  const notConfigured = queries.some((q) => q.data?.configured === false);
  const loading = queries.some((q) => q.isLoading);
  // instantly.* never throws, so react-query's isError stays false — check ok/configured by hand.
  const allFailed = queries.every((q) => q.data && !q.data.ok);

  const health = useMemo(() => {
    if (!cap || !settings) return null;
    return computeSendingHealth({
      accountsData: acctQ.data?.ok ? acctQ.data.data : null,
      campaignsData: campQ.data?.ok ? campQ.data.data : null,
      dailyData: dailyQ.data?.ok ? dailyQ.data.data : null,
      cap,
      settings,
      days: DAYS,
      // One constant drives both the chart and the recent figure, so the two
      // cannot drift into describing different periods again.
      recentDays: CHART_DAYS,
    });
  }, [acctQ.data, campQ.data, dailyQ.data, cap, settings]);

  // Why the gap exists. Deliberately not in `queries` above: if campaign
  // analytics fails, the card still shows its core numbers and just omits the
  // explanation. `costs` only feeds figures this card doesn't render.
  const diagnosis = useMemo(() => {
    if (!cap || !settings || !health) return null;
    const plan = computePlan({
      accountsData: acctQ.data?.ok ? acctQ.data.data : null,
      campaignsData: campQ.data?.ok ? campQ.data.data : null,
      analyticsData: statsQ.data?.ok ? statsQ.data.data : null,
      cap,
      settings,
      costs: [],
    });
    return diagnoseSupply({ plan, health, settings });
  }, [acctQ.data, campQ.data, statsQ.data, cap, settings, health]);

  if (!cap || !settings) return null;

  // Compact fallbacks — the Dashboard must stay usable without Instantly.
  if (loading) {
    return (
      <Card className="p-5 lg:col-span-3">
        <Header />
        <Spinner label="Loading live sending data…" />
      </Card>
    );
  }
  if (notConfigured || allFailed || !health) {
    const err = queries.find((q) => q.data && !q.data.ok)?.data?.error;
    return (
      <Card className="p-5 lg:col-span-3">
        <Header />
        <p className="flex items-center gap-2 text-sm text-muted">
          <Plug size={15} />
          {notConfigured
            ? "Connect Instantly to compare your real sending against your mailbox and campaign limits."
            : "Live sending data is unavailable right now."}
        </p>
        {!notConfigured && err ? <p className="mt-1 text-xs text-muted">{err}</p> : null}
        <Link to="/instantly" className="btn-ghost btn-sm mt-3">
          {notConfigured ? "Connect Instantly" : "Open Instantly"} <ArrowUpRight size={14} />
        </Link>
      </Card>
    );
  }

  const h = health;
  const chartRows = h.days.slice(-CHART_DAYS).map((d) => ({ ...d, label: fmtDateShort(d.date) }));
  const statusColor = STATUS_COLOR[h.status];

  let verdict: string;
  if (h.status === "idle") {
    verdict = `No sends recorded in the last ${DAYS} days.`;
  } else if (h.status === "over" && h.overBy > 0) {
    verdict = `Sending ~${fmtNumber(h.avgPerSendingDay)}/day against a ${fmtNumber(h.ceilingDaily)}/day ceiling — ${fmtNumber(h.overBy)} over. Bottleneck: ${h.bottleneck}. Cut volume or raise limits before deliverability drops.`;
  } else if (h.status === "over") {
    // Average sits under the ceiling but a single day blew through it — the
    // spike is the deliverability risk, so name the day rather than the average.
    verdict = `You averaged ${fmtNumber(h.avgPerSendingDay)}/day, but ${fmtDateShort(h.peakDay?.date)} sent ${fmtNumber(h.peakDay?.sent ?? 0)} — over your ${fmtNumber(h.ceilingDaily)}/day ceiling. Spikes like that burn deliverability even when the average looks fine.`;
  } else if (h.status === "under") {
    // Quote the recent window — it describes where the operation is now — and
    // name the longer average rather than letting the two look contradictory.
    const recentUnder = Math.max(0, Math.round(h.ceilingDaily - h.avgPerSendingDayRecent));
    verdict = `Last ${h.recentDays} days you used ${fmtPercent(h.utilizationPctRecent)} of your ${fmtNumber(h.ceilingDaily)}/day ceiling — ${fmtNumber(recentUnder)}/day unused, about ${fmtNumber(recentUnder * settings.sending_days_per_week)} emails a week you're paying for and not sending. Over ${DAYS} days the average is ${fmtNumber(h.avgPerSendingDay)}/day.`;
  } else {
    verdict = `Running at ${fmtPercent(h.utilizationPctRecent)} of your ${fmtNumber(h.ceilingDaily)}/day ceiling over the last ${h.recentDays} days (${fmtPercent(h.utilizationPct)} across ${DAYS}). Bottleneck: ${h.bottleneck}.`;
  }

  return (
    <>
      <Card className="p-5 lg:col-span-2">
        <Header />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Tile
            label="Mailbox capacity / day"
            value={fmtNumber(h.liveMailboxDaily)}
            sub={`${h.liveMailboxes} inboxes × ${fmtNumber(h.perMailboxMode)}/day`}
          />
          <Tile
            label="Campaign limits / day"
            value={h.campaignLimitKnown ? fmtNumber(h.campaignDailyLimit) : "No cap"}
            sub={`${h.activeCampaigns} active campaign${h.activeCampaigns === 1 ? "" : "s"}`}
          />
          <Tile
            label="Actually sending / day"
            value={fmtNumber(h.avgPerSendingDay)}
            sub={`${DAYS}d avg · ${fmtPercent(h.utilizationPct)} of ${fmtNumber(h.ceilingDaily)} ceiling`}
            sub2={
              h.sendingDaysRecent > 0
                ? `${h.recentDays}d: ${fmtNumber(h.avgPerSendingDayRecent)}/day (${fmtPercent(
                    h.utilizationPctRecent,
                  )})${
                    h.trendPct !== null && Math.abs(h.trendPct) >= 5
                      ? ` · ${h.trendPct > 0 ? "↑" : "↓"} ${fmtPercent(Math.abs(h.trendPct))}`
                      : ""
                  }`
                : undefined
            }
          />
        </div>

        <div className="mt-4 h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartRows}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fontWeight: 700 }} interval={1} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fontWeight: 700 }} width={44} />
              <Tooltip formatter={(v: number) => [`${fmtNumber(v)} sent`, "Emails"]} />
              {h.ceilingDaily > 0 ? (
                <ReferenceLine
                  y={h.ceilingDaily}
                  stroke="#E03131"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  label={{
                    value: "capacity",
                    position: "insideTopRight",
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                />
              ) : null}
              <Bar dataKey="sent" stroke="#000" strokeWidth={2} radius={[6, 6, 0, 0]}>
                {chartRows.map((d, i) => (
                  <Cell
                    key={i}
                    fill={
                      h.ceilingDaily > 0 && d.sent > h.ceilingDaily
                        ? "#E03131"
                        : d.isToday
                          ? "#DAD3FF"
                          : "#3F6BFF"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-1 text-[11px] text-muted">
          Chart shows the last {CHART_DAYS} days; the headline figure above averages {DAYS} days,
          with the {CHART_DAYS}-day figure beneath it. Both ignore days with no sends, and today
          (lighter bar) is still in progress so it counts towards neither. Warmup email isn't
          included — campaign sends only.
        </p>

        <div
          className={cn(
            "mt-4 rounded-xl border-2 border-ink p-3 text-sm font-semibold",
            STATUS_TINT[h.status],
          )}
        >
          {verdict}
        </div>

        {/* Why the gap exists. A capacity number without a cause just tells you
            to buy more of something. */}
        {diagnosis && diagnosis.reasons.length > 0 ? (
          <div className="mt-3 rounded-xl border-2 border-ink bg-canvas p-3">
            <p className="flex items-center gap-2 text-sm font-extrabold">
              <Search size={15} />
              Why you're at {fmtPercent(h.utilizationPctRecent)}
            </p>
            <p className="mt-1 text-sm">{diagnosis.summary}</p>

            <ul className="mt-2 space-y-1.5">
              {diagnosis.reasons.map((r) => (
                <li key={r.code} className="flex items-start gap-2 text-xs">
                  <Badge tone={r.severity === "high" ? "danger" : "sun"}>{r.headline}</Badge>
                  <span className="flex-1 text-muted">{r.detail}</span>
                </li>
              ))}
            </ul>

            {diagnosis.leadCeilingDaily !== null ? (
              <p className="mt-2 text-[11px] text-muted">
                Estimate: {fmtNumber(diagnosis.newLeadsDaily)} new leads/day ×{" "}
                {diagnosis.sendsPerLead} emails per lead ≈ {fmtNumber(diagnosis.leadCeilingDaily)}
                /day.{" "}
                {diagnosis.confidence === "observed"
                  ? "Lead rate measured from actual sends."
                  : diagnosis.confidence === "mixed"
                    ? "Lead rate part measured, part from campaign settings."
                    : "Lead rate taken from campaign settings — no send history yet."}{" "}
                Emails per lead comes from Settings, so it's an assumption rather than a
                measurement.
              </p>
            ) : null}

            {diagnosis.estimateWarning ? (
              <p className="mt-1.5 flex items-start gap-1.5 rounded-lg border-2 border-ink bg-sun/30 p-2 text-[11px] font-semibold">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                {diagnosis.estimateWarning}
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-lg">This week</h2>
        <div className="mb-1 flex items-center justify-between text-sm font-semibold">
          <span>
            {fmtNumber(h.weeklyActual)} / {fmtNumber(h.weeklyCapacity)}
          </span>
          <span className="text-muted">{fmtPercent(h.weeklyUtilizationPct)}</span>
        </div>
        <ProgressBar
          value={h.weeklyActual}
          max={Math.max(1, h.weeklyCapacity)}
          color={statusColor}
          height={18}
        />
        <p className="mt-1 text-[11px] text-muted">
          {fmtNumber(h.ceilingDaily)}/day × {settings.sending_days_per_week} sending days
        </p>

        {/* The headline recommendation the operator actually acts on. */}
        <div className="mt-4 rounded-xl border-2 border-ink bg-pink/20 p-3 text-sm">
          {!h.campaignLimitKnown ? (
            <>
              <span className="font-extrabold">
                {h.campaignsWithoutLimit} campaign{h.campaignsWithoutLimit === 1 ? "" : "s"}
              </span>{" "}
              {h.campaignsWithoutLimit === 1 ? "has" : "have"} no daily limit set in Instantly — set
              one so this can size your inbox needs.
            </>
          ) : h.inboxesNeeded > 0 && diagnosis?.suppressInboxAdvice ? (
            // Campaign limits exceed inbox capacity, so the arithmetic says "buy
            // inboxes" — but the inboxes already owned are sitting idle. Sizing
            // advice here would be an expensive mistake, so give the real
            // constraint instead.
            <>
              <span className="font-extrabold">Don't add inboxes yet.</span> On paper you're{" "}
              {fmtNumber(h.emailDelta)} emails/day short of your{" "}
              {fmtNumber(h.campaignDailyLimit)}/day campaign limits, but you're only using{" "}
              {fmtPercent(h.utilizationPctRecent)} of the capacity you already have.{" "}
              {diagnosis.binding === "leads" && diagnosis.leadsNeededDaily > 0 ? (
                <>
                  Add about{" "}
                  <span className="font-extrabold">
                    {fmtNumber(diagnosis.leadsNeededDaily)} more new leads/day
                  </span>{" "}
                  first — that fills the inboxes you're already paying for.
                </>
              ) : (
                "Fix what's throttling volume first — see the breakdown on the left."
              )}
            </>
          ) : h.inboxesNeeded > 0 ? (
            <>
              You need <span className="font-extrabold">{fmtNumber(h.emailDelta)} more emails/day</span> of
              inbox capacity to match your {fmtNumber(h.campaignDailyLimit)}/day campaign limits —{" "}
              <span className="font-extrabold">
                add {h.inboxesNeeded} inboxes (≈ {h.domainsNeeded} domain
                {h.domainsNeeded === 1 ? "" : "s"})
              </span>
              .
            </>
          ) : (
            <>
              Your inboxes cover your campaign limits
              {h.spareDaily > 0 ? (
                <>
                  {" "}
                  with <span className="font-extrabold">{fmtNumber(h.spareDaily)}/day spare</span> — raise
                  the campaign limits to use it.
                </>
              ) : (
                "."
              )}
            </>
          )}
        </div>

        <Link to="/planner" className="btn-ghost btn-sm mt-3 w-full justify-center">
          Plan by campaign <ArrowUpRight size={14} />
        </Link>

        {h.excludedMailboxes > 0 ? (
          <p className="mt-2 text-[11px] text-muted">
            {h.excludedMailboxes} mailbox{h.excludedMailboxes === 1 ? "" : "es"} excluded from these
            numbers.
          </p>
        ) : null}

        {h.hasDrift ? (
          <div className="mt-3 rounded-xl border-2 border-ink bg-sun/30 p-3 text-xs">
            <Badge tone="sun">
              <AlertTriangle size={11} /> Config drift
            </Badge>
            {Math.abs(h.perMailboxDrift) >= 1 ? (
              <p className="mt-2">
                Your capacity model says {h.perMailboxPlanned}/inbox/day; Instantly is set to{" "}
                {fmtNumber(h.perMailboxMode)}.{" "}
                <Link to="/capacity" className="font-bold underline">
                  Fix the model
                </Link>
              </p>
            ) : null}
            {Math.abs(h.mailboxCountDrift) >= 1 ? (
              <p className="mt-1">
                Domains sheet: {cap.activeMailboxes} active mailboxes. Instantly: {h.liveMailboxes}.{" "}
                <Link to="/domains" className="font-bold underline">
                  Check domains
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}

        {h.accountsTruncated || h.campaignsTruncated ? (
          <p className="mt-3 rounded-xl border-2 border-ink bg-danger/15 p-3 text-xs font-semibold">
            Showing only the first 100 {h.accountsTruncated ? "mailboxes" : "campaigns"} Instantly
            returned — these totals are a floor, not the full picture.
          </p>
        ) : null}

        {h.mailboxesMissingLimit > 0 ? (
          <p className="mt-2 text-[11px] text-muted">
            {h.mailboxesMissingLimit} mailbox{h.mailboxesMissingLimit === 1 ? "" : "es"} didn't
            report a daily limit — estimated at {h.perMailboxPlanned}/day.
          </p>
        ) : null}
      </Card>
    </>
  );
}
