import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  HeartPulse,
  ArrowRight,
  AlertTriangle,
  Copy,
  ChevronDown,
  ChevronRight,
  Check,
  Zap,
  Eye,
  Lock,
} from "lucide-react";
import { Card, StatCard, Badge, Spinner } from "../ui/primitives";
import { useToast } from "../ui/toast";
import type { Maintenance, MailboxHealth, SwapProposal } from "../../lib/mailboxHealth";
import { Plan } from "../../lib/campaignPlan";
import type { PlacementMap } from "../../lib/placement";
import { useQuery } from "@tanstack/react-query";
import { instantly } from "../../lib/instantly";
import {
  classifyWrite,
  formatAttempts,
  summariseWrites,
  type WriteVerdict,
} from "../../lib/writeResult";
import {
  archiveRows,
  recoveringEmails,
  sampleFor,
  summarise,
  viewFor,
  type ArchiveRow,
  type CurrentHealth,
  type RecoveryView,
} from "../../lib/recovery";
import { SwapArchive } from "./SwapArchive";
import { useInsert, useUpdate } from "../../lib/hooks";
import { AppSettings, RecoveryEntry, TABLES } from "../../lib/types";
import { fmtNumber } from "../../lib/format";
import { cn } from "../../lib/utils";
import { RecoveryPanel } from "./RecoveryPanel";

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

/** Inbox-vs-spam rate. Renders nothing when unmeasured — silence beats a zero. */
function PlaceBadge({ email, placement }: { email: string; placement: PlacementMap | null }) {
  const p = placement?.get(email);
  if (!p || p.inboxRate === null) return null;
  const rate = Math.round(p.inboxRate);
  const tone = rate >= 90 ? "mint" : rate >= 80 ? "sky" : rate >= 50 ? "sun" : "danger";
  return (
    <Badge tone={tone} className={undefined}>
      {rate}% inbox
    </Badge>
  );
}

