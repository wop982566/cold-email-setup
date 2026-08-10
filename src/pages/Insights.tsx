import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  HeartPulse,
  TrendingUp,
  Lightbulb,
  Filter,
  AlertTriangle,
  Mail,
  DollarSign,
} from "lucide-react";
import { Card, StatCard, ProgressBar, Badge } from "../components/ui/primitives";
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
import { totalMonthly } from "../lib/costs";
import { daysUntil, fmtMoney, fmtNumber, fmtPercent } from "../lib/format";
import { parseISO, format, isValid } from "date-fns";

export default function Insights() {
  const { data: domains = [] } = useCollection<Domain>(TABLES.domains);
  const { data: leads = [] } = useCollection<Lead>(TABLES.leads);
  const { data: campaigns = [] } = useCollection<Campaign>(TABLES.campaigns);
  const { data: capacitySources = [] } = useCollection<CapacitySource>(TABLES.capacity);
  const { data: costs = [] } = useCollection<CostItem>(TABLES.costs);
  const { data: settings } = useSettings();

  const cap = settings ? computeCapacity(domains, capacitySources, settings) : null;
  const currency = settings?.currency ?? "USD";

  // Domain health: average across 5 readiness checks.
  const health = useMemo(() => {
    if (domains.length === 0) return 0;
    const score = (d: Domain) => {
      const checks = [
        d.dns_status === "Yes",
        d.mailing_status === "Yes",
        d.connected_to_instantly === "Yes",
        d.warmup_started === "Yes",
        d.gmail_send_configured === "Yes" || d.gmail_send_configured === "NA",
      ];
      return checks.filter(Boolean).length / checks.length;
    };
    return (domains.reduce((s, d) => s + score(d), 0) / domains.length) * 100;
  }, [domains]);

  const funnel = useMemo(() => {
    const order: { key: Lead["status"]; label: string; color: string }[] = [
      { key: "new", label: "New", color: "#90DDFF" },
      { key: "enriched", label: "Enriched", color: "#DAD3FF" },
      { key: "queued", label: "Queued", color: "#FFC900" },
      { key: "used", label: "Used", color: "#FF90E8" },
      { key: "replied", label: "Replied", color: "#23A094" },
    ];
    return order.map((o) => ({
      name: o.label,
      value: leads.filter((l) => l.status === o.key).length,
      color: o.color,
    }));
  }, [leads]);

  const leadsPerCampaign = useMemo(() => {
    return campaigns.map((c) => ({
      name: c.name,
      value: leads.filter((l) => l.used_in_campaign_id === c.id).length,
      color: c.color,
    }));
  }, [campaigns, leads]);

  const expiryByMonth = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of domains) {
      if (!d.expiry_date) continue;
      const dt = parseISO(d.expiry_date);
      if (!isValid(dt)) continue;
      const k = format(dt, "MMM yyyy");
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
  }, [domains]);

  const monthly = totalMonthly(costs, { monthlyEmails: cap?.effectiveMonthly });
  const leadsReachable =
    settings && settings.default_sends_per_lead > 0 && cap
      ? Math.floor(cap.effectiveMonthly / settings.default_sends_per_lead)
      : 0;
  const costPerLead = leadsReachable > 0 ? monthly / leadsReachable : 0;

  // Opportunities
  const opportunities = useMemo(() => {
    const out: { icon: JSX.Element; text: string; tone: "danger" | "coral" | "sun" | "mint" }[] = [];
    const notInstantly = domains.filter((d) => d.connected_to_instantly !== "Yes").length;
    if (notInstantly > 0)
      out.push({
        icon: <Mail size={16} />,
        text: `${notInstantly} domain(s) not fully connected to Instantly — connect them to unlock more sending capacity.`,
        tone: "coral",
      });
    const notWarm = domains.filter((d) => d.warmup_started !== "Yes").length;
    if (notWarm > 0)
      out.push({
        icon: <TrendingUp size={16} />,
        text: `${notWarm} domain(s) without warmup started — start warmup before scaling sends.`,
        tone: "sun",
      });
    const expiring = domains.filter((d) => {
      const days = daysUntil(d.expiry_date);
      return days !== null && days <= (settings?.reminder_window_days ?? 30);
    }).length;
    if (expiring > 0)
      out.push({
        icon: <AlertTriangle size={16} />,
        text: `${expiring} domain(s) expiring soon — renew to avoid losing sending infrastructure.`,
        tone: "danger",
      });
    if (cap) {
      const sesDaily = cap.sources.find((s) => s.name.toLowerCase().includes("ses"))?.daily ?? 0;
      const headroom = Math.round(sesDaily - cap.mailboxDaily);
      if (headroom > 1000)
        out.push({
          icon: <Lightbulb size={16} />,
          text: `You have ~${fmtNumber(headroom)} emails/day of unused server headroom. Add mailboxes/domains to use it.`,
          tone: "mint",
        });
    }
    const unusedLeads = leads.filter((l) => l.status === "new").length;
    if (unusedLeads > 0)
      out.push({
        icon: <Filter size={16} />,
        text: `${fmtNumber(unusedLeads)} fresh lead(s) not yet used — build a sub-list and queue them.`,
        tone: "sun",
      });
    return out;
  }, [domains, leads, cap, settings]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Domain health" value={fmtPercent(health)} sublabel="avg readiness" tone="mint" icon={<HeartPulse size={18} />} />
        <StatCard label="Capacity used" value={fmtPercent(cap?.monthlyUsedPct ?? 0)} sublabel="of monthly ceiling" tone="pink" icon={<TrendingUp size={18} />} />
        <StatCard label="Reachable leads/mo" value={fmtNumber(leadsReachable)} tone="lavender" icon={<Mail size={18} />} />
        <StatCard label="Cost / reachable lead" value={fmtMoney(costPerLead, currency)} tone="sun" icon={<DollarSign size={18} />} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 text-lg">Lead funnel</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={funnel}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12, fontWeight: 700 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="value" stroke="#000" strokeWidth={2} radius={[6, 6, 0, 0]}>
                  {funnel.map((e, i) => (
                    <Cell key={i} fill={e.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-lg">Leads used per campaign</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={leadsPerCampaign}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fontWeight: 700 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="value" stroke="#000" strokeWidth={2} radius={[6, 6, 0, 0]}>
                  {leadsPerCampaign.map((e, i) => (
                    <Cell key={i} fill={e.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 text-lg">Domains expiring by month</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={expiryByMonth}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fontWeight: 700 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="value" fill="#FF7051" stroke="#000" strokeWidth={2} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg">
            <Lightbulb size={18} /> Opportunities
          </h2>
          {opportunities.length === 0 ? (
            <p className="text-sm text-muted">Everything looks optimized. 🎉</p>
          ) : (
            <div className="space-y-2">
              {opportunities.map((o, i) => (
                <div key={i} className="flex items-start gap-3 rounded-xl border-2 border-ink bg-white p-3">
                  <Badge tone={o.tone}>{o.icon}</Badge>
                  <p className="text-sm font-semibold">{o.text}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="mb-3 text-lg">Capacity utilisation</h2>
        <div className="mb-1 flex justify-between text-sm font-semibold">
          <span>
            {fmtNumber(cap?.monthlyUsed ?? 0)} / {fmtNumber(cap?.effectiveMonthly ?? 0)} emails this month
          </span>
          <span>{fmtPercent(cap?.monthlyUsedPct ?? 0)}</span>
        </div>
        <ProgressBar value={cap?.monthlyUsed ?? 0} max={cap?.effectiveMonthly || 1} color="#FF90E8" height={18} />
        <p className="mt-2 text-xs text-muted">
          Set "currently used" on a provider limit (Capacity page) to track this against your real sends.
        </p>
      </Card>
    </div>
  );
}
