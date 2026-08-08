import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  Globe,
  Mail,
  Gauge,
  DollarSign,
  Users,
  AlertTriangle,
  ArrowUpRight,
  Send,
  Sparkles,
} from "lucide-react";
import { Card, ProgressBar, StatCard, Badge } from "../components/ui/primitives";
import { SendingHealthCard } from "../components/dashboard/SendingHealthCard";
import { useCollection, useSettings } from "../lib/hooks";
import {
  Campaign,
  CapacitySource,
  CostItem,
  Domain,
  Lead,
  TABLES,
} from "../lib/types";
import { computeCapacity } from "../lib/capacity";
import { totalMonthly, totalAnnual } from "../lib/costs";
import { dbMode } from "../lib/db";
import { daysUntil, fmtMoney, fmtNumber, fmtCompact, fmtPercent } from "../lib/format";

export default function Dashboard() {
  const { data: domains = [] } = useCollection<Domain>(TABLES.domains);
  const { data: campaigns = [] } = useCollection<Campaign>(TABLES.campaigns);
  const { data: capacitySources = [] } = useCollection<CapacitySource>(TABLES.capacity);
  const { data: costs = [] } = useCollection<CostItem>(TABLES.costs);
  const { data: leads = [] } = useCollection<Lead>(TABLES.leads);
  const { data: settings } = useSettings();

  const cap = useMemo(
    () => (settings ? computeCapacity(domains, capacitySources, settings) : null),
    [domains, capacitySources, settings],
  );

  const currency = settings?.currency ?? "USD";
  const window = settings?.reminder_window_days ?? 30;

  const monthly = totalMonthly(costs, { monthlyEmails: cap?.effectiveMonthly });
  const annual = totalAnnual(costs, { monthlyEmails: cap?.effectiveMonthly });

  const expiring = useMemo(() => {
    return domains
      .map((d) => ({ d, days: daysUntil(d.expiry_date) }))
      .filter((x) => x.days !== null && (x.days as number) <= window)
      .sort((a, b) => (a.days as number) - (b.days as number));
  }, [domains, window]);

  const campaignData = useMemo(() => {
    const counts = new Map<string, { name: string; value: number; color: string }>();
    for (const d of domains) {
      const c = campaigns.find((x) => x.id === d.campaign_id);
      const name = c?.name ?? d.campaign_label ?? "Unassigned";
      const color = c?.color ?? "#999";
      const cur = counts.get(name) ?? { name, value: 0, color };
      cur.value += 1;
      counts.set(name, cur);
    }
    return Array.from(counts.values());
  }, [domains, campaigns]);

  // Setup readiness across all domains.
  const readiness = useMemo(() => {
    const n = domains.length || 1;
    const pct = (pred: (d: Domain) => boolean) =>
      (domains.filter(pred).length / n) * 100;
    return [
      { step: "DNS", value: pct((d) => d.dns_status === "Yes") },
      { step: "Mail server", value: pct((d) => d.mailing_status === "Yes") },
      { step: "Instantly", value: pct((d) => d.connected_to_instantly === "Yes") },
      { step: "Warmup", value: pct((d) => d.warmup_started === "Yes") },
      { step: "Gmail send-as", value: pct((d) => d.gmail_send_configured === "Yes") },
    ];
  }, [domains]);

  const usedLeads = leads.filter((l) => l.status === "used").length;

  return (
    <div className="space-y-6">
      {dbMode === "local" ? (
        <Card className="flex flex-col items-start gap-2 bg-sun p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Sparkles size={20} />
            <p className="text-sm font-bold">
              Running in local mode — data is saved in this browser only. Remove VITE_FORCE_LOCAL to use
              the shared Netlify Blobs store instead.
            </p>
          </div>
          <Link to="/settings" className="btn-dark btn-sm shrink-0">
            Settings
          </Link>
        </Card>
      ) : null}

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Domains"
          value={domains.length}
          sublabel={`${campaigns.length} campaigns`}
          tone="pink"
          icon={<Globe size={18} />}
        />
        <StatCard
          label="Mailboxes"
          value={cap?.mailboxes ?? 0}
          sublabel={`${cap?.activeMailboxes ?? 0} active in Instantly`}
          tone="lavender"
          icon={<Mail size={18} />}
        />
        <StatCard
          label="Daily capacity"
          value={fmtCompact(cap?.effectiveDaily ?? 0)}
          sublabel={`limited by ${cap?.bottleneck ?? "—"}`}
          tone="sky"
          icon={<Send size={18} />}
        />
        <StatCard
          label="Monthly capacity"
          value={fmtCompact(cap?.effectiveMonthly ?? 0)}
          sublabel="emails / month"
          tone="mint"
          icon={<Gauge size={18} />}
        />
        <StatCard
          label="Monthly cost"
          value={fmtMoney(monthly, currency)}
          sublabel={`${fmtMoney(annual, currency)} / yr`}
          tone="sun"
          icon={<DollarSign size={18} />}
        />
        <StatCard
          label="Leads"
          value={fmtNumber(leads.length)}
          sublabel={`${usedLeads} used`}
          tone="coral"
          icon={<Users size={18} />}
        />
      </div>

      {/* Live sending vs capacity — the "am I OK right now" answer, above the plan. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SendingHealthCard cap={cap} settings={settings} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Capacity utilisation */}
        <Card className="p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg">Sending capacity</h2>
            <Link to="/capacity" className="btn-ghost btn-sm">
              Capacity planner <ArrowUpRight size={14} />
            </Link>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border-2 border-ink bg-canvas p-3">
              <p className="text-xs font-bold uppercase text-muted">Effective / day</p>
              <p className="text-2xl font-extrabold">{fmtNumber(cap?.effectiveDaily ?? 0)}</p>
            </div>
            <div className="rounded-xl border-2 border-ink bg-canvas p-3">
              <p className="text-xs font-bold uppercase text-muted">Per mailbox / day</p>
              <p className="text-2xl font-extrabold">{cap?.perMailboxDaily ?? 0}</p>
            </div>
            <div className="rounded-xl border-2 border-ink bg-canvas p-3">
              <p className="text-xs font-bold uppercase text-muted">Effective / month</p>
              <p className="text-2xl font-extrabold">{fmtNumber(cap?.effectiveMonthly ?? 0)}</p>
            </div>
          </div>

          <div className="mt-5 space-y-4">
            {cap?.sources
              .filter((s) => s.kind === "sending")
              .map((s) => {
                const ceiling = s.period === "month" ? cap.effectiveMonthly : cap.effectiveDaily;
                const limitForBar = s.period === "month" ? s.monthly : s.daily;
                const pct = limitForBar > 0 ? (ceiling / limitForBar) * 100 : 0;
                return (
                  <div key={s.id}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-bold">{s.name}</span>
                      <span className="text-muted">
                        Using {fmtNumber(ceiling)} of {fmtNumber(limitForBar)} / {s.period}{" "}
                        ({fmtPercent(pct)})
                      </span>
                    </div>
                    <ProgressBar value={ceiling} max={limitForBar} color={s.color} />
                  </div>
                );
              })}
          </div>

          <div className="mt-4 rounded-xl border-2 border-ink bg-pink/30 p-3 text-sm font-semibold">
            Bottleneck: <span className="font-extrabold">{cap?.bottleneck}</span>. You can safely
            send up to <span className="font-extrabold">{fmtNumber(cap?.effectiveDaily ?? 0)}</span>{" "}
            emails/day.
          </div>
        </Card>

        {/* Campaign split */}
        <Card className="p-5">
          <h2 className="mb-2 text-lg">Domains by campaign</h2>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={campaignData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={45}
                  outerRadius={75}
                  stroke="#000"
                  strokeWidth={2}
                >
                  {campaignData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 space-y-1">
            {campaignData.map((c) => (
              <div key={c.name} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-semibold">
                  <span
                    className="h-3 w-3 rounded-full border border-ink"
                    style={{ background: c.color }}
                  />
                  {c.name}
                </span>
                <span className="font-bold">{c.value}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Expiry alerts */}
        <Card className="p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg">
              <AlertTriangle size={18} className="text-danger" /> Domains expiring in {window} days
            </h2>
            <Link to="/domains" className="btn-ghost btn-sm">
              All domains
            </Link>
          </div>
          {expiring.length === 0 ? (
            <p className="rounded-xl border-2 border-dashed border-ink/30 bg-white p-4 text-sm text-muted">
              Nothing expiring within {window} days. You're safe. 🎉
            </p>
          ) : (
            <div className="space-y-2">
              {expiring.map(({ d, days }) => (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-ink bg-white p-3"
                >
                  <div>
                    <p className="font-bold">{d.domain_name}</p>
                    <p className="text-xs text-muted">
                      {d.email_1} · {d.email_2}
                    </p>
                  </div>
                  <Badge tone={(days as number) <= 7 ? "danger" : (days as number) <= 14 ? "coral" : "sun"}>
                    {(days as number) < 0 ? "Expired" : `${days} days`}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Setup readiness */}
        <Card className="p-5">
          <h2 className="mb-3 text-lg">Setup readiness</h2>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={readiness} layout="vertical" margin={{ left: 10, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} hide />
                <YAxis
                  type="category"
                  dataKey="step"
                  width={90}
                  tick={{ fontSize: 12, fontWeight: 700 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip formatter={(v: number) => `${Math.round(v)}%`} />
                <Bar dataKey="value" fill="#FF90E8" stroke="#000" strokeWidth={2} radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
}