export function CampaignMaintenance({
  plan,
  maintenance,
  settings,
  placement,
  placementChecked,
  placementLoading,
  recovery,
  healthByEmail,
  onApplied,
}: {
  plan: Plan;
  // Computed once by the page and shared with the per-campaign breakdown, so
  // the two views can never disagree about an address.
  maintenance: Maintenance | null;
  settings: AppSettings;
  placement: PlacementMap | null;
  placementChecked: number;
  placementLoading: boolean;
  recovery: RecoveryEntry[];
  healthByEmail: Map<string, MailboxHealth>;
  onApplied: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [altIdx, setAltIdx] = useState<Map<string, number>>(new Map());
  const [applying, setApplying] = useState<string | null>(null);
  const [preview, setPreview] = useState<Map<string, string>>(new Map());
  const [busyRecovery, setBusyRecovery] = useState<string | null>(null);

  // Asked once, before any button is offered: are writes permitted at all?
  // Touches nothing in Instantly.
  const capsQ = useQuery({
    queryKey: ["inst", "write-caps"],
    queryFn: () => instantly.writeCapabilities(),
    staleTime: 5 * 60_000,
  });
  const writesEnabled = capsQ.data?.writesEnabled !== false;
  const writesHint = capsQ.data?.hint ?? null;

  const insertRecovery = useInsert<RecoveryEntry>(TABLES.recovery);
  const updateRecovery = useUpdate<RecoveryEntry>(TABLES.recovery);

  const m = maintenance;
  const minScore =
    (settings as unknown as Record<string, number>).maintenance_min_warmup_score ?? 80;

  const recoveryViews: RecoveryView[] = useMemo(
    () =>
      recovery.map((e) =>
        viewFor(e, healthByEmail.get(e.email)?.score ?? null, minScore),
      ),
    [recovery, healthByEmail, minScore],
  );
  const recoveryStats = useMemo(() => summarise(recoveryViews), [recoveryViews]);

  // The archive spans every status, so it reads the same live health map the
  // rest of the tab uses rather than a second source of truth.
  const archive: ArchiveRow[] = useMemo(() => {
    const current = new Map<string, CurrentHealth>();
    for (const [email, h] of healthByEmail) {
      current.set(email, { score: h.score, inboxRate: h.inboxRate });
    }
    return archiveRows(recovery, current, minScore);
  }, [recovery, healthByEmail, minScore]);

  // Take one score reading per recovering mailbox per day, so the trend is real
  // history. sampleFor() returns null when today's point already exists and
  // hasn't moved, which keeps a page refresh from writing anything.
  const sampledRef = useRef(false);
  useEffect(() => {
    if (sampledRef.current || recovery.length === 0 || healthByEmail.size === 0) return;
    sampledRef.current = true;
    for (const e of recovery) {
      if (e.status !== "recovering") continue;
      const h = healthByEmail.get(e.email);
      const history = sampleFor(e, h?.score ?? null, h?.inboxRate ?? null);
      if (history) void updateRecovery.mutateAsync({ id: e.id, patch: { history } });
    }
    // updateRecovery is a stable mutation object; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recovery, healthByEmail]);

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

  /** Show exactly what would change, without changing anything. */
  async function dryRun(p: SwapProposal, to: MailboxHealth) {
    setApplying(p.id);
    const lines: string[] = [];
    for (const c of p.campaigns) {
      const res = await instantly.setCampaignEmails(
        { campaignId: c.id, remove: p.bad.box.email, add: to.box.email, expectedList: c.emailListNow },
        true,
      );
      lines.push(
        res.ok
          ? `${c.name}: ${res.before?.length ?? 0} mailboxes → ${res.after?.length ?? 0} (${p.bad.box.email} out, ${to.box.email} in)`
          : `${c.name}: ${res.error}`,
      );
    }
    setPreview((s) => new Map(s).set(p.id, lines.join("\n")));
    setApplying(null);
  }

  /**
   * Apply the swap for real. Each campaign is a separate read-modify-write on
   * the server, so a partial failure leaves the rest correct and is reported
   * rather than hidden. The recovery entry is written only if at least one
   * campaign actually changed.
   */
  async function applySwap(p: SwapProposal, to: MailboxHealth) {
    const label = `${p.bad.box.email} → ${to.box.email}`;
    const confirmed = window.confirm(
      `Swap ${label} on ${p.campaigns.length} live campaign${p.campaigns.length === 1 ? "" : "s"}?\n\n` +
        p.campaigns.map((c) => `• ${c.name}`).join("\n") +
        `\n\nThis edits campaigns that are sending right now.`,
    );
    if (!confirmed) return;

    setApplying(p.id);
    const verdicts: WriteVerdict[] = [];
    const trace: string[] = [];
    const done: string[] = [];

    for (const c of p.campaigns) {
      const res = await instantly.setCampaignEmails({
        campaignId: c.id,
        remove: p.bad.box.email,
        add: to.box.email,
        expectedList: c.emailListNow,
      });
      const verdict = classifyWrite(res, c.name);
      verdicts.push(verdict);
      trace.push(formatAttempts(res, c.name));
      // ONLY a confirmed write counts. An unconfirmed one is not a success.
      if (verdict.confirmed) done.push(c.name);
      if (res.writesDisabled) break; // no point retrying the rest
    }

    setPreview((s) => new Map(s).set(p.id, trace.join("\n\n")));

    if (done.length > 0) {
      const already = recoveringEmails(recovery).has(p.bad.box.email);
      if (!already) {
        await insertRecovery.mutateAsync({
          email: p.bad.box.email,
          swapped_out_at: new Date().toISOString(),
          score_at_swap: p.bad.score,
          inbox_rate_at_swap: p.bad.inboxRate,
          replaced_by: to.box.email,
          campaign_ids: p.campaigns.map((c) => c.id),
          campaign_names: p.campaigns.map((c) => c.name),
          status: "recovering",
          released_at: null,
          restored_at: null,
          restored_campaigns: [],
          reason: p.bad.issues.filter((i) => i.triggersReplacement).map((i) => i.label).join("; "),
          history: [],
        } as Partial<RecoveryEntry>);
      }
      onApplied();
    }

    setApplying(null);
    const summary = summariseWrites(verdicts);
    toast.push(summary.message, summary.tone);
  }

  /** Reverse a swap without touching anything — shows the exact before/after. */
  async function previewUndo(row: ArchiveRow) {
    const e = row.entry;
    setBusyRecovery(e.id);
    const lines: string[] = [];
    for (let i = 0; i < e.campaign_ids.length; i++) {
      const id = e.campaign_ids[i];
      const label = e.campaign_names[i] ?? id;
      const res = await instantly.setCampaignEmails(
        { campaignId: id, remove: e.replaced_by, add: e.email },
        true,
      );
      lines.push(
        res.ok
          ? `${label}: ${e.replaced_by} out, ${e.email} back in (${res.before?.length ?? 0} mailboxes)`
          : `${label}: ${res.error}`,
      );
    }
    setPreview((s) => new Map(s).set(e.id, lines.join("\n")));
    setBusyRecovery(null);
  }

  /**
   * Put a swapped-out mailbox back where it came from. This is the exact
   * inverse of applySwap — same server op, `remove` and `add` reversed — so it
   * inherits the same guards: it refuses if the replacement is no longer
   * attached, or if the original is already back.
   */
  async function undoSwap(row: ArchiveRow) {
    const e = row.entry;
    const warning = row.stillUnhealthy
      ? `\n\n⚠ ${e.email} is still at score ${row.scoreNow}, below the bar it was pulled for. Swapping it back puts the original problem into a live campaign.`
      : "";
    const confirmed = window.confirm(
      `Swap ${e.email} back in place of ${e.replaced_by}?\n\n` +
        `Campaigns: ${e.campaign_names.join(", ") || e.campaign_ids.join(", ")}\n` +
        `Score at swap: ${row.scoreAtSwap ?? "unknown"} → now: ${row.scoreNow ?? "unknown"}\n` +
        `Originally pulled for: ${e.reason || "no reason recorded"}` +
        warning,
    );
    if (!confirmed) return;

    setBusyRecovery(e.id);
    const verdicts: WriteVerdict[] = [];
    const trace: string[] = [];
    const doneIds: string[] = [];

    for (let i = 0; i < e.campaign_ids.length; i++) {
      const id = e.campaign_ids[i];
      const label = e.campaign_names[i] ?? id;
      const res = await instantly.setCampaignEmails({
        campaignId: id,
        remove: e.replaced_by,
        add: e.email,
      });
      const verdict = classifyWrite(res, label);
      verdicts.push(verdict);
      trace.push(formatAttempts(res, label));
      // Only mark it restored when Instantly confirmed it. An unconfirmed
      // write must not rewrite the archive to say the swap was reversed.
      if (verdict.confirmed) doneIds.push(id);
      if (res.writesDisabled) break;
    }

    setPreview((s) => new Map(s).set(e.id, trace.join("\n\n")));

    if (doneIds.length > 0) {
      await updateRecovery.mutateAsync({
        id: e.id,
        patch: {
          status: "restored",
          restored_at: new Date().toISOString(),
          restored_campaigns: doneIds,
        },
      });
      onApplied();
    }

    setBusyRecovery(null);
    const summary = summariseWrites(verdicts);
    toast.push(summary.message, summary.tone);
  }

  async function returnToService(v: RecoveryView) {
    setBusyRecovery(v.entry.id);
    await updateRecovery.mutateAsync({
      id: v.entry.id,
      patch: { status: "recovered", released_at: new Date().toISOString() },
    });
    setBusyRecovery(null);
    toast.push(`${v.entry.email} is back in the spare pool`, "success");
  }

  async function retire(v: RecoveryView) {
    if (!window.confirm(`Retire ${v.entry.email}? It will never be proposed as a replacement again.`)) {
      return;
    }
    setBusyRecovery(v.entry.id);
    await updateRecovery.mutateAsync({
      id: v.entry.id,
      patch: { status: "retired", released_at: new Date().toISOString() },
    });
    setBusyRecovery(null);
    toast.push(`${v.entry.email} retired`, "info");
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

  if (!m) return null;

  const totalBoxes = m.mailboxes.length;

  return (
    <div className="space-y-4">
      {/* Writes off is the single most common reason a swap silently does
          nothing, so it's stated up front rather than discovered by clicking. */}
      {!writesEnabled ? (
        <Card className="flex items-start gap-2 border-danger bg-danger/10 p-4 text-sm">
          <Lock size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-extrabold">Writes to Instantly are turned off</p>
            <p className="mt-1 text-xs">
              {writesHint ??
                "Add INSTANTLY_WRITE_ENABLED=true to your Netlify environment variables."}
            </p>
            <p className="mt-1 text-xs">
              Netlify → Site configuration → Environment variables → add{" "}
              <code>INSTANTLY_WRITE_ENABLED</code> = <code>true</code>, scope{" "}
              <b>Functions</b>, then redeploy. Until then Apply and Swap back do nothing —
              Preview still works, since it writes nothing.
            </p>
          </div>
        </Card>
      ) : null}

      {/* Placement coverage. Stated explicitly because partial coverage looks
          identical to a clean bill of health if you don't say so. */}
      <Card className="flex flex-wrap items-center gap-2 p-3 text-xs">
        {placementLoading ? (
          <>
            <Spinner /> <span>Checking inbox-vs-spam placement…</span>
          </>
        ) : placementChecked === 0 ? (
          <span className="text-muted">
            No inbox-vs-spam data reported yet — mailboxes are scored on warmup score alone.
            Placement appears once Instantly's warmup analytics has sent enough test mail.
          </span>
        ) : (
          <span>
            <b>Placement measured on {placementChecked}</b> of {totalBoxes} mailbox
            {totalBoxes === 1 ? "" : "es"}.
            {placementChecked < totalBoxes
              ? " The rest have no warmup data yet and are scored on warmup score alone."
              : ""}
          </span>
        )}
      </Card>

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
          sublabel={
            m.shortfall > 0
              ? recoveryStats.recovering > 0
                ? `${recoveryStats.recovering} recovering, ${recoveryStats.eligible} ready to return`
                : "no spare available"
              : "all covered"
          }
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
                  <PlaceBadge email={p.bad.box.email} placement={placement} />
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
                  <PlaceBadge email={to.box.email} placement={placement} />
                  <span className="text-[11px] text-muted">{p.reasons.join(" · ")}</span>
                </div>
              </div>
              <div className="ml-auto flex shrink-0 flex-wrap gap-2">
                {p.alternatives.length > 0 ? (
                  <button className="btn-ghost btn-sm" onClick={() => cycle(p)} disabled={applying === p.id}>
                    Different inbox
                  </button>
                ) : null}
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => void dryRun(p, to)}
                  disabled={applying === p.id}
                  title="Show exactly what would change, without changing it"
                >
                  <Eye size={14} /> Preview
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void applySwap(p, to)}
                  disabled={applying === p.id || !writesEnabled}
                  title={
                    writesEnabled
                      ? "Edit these campaigns in Instantly now"
                      : "Writes are disabled — set INSTANTLY_WRITE_ENABLED=true"
                  }
                >
                  {applying === p.id ? <Spinner /> : <Zap size={14} />} Apply swap
                </button>
                <button className="btn-ghost btn-sm" onClick={() => copySteps(p, to)}>
                  <Copy size={14} /> Copy steps
                </button>
                <button className="btn-ghost btn-sm" onClick={() => toggle(p.id)}>
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} How
                </button>
              </div>
            </div>

            {preview.has(p.id) ? (
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border-2 border-ink bg-canvas p-2 text-[11px]">
                {preview.get(p.id)}
              </pre>
            ) : null}

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

      <RecoveryPanel
        views={recoveryViews}
        minScore={minScore}
        onReturn={(v) => void returnToService(v)}
        onRetire={(v) => void retire(v)}
        busy={busyRecovery}
      />

      <SwapArchive
        rows={archive}
        onUndo={(r) => void undoSwap(r)}
        onPreview={(r) => void previewUndo(r)}
        busy={busyRecovery}
        preview={preview}
        writesEnabled={writesEnabled}
      />

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
