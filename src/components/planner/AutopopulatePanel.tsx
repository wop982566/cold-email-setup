// ---------------------------------------------------------------------------
// Autopopulate: fill every campaign that's short of its daily sending limit
// with IDLE inboxes of its own niche, then keep a durable record of exactly
// which inboxes were added where.
//
// Nothing is written blind: the button computes a preview (pure
// `planAutopopulate`), shows per-campaign what it would add and why some
// campaigns can't be filled, and only writes on confirm — each add verified by
// the server the same way a swap is, so an unconfirmed write is never counted.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Wand2, ArrowRight, AlertTriangle, Check, Copy, Bot } from "lucide-react";
import { Card, Badge, Spinner, Details } from "../ui/primitives";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/toast";
import { useQuery } from "@tanstack/react-query";
import { instantly } from "../../lib/instantly";
import { classifyWrite, formatAttempts, summariseWrites, type WriteVerdict } from "../../lib/writeResult";
import { planAutopopulate, type AutopopulatePlan } from "../../lib/autopopulate";
import type { Plan } from "../../lib/campaignPlan";
import type { MailboxHealth } from "../../lib/mailboxHealth";
import type { TagMap } from "../../lib/tags";
import { useCollection, useInsert } from "../../lib/hooks";
import { PopulateRun, TABLES } from "../../lib/types";
import { fmtDateShort, fmtNumber } from "../../lib/format";

function copy(text: string, toast: ReturnType<typeof useToast>) {
  void navigator.clipboard?.writeText(text);
  toast.push("Copied", "success");
}

