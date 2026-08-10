import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HeartPulse, ArrowRight, AlertTriangle, Copy, ChevronDown, ChevronRight, Check } from "lucide-react";
import { Card, StatCard, Badge } from "../ui/primitives";
import { useToast } from "../ui/toast";
import { computeMaintenance, type MailboxHealth, type SwapProposal } from "../../lib/mailboxHealth";
import { Plan } from "../../lib/campaignPlan";
import { AppSettings, Domain } from "../../lib/types";
import { fmtNumber } from "../../lib/format";
import { cn } from "../../lib/utils";

const SEV_TONE: Record<string, "danger" | "sun" | "sky"> = {
  critical: "danger",
  warn: "sun",
  watch: "sky",
};

function ScoreBadge({ m }: { m: MailboxHealth }) {
  if (m.score === null) return <Badge tone="white">no score</Badge>;
  const tone = m.score >= 85 ? "mint" : m.score >= 70 ? "sky" : m.score >= 50 ? "sun" : "danger";
  return <Badge tone={tone}>{m.score}</Badge>;
}

export function CampaignMaintenance({
  plan,
  domains,
  settings,
}: {
  plan: Plan;
  domains: Domain[];
  settings: AppSettings;
}) {
  const toast = useToast();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [altIdx, setAltIdx] = useState<Map<string, number>>(new Map());

  const m = useMemo(
    () => computeMaintenance({ plan, domains, settings }),
    [plan, domains, settings],
  );

  function toggle(id: string) {
    setOpen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  // Cycle through the runners-up when the operator doesn't like the top pick.
  function chosenFor(p: SwapProposal): MailboxHealth {
    const i = altIdx.get(p.id) ?? 0;
    return i === 0 ? p.replacement : p.alternatives[i - 1] ?? p.replacement;
  }
  function cycle(p: SwapProposal) {
    const max = p.alternatives.length;
    setAltIdx((s) => new Map(s).set(p.id, ((s.get(p.id) ?? 0) + 1) % (max + 1)));
  }

  function copySteps(p: SwapProposal, to: MailboxHealth) {
    const text = p.campaigns
      .map(
        (c) =>
          `Instantly → Campaigns → ${c.name} → Accounts: untick ${p.bad.box.email}, tick ${to.box.email}`,
      )
      .join("\n");
    void navigator.clipboard?.writeText(text);
    toast.push("Steps copied", "success");
  }

  if (!plan.linkageAvailable) {
    return (
      <Card className="flex items-start gap-2 bg-sun/30 p-4 text-sm">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <p>
          Maintenance needs the mailbox list attached to each campaign (<code>email_list</code>),
          which Instantly didn't return — so there's nothing to check per campaign yet.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Need replacing"
          value={m.proposals.length + m.shortfall}
          sublabel={m.stats.critical > 0 ? `${m.stats.critical} critical` : "in live campaigns"}
          tone={m.proposals.length + m.shortfall > 0 ? "danger" : "mint"}
          icon={<HeartPulse size={18} />}
        />
        <StatCard label="Healthy spares" value={m.candidates.length} sublabel="free to swap in" tone="mint" />
        <StatCard
          label="Shortfall"
          value={m.shortfall}
          sublabel={m.shortfall > 0 ? "no spare available" : "all covered"}
          tone={m.shortfall > 0 ? "danger" : "white"}
        />
        <StatCard label="Warming" value={m.stats.ramping} sublabel="low score, but still new" tone="lavender" />
      </div>

      {m.proposals.length === 0 && m.shortfall === 0 ? (
        <Card className="flex items-center gap-2 border-mint bg-mint/10 p-6 text-sm font-bold">
          <Check size={18} /> Every mailbox in a live campaign is healthy.
        </Card>
      ) : null}

      {m.proposals.map((p) => {
        const to = chosenFor(p);
        const isOpen = open.has(p.id);
        return (
          <Card key={p.id} className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0">
                <p className="truncate font-bold">{p.bad.box.email}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <ScoreBadge m={p.bad} />
                  {p.bad.issues
                    .filter((i) => i.triggersReplacement)
                    .map((i) => (
                      <Badge key={i.code} tone={SEV_TONE[i.severity]}>
                        {i.label}
                      </Badge>
                    ))}
                </div>
              </div>
              <ArrowRight size={18} className="shrink-0" />
              <div className="min-w-0">
                <p className="truncate font-bold">{to.box.email}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <ScoreBadge m={to} />
                  <span className="text-[11px] text-muted">{p.reasons.join(" · ")}</span>
                </div>
              </div>
              <div className="ml-auto flex shrink-0 flex-wrap gap-2">
                {p.alternatives.length > 0 ? (
                  <button className="btn-ghost btn-sm" onClick={() => cycle(p)}>
                    Different inbox
                  </button>
                ) : null}
                <button className="btn-ghost btn-sm" onClick={() => copySteps(p, to)}>
                  <Copy size={14} /> Copy steps
                </button>
                <button className="btn-ghost btn-sm" onClick={() => toggle(p.id)}>
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} How
                </button>
              </div>
            </div>

            {p.warnings.length > 0 ? (
              <p className="mt-2 rounded-lg border-2 border-ink bg-sun/30 p-2 text-xs font-semibold">
                {p.warnings.join(" ")}
              </p>
            ) : null}

            {isOpen ? (
              <div className="mt-3 rounded-xl border-2 border-ink bg-canvas p-3 text-sm">
                <p className="mb-1 text-xs font-bold uppercase text-muted">
                  Do this in Instantly ({p.campaigns.length} campaign
                  {p.campaigns.length === 1 ? "" : "s"})
                </p>
                <ol className="list-decimal space-y-1 pl-5 text-xs">
                  {p.campaigns.map((c) => (
                    <li key={c.id}>
                      <b>{c.name}</b> → Accounts → untick <code>{p.bad.box.email}</code>, tick{" "}
                      <code>{to.box.email}</code>
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-[11px] text-muted">
                  Capacity change: {p.capacityDelta >= 0 ? "+" : ""}
                  {fmtNumber(p.capacityDelta)}/day. Swapping protects deliverability — it doesn't add
                  capacity.
                </p>
              </div>
            ) : null}
          </Card>
        );
      })}

      {m.unassigned.length > 0 ? (
        <Card className="bg-danger/10 p-4 text-sm">
          <p className="flex items-center gap-2 font-extrabold">
            <AlertTriangle size={16} /> {m.unassigned.length} mailbox
            {m.unassigned.length === 1 ? "" : "es"} with no healthy spare
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {m.unassigned.map((u) => (
              <li key={u.box.email}>
                <b>{u.box.email}</b> — {u.issues.filter((i) => i.triggersReplacement).map((i) => i.label).join(", ")}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            You need {m.unassigned.length} more warmed inbox
            {m.unassigned.length === 1 ? "" : "es"} (~
            {Math.ceil(m.unassigned.length / Math.max(1, settings.emails_per_domain))} domain
            {Math.ceil(m.unassigned.length / Math.max(1, settings.emails_per_domain)) === 1 ? "" : "s"}
            ). Until then these campaigns keep sending from damaged inboxes.
          </p>
        </Card>
      ) : null}

      {/* Everything that's flagged but not a swap — domain and warmup config issues */}
      {(() => {
        const advisories = m.mailboxes.filter(
          (x) => x.verdict !== "replace" && x.issues.some((i) => i.severity !== "watch"),
        );
        if (advisories.length === 0) return null;
        return (
          <Card className="p-4">
            <p className="mb-2 text-sm font-bold">Worth fixing (no swap needed)</p>
            <div className="space-y-1.5">
              {advisories.slice(0, 12).map((x) => (
                <div key={x.box.email} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold">{x.box.email}</span>
                  {x.issues
                    .filter((i) => i.severity !== "watch")
                    .map((i) => (
                      <Badge key={i.code} tone={SEV_TONE[i.severity]}>
                        {i.label}
                      </Badge>
                    ))}
                  {x.issues.some((i) => i.code.startsWith("domain")) ? (
                    <Link to="/domains" className="underline">
                      fix domain
                    </Link>
                  ) : null}
                </div>
              ))}
            </div>
          </Card>
        );
      })()}

      {m.untrackedDomains > 0 ? (
        <p className={cn("text-[11px] text-muted")}>
          {m.untrackedDomains} mailbox{m.untrackedDomains === 1 ? "" : "es"} sit on domains not in
          your Domains list, so expiry and DNS couldn't be checked for them.
        </p>
      ) : null}
    </div>
  );
}