export function AutopopulatePanel({
  plan,
  tagMap,
  campaignTagsById,
  overrides,
  healthByEmail,
  onApplied,
}: {
  plan: Plan;
  tagMap: TagMap;
  campaignTagsById: Map<string, string[]>;
  overrides: Record<string, string>;
  healthByEmail: Map<string, MailboxHealth>;
  onApplied: () => void;
}) {
  const toast = useToast();

  const capsQ = useQuery({
    queryKey: ["inst", "write-caps"],
    queryFn: () => instantly.writeCapabilities(),
    staleTime: 5 * 60_000,
  });
  const writesEnabled = capsQ.data?.writesEnabled !== false;
  const writesHint = capsQ.data?.hint ?? null;

  const runsQ = useCollection<PopulateRun>(TABLES.populateRuns);
  const insertRun = useInsert<PopulateRun>(TABLES.populateRuns);

  const [preview, setPreview] = useState<AutopopulatePlan | null>(null);
  const [busy, setBusy] = useState(false);

  // planAutopopulate only wants maturity + health for ranking, not the whole record.
  const healthLite = useMemo(() => {
    const m = new Map<string, { mature: boolean; healthScore: number | null }>();
    for (const [email, h] of healthByEmail) m.set(email.toLowerCase(), { mature: h.mature, healthScore: h.healthScore });
    return m;
  }, [healthByEmail]);

  function openPreview() {
    setPreview(
      planAutopopulate({
        campaigns: plan.campaigns,
        idle: plan.idleMailboxes,
        tagMap,
        campaignTagsById,
        overrides,
        healthByEmail: healthLite,
      }),
    );
  }

  const toFill = preview?.plans.filter((p) => p.add.length > 0) ?? [];
  const skipped = preview?.plans.filter((p) => p.add.length === 0) ?? [];
  const totalToAdd = toFill.reduce((n, p) => n + p.add.length, 0);

  async function apply() {
    if (!preview) return;
    setBusy(true);
    const campById = new Map(plan.campaigns.map((c) => [c.id, c]));
    const logCampaigns: PopulateRun["campaigns"] = [];
    const logLines: string[] = [];
    const verdicts: WriteVerdict[] = [];
    try {
      for (const p of toFill) {
        const camp = campById.get(p.campaignId);
        const emails = p.add.map((a) => a.email);
        const res = await instantly.addCampaignEmails({
          campaignId: p.campaignId,
          add: emails,
          expectedList: camp?.emails,
        });
        const label = `populate ${p.campaignName}`;
        const verdict = classifyWrite(res, label);
        verdicts.push(verdict);
        logLines.push(formatAttempts(res, label));
        logCampaigns.push({
          campaignId: p.campaignId,
          campaignName: p.campaignName,
          added: verdict.confirmed ? emails : [],
          beforeCount: res.before?.length ?? camp?.emails.length ?? 0,
          afterCount: res.after?.length ?? camp?.emails.length ?? 0,
          outcome: verdict.outcome,
          error: verdict.outcome === "applied" ? undefined : verdict.message,
        });
      }
      const totalAdded = logCampaigns.reduce((n, c) => n + c.added.length, 0);
      await insertRun.mutateAsync({
        ran_at: new Date().toISOString(),
        campaigns: logCampaigns,
        totalAdded,
        log: logLines,
      } as Partial<PopulateRun>);
      const summary = summariseWrites(verdicts);
      toast.push(`Autopopulate — ${summary.message}`, summary.tone);
      setPreview(null);
      onApplied();
    } catch (err) {
      toast.push(`Autopopulate failed: ${err instanceof Error ? err.message : "error"}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const runs = [...(runsQ.data ?? [])]
    .sort((a, b) => (b.ran_at ?? "").localeCompare(a.ran_at ?? ""))
    .slice(0, 5);

  return (
    <>
      <Card className="p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-2 text-sm font-extrabold">
            <Wand2 size={15} /> Autopopulate campaigns
          </p>
          <button
            className="btn-primary btn-sm ml-auto"
            onClick={openPreview}
            disabled={!writesEnabled}
            title={
              writesEnabled
                ? "Fill campaigns short of their daily limit with matching-niche idle inboxes"
                : "Writes are off"
            }
          >
            <Wand2 size={14} /> Autopopulate…
          </button>
        </div>
        <p className="mt-0.5 text-[11px] text-muted">
          Adds idle inboxes to each campaign that's below its daily sending limit — only inboxes whose
          niche tag matches the campaign's, each used once. Preview before anything is written.
        </p>
        {!writesEnabled ? (
          <p className="mt-2 flex items-start gap-1.5 rounded-lg border-2 border-ink bg-sun/30 p-2 text-[11px]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{writesHint ?? "Writes are disabled — set INSTANTLY_WRITE_ENABLED=true to populate campaigns."}</span>
          </p>
        ) : null}

        {/* Durable "which emails were populated" log. */}
        {runs.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            {runs.map((run) => (
              <div key={run.id} className="rounded-lg border-2 border-ink bg-canvas p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{fmtDateShort(run.ran_at)}</span>
                  <Badge tone={run.totalAdded > 0 ? "mint" : "white"}>{run.totalAdded} inboxes populated</Badge>
                  {run.campaigns.some((c) => c.outcome === "failed") ? (
                    <Badge tone="danger">{run.campaigns.filter((c) => c.outcome === "failed").length} failed</Badge>
                  ) : null}
                  {run.campaigns.some((c) => c.outcome === "unconfirmed") ? (
                    <Badge tone="sun">
                      {run.campaigns.filter((c) => c.outcome === "unconfirmed").length} unconfirmed
                    </Badge>
                  ) : null}
                </div>
                {run.campaigns.map((c, i) => (
                  <p key={i} className="mt-1 flex flex-wrap items-center gap-1">
                    {c.outcome === "applied" ? (
                      <Check size={12} className="shrink-0 text-mint" />
                    ) : (
                      <AlertTriangle size={12} className="shrink-0 text-danger" />
                    )}
                    <span className="font-semibold">{c.campaignName}</span>
                    <span className="text-muted">
                      +{c.added.length} ({c.beforeCount}→{c.afterCount})
                    </span>
                    {c.added.length > 0 ? (
                      <span className="text-muted">— {c.added.join(", ")}</span>
                    ) : null}
                    {c.error ? <span className="text-danger">{c.error}</span> : null}
                  </p>
                ))}
                {(run.log ?? []).length > 0 ? (
                  <Details summary="Write detail">
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border-2 border-ink bg-white p-2 text-[11px]">
                      {(run.log ?? []).join("\n\n")}
                    </pre>
                  </Details>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <Modal
        open={preview !== null}
        onClose={() => (busy ? undefined : setPreview(null))}
        title="Autopopulate campaigns"
        size="lg"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => void apply()}
              disabled={busy || totalToAdd === 0}
              title={totalToAdd === 0 ? "Nothing eligible to add" : "Write these additions to Instantly"}
            >
              {busy ? <Spinner /> : <Wand2 size={14} />}{" "}
              {busy ? "Populating…" : `Add ${totalToAdd} inbox${totalToAdd === 1 ? "" : "es"}`}
            </button>
          </>
        }
      >
        {preview ? (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted">
              {totalToAdd > 0
                ? `Ready to add ${totalToAdd} idle inbox${totalToAdd === 1 ? "" : "es"} across ${toFill.length} campaign${toFill.length === 1 ? "" : "s"}. Each inbox is niche-matched and used once.`
                : "Nothing eligible to add right now — see the reasons below."}
            </p>

            {toFill.map((p) => {
              const emails = p.add.map((a) => a.email);
              return (
                <Card key={p.campaignId} className="border-mint bg-mint/10 p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{p.campaignName}</span>
                    {p.campaignTags.map((t) => (
                      <Badge key={t} tone="lavender">{t}</Badge>
                    ))}
                    <span className="ml-auto flex items-center gap-1 text-xs text-muted">
                      capacity {fmtNumber(p.supplyBefore)} <ArrowRight size={11} /> {fmtNumber(p.supplyAfter)} / {fmtNumber(p.dailyLimit)}
                      {p.stillShort > 0 ? <span className="text-danger">· still short {fmtNumber(p.stillShort)}</span> : null}
                    </span>
                    <button className="btn-ghost btn-sm" onClick={() => copy(emails.join("\n"), toast)} title="Copy the added addresses">
                      <Copy size={12} /> Copy
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.add.map((a) => (
                      <span
                        key={a.email}
                        className="inline-flex items-center gap-1 rounded border border-ink/20 bg-white px-1.5 py-0.5 font-mono text-[11px]"
                        title={a.mature ? "mature" : "still warming — added anyway"}
                      >
                        {a.email}
                        {!a.mature ? <Badge tone="sun">warming</Badge> : null}
                      </span>
                    ))}
                  </div>
                </Card>
              );
            })}

            {skipped.length > 0 ? (
              <Details summary={`${skipped.length} campaign${skipped.length === 1 ? "" : "s"} couldn't be filled`}>
                <ul className="space-y-1 text-[11px] text-muted">
                  {skipped.map((p) => (
                    <li key={p.campaignId}>
                      <b>{p.campaignName}</b>: {p.reason ?? "already at capacity"}
                    </li>
                  ))}
                </ul>
              </Details>
            ) : null}

            {preview.untaggedIdle.length > 0 ? (
              <p className="flex items-start gap-1.5 rounded-lg border-2 border-ink bg-sun/20 p-2 text-[11px]">
                <Bot size={13} className="mt-0.5 shrink-0" />
                <span>
                  {preview.untaggedIdle.length} idle inbox{preview.untaggedIdle.length === 1 ? " is" : "es are"} sitting
                  unused because {preview.untaggedIdle.length === 1 ? "it has" : "they have"} no niche tag — tag them in
                  the Accounts tab to make them eligible.
                </span>
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
