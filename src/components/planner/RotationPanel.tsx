// ---------------------------------------------------------------------------
// Periodic rotation swap — the Planner "Rotation" tab.
//
// Each rotation-managed campaign keeps two FIXED same-niche cohorts (A and B)
// and alternates the whole connected set every `interval_days`. Cohort A is the
// campaign's live inbox set when rotation is enabled; cohort B is auto-picked
// idle, same-niche spares (previewed, then locked). While one sends, the other
// rests and re-warms; then they swap back — forever.
//
// This panel: a master on/off (which also disables the health-based swapper),
// per-campaign enable with an A/B preview, a "Rotate now" control, and the run
// log. The scheduled worker (_rotationRun.ts) does the unattended 15-day swaps.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Repeat,
  Power,
  Play,
  Trash2,
  AlertTriangle,
  Check,
  X,
  ArrowRight,
  Clock,
  Info,
} from "lucide-react";
import { Card, Badge, Spinner, Details, Toggle } from "../ui/primitives";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/toast";
import { instantly, rotationSwap } from "../../lib/instantly";
import {
  selectCohortB,
  planRotation,
  pairSwaps,
  capacityOf,
  reservedEmails,
  dueForRotation,
  nextDueMs,
  type CohortBResult,
} from "../../lib/rotationSwap";
import { campaignTagsOf } from "../../lib/tags";
import type { TagMap } from "../../lib/tags";
import type { Plan, PlannerCampaign } from "../../lib/campaignPlan";
import type { MailboxHealth } from "../../lib/mailboxHealth";
import { useCollection, useUpsertMany, useUpdate, useRemove } from "../../lib/hooks";
import { type AppSettings, type RotationState, type RotationRun, TABLES } from "../../lib/types";
import { fmtDateShort, fmtNumber } from "../../lib/format";

function emailListOf(data: unknown): string[] {
  const list = (data as { email_list?: unknown })?.email_list;
  return Array.isArray(list) ? list.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean) : [];
}

interface EnableState {
  campaign: PlannerCampaign;
  loading: boolean;
  campaignTags: string[];
  cohortA: string[];
  cohortB: CohortBResult | null;
  error?: string;
}

export function RotationPanel({
  plan,
  settings,
  patchSettings,
  tagMap,
  campaignTagsById,
  overrides,
  healthByEmail,
  onApplied,
}: {
  plan: Plan;
  settings: AppSettings;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  tagMap: TagMap;
  campaignTagsById: Map<string, string[]>;
  overrides: Record<string, string>;
  healthByEmail: Map<string, MailboxHealth>;
  onApplied: () => void;
}) {
  const toast = useToast();
  const statesQ = useCollection<RotationState>(TABLES.rotationState);
  const runsQ = useCollection<RotationRun>(TABLES.rotationRuns);
  const upsertStates = useUpsertMany<RotationState>(TABLES.rotationState);
  const updateState = useUpdate<RotationState>(TABLES.rotationState);
  const removeState = useRemove(TABLES.rotationState);

  const capsQ = useQuery({
    queryKey: ["inst", "write-caps"],
    queryFn: () => instantly.writeCapabilities(),
    staleTime: 5 * 60_000,
  });
  const writesEnabled = capsQ.data?.writesEnabled !== false;
  const writesHint = capsQ.data?.hint ?? null;

  const [enabling, setEnabling] = useState<EnableState | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);

  const states = statesQ.data ?? [];
  const stateByCampaign = useMemo(() => {
    const m = new Map<string, RotationState>();
    for (const s of states) m.set(s.campaign_id, s);
    return m;
  }, [states]);
  const reserved = useMemo(() => reservedEmails(states), [states]);

  const master = settings.rotation_swap_enabled === true;

  // Per-mailbox daily limit + the idle same-niche candidate pool.
  const dailyLimitByEmail = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of plan.mailboxes) m.set(b.email.toLowerCase(), b.dailyLimit);
    return m;
  }, [plan.mailboxes]);
  const idleCandidates = useMemo(
    () =>
      plan.idleMailboxes
        .filter((b) => b.active && !b.excluded && !b.setupPending)
        .map((b) => {
          const h = healthByEmail.get(b.email.toLowerCase());
          return { email: b.email, dailyLimit: b.dailyLimit, mature: h?.mature ?? false, healthScore: h?.healthScore ?? null };
        }),
    [plan.idleMailboxes, healthByEmail],
  );

  const tagsForCampaign = (c: PlannerCampaign): string[] =>
    campaignTagsOf(
      { id: c.id, name: c.name, instantlyTags: [...c.instantlyTags, ...(campaignTagsById.get(c.id) ?? [])] },
      overrides,
    );

  const activeCampaigns = plan.campaigns.filter((c) => c.active);

  // --- Enable flow (auto-pick & lock the partner cohort) ---------------------
  async function openEnable(c: PlannerCampaign) {
    setEnabling({ campaign: c, loading: true, campaignTags: [], cohortA: [], cohortB: null });
    const detail = await instantly.campaignDetail(c.id);
    const cohortA = emailListOf(detail.ok ? detail.data : null);
    const campaignTags = tagsForCampaign(c);
    if (cohortA.length === 0) {
      setEnabling({ campaign: c, loading: false, campaignTags, cohortA, cohortB: null, error: "This campaign has no connected inboxes to rotate." });
      return;
    }
    if (campaignTags.length === 0) {
      setEnabling({ campaign: c, loading: false, campaignTags, cohortA, cohortB: null, error: "This campaign has no niche tag, so no same-niche partner can be selected. Tag it in the Accounts tab first." });
      return;
    }
    // Reserve other campaigns' cohorts AND this campaign's own connected set.
    const reservedForPick = new Set<string>([...reserved, ...cohortA]);
    const cohortB = selectCohortB({ idle: idleCandidates, campaignTags, tagMap, size: cohortA.length, reserved: reservedForPick });
    setEnabling({ campaign: c, loading: false, campaignTags, cohortA, cohortB });
  }

  async function confirmEnable() {
    const e = enabling;
    if (!e || !e.cohortB || e.cohortA.length === 0) return;
    setBusy(true);
    try {
      const now = new Date();
      const interval = settings.rotation_interval_days > 0 ? settings.rotation_interval_days : 15;
      await upsertStates.mutateAsync([
        {
          id: e.campaign.id,
          campaign_id: e.campaign.id,
          campaign_name: e.campaign.name,
          enabled: true,
          interval_days: interval,
          niche: e.campaignTags,
          cohort_a: e.cohortA,
          cohort_b: e.cohortB.picks,
          active: "A",
          last_rotated_at: now.toISOString(),
          next_due_at: new Date(nextDueMs(now.getTime(), interval)).toISOString(),
        } as Partial<RotationState>,
      ]);
      toast.push(
        `Rotation enabled for ${e.campaign.name} — partner cohort of ${e.cohortB.picks.length} locked` +
          (e.cohortB.shortfall > 0 ? ` (${e.cohortB.shortfall} short — capacity will dip on B's turn)` : ""),
        e.cohortB.shortfall > 0 ? "info" : "success",
      );
      setEnabling(null);
    } catch (err) {
      toast.push(`Couldn't enable rotation: ${err instanceof Error ? err.message : "error"}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function disable(s: RotationState) {
    try {
      await updateState.mutateAsync({ id: s.id, patch: { enabled: false } });
      toast.push(`Rotation paused for ${s.campaign_name}`, "info");
    } catch (err) {
      toast.push(`Couldn't pause: ${err instanceof Error ? err.message : "error"}`, "error");
    }
  }
  async function forget(s: RotationState) {
    try {
      await removeState.mutateAsync(s.id);
      toast.push(`Rotation config removed for ${s.campaign_name}`, "info");
    } catch (err) {
      toast.push(`Couldn't remove: ${err instanceof Error ? err.message : "error"}`, "error");
    }
  }

  async function rotateNow(s: RotationState) {
    setRotating(s.campaign_id);
    try {
      const r = (await rotationSwap.rotateNow(s.campaign_id)) as {
        ok?: boolean;
        error?: string;
        results?: { outcome?: string; failures?: { reason: string }[] }[];
      };
      if (!r.ok) {
        toast.push(`Rotate now failed: ${r.error ?? "unknown error"}`, "error");
        return;
      }
      const res = r.results?.[0];
      const outcome = res?.outcome ?? "unknown";
      if (outcome === "applied") toast.push(`Rotated ${s.campaign_name} — the swap is verified live`, "success");
      else if (outcome === "skipped") toast.push(`Skipped: ${res?.failures?.[0]?.reason ?? "live list drifted"}`, "info");
      else toast.push(`Rotation ${outcome}: ${res?.failures?.[0]?.reason ?? "not confirmed"}`, "error");
      onApplied();
    } catch (err) {
      toast.push(`Rotate now failed: ${err instanceof Error ? err.message : "error"}`, "error");
    } finally {
      setRotating(null);
    }
  }

  const runs = [...(runsQ.data ?? [])]
    .sort((a, b) => (b.ran_at ?? "").localeCompare(a.ran_at ?? ""))
    .slice(0, 8);

  return (
    <div className="space-y-4">
      {/* Master switch */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <Repeat size={18} /> Periodic rotation swap
          </h2>
          <Toggle
            checked={master}
            onChange={(v) => void patchSettings({ rotation_swap_enabled: v })}
            label={master ? "On" : "Off"}
          />
          <label className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-xs font-bold uppercase text-muted">Rotate every</span>
            <input
              type="number"
              min={1}
              className="input w-20"
              value={settings.rotation_interval_days}
              onChange={(e) => void patchSettings({ rotation_interval_days: Math.max(1, Number(e.target.value) || 15) })}
            />
            <span className="text-xs text-muted">days</span>
          </label>
        </div>
        <p className="mt-2 flex items-start gap-1.5 rounded-lg border-2 border-ink bg-canvas p-2 text-[11px]">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            Turning this on <b>disables the health-based auto-swapper entirely</b> — only rotation runs, on the
            campaigns you enable below. The unattended 15-day swaps also need <code>ROTATION_SWAP_ENABLED=true</code>{" "}
            and <code>INSTANTLY_WRITE_ENABLED=true</code> in Netlify, and fire only on the production deploy; use{" "}
            <b>Rotate now</b> to run one on demand meanwhile.
          </span>
        </p>
        {!writesEnabled ? (
          <p className="mt-2 flex items-start gap-1.5 rounded-lg border-2 border-ink bg-sun/30 p-2 text-[11px]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{writesHint ?? "Writes are disabled — set INSTANTLY_WRITE_ENABLED=true to rotate campaigns."}</span>
          </p>
        ) : null}
      </Card>

      {/* Per-campaign controls */}
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-extrabold">Campaigns</h3>
        {activeCampaigns.length === 0 ? (
          <p className="text-sm text-muted">No active campaigns.</p>
        ) : (
          <div className="space-y-2">
            {activeCampaigns.map((c) => {
              const s = stateByCampaign.get(c.id);
              const managed = s && s.enabled;
              const plan2 = s ? planRotation(s) : null;
              const due = s ? dueForRotation(s, Date.now(), settings.rotation_interval_days) : false;
              return (
                <div key={c.id} className="rounded-lg border-2 border-ink p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{c.name}</span>
                    {tagsForCampaign(c).map((t) => (
                      <Badge key={t} tone="lavender">{t}</Badge>
                    ))}
                    <span className="text-xs text-muted">{c.emails.length} connected</span>
                    {managed ? (
                      <Badge tone="mint">rotation on · cohort {s!.active} active</Badge>
                    ) : s ? (
                      <Badge tone="white">paused</Badge>
                    ) : null}
                    <div className="ml-auto flex flex-wrap gap-2">
                      {managed ? (
                        <>
                          <button
                            className="btn-ghost btn-sm"
                            disabled={!writesEnabled || rotating === c.id}
                            onClick={() => void rotateNow(s!)}
                            title="Force this campaign to rotate now"
                          >
                            {rotating === c.id ? <Spinner /> : <Play size={13} />} Rotate now
                          </button>
                          <button className="btn-ghost btn-sm" onClick={() => void disable(s!)}>
                            <Power size={13} /> Pause
                          </button>
                        </>
                      ) : (
                        <button className="btn-primary btn-sm" onClick={() => void openEnable(c)}>
                          <Repeat size={13} /> {s ? "Re-enable" : "Enable rotation"}
                        </button>
                      )}
                      {s ? (
                        <button className="btn-ghost btn-sm" onClick={() => void forget(s)} title="Remove rotation config">
                          <Trash2 size={13} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {s && plan2 ? (
                    <div className="mt-2 grid gap-2 text-[11px] md:grid-cols-2">
                      <CohortView
                        label={`Cohort A${s.active === "A" ? " (active)" : " (resting)"}`}
                        emails={s.cohort_a}
                        dailyLimitByEmail={dailyLimitByEmail}
                        activeTone={s.active === "A"}
                      />
                      <CohortView
                        label={`Cohort B${s.active === "B" ? " (active)" : " (resting)"}`}
                        emails={s.cohort_b}
                        dailyLimitByEmail={dailyLimitByEmail}
                        activeTone={s.active === "B"}
                      />
                      <p className="md:col-span-2 flex items-center gap-1 text-muted">
                        <Clock size={11} />
                        {s.enabled
                          ? due
                            ? "Due to rotate now (next scheduled run will swap it)."
                            : `Next rotation ${s.next_due_at ? fmtDateShort(s.next_due_at) : "—"}.`
                          : "Paused — no automatic rotation."}
                        {s.cohort_b.length < s.cohort_a.length ? (
                          <span className="text-danger">
                            {" "}· partner cohort is smaller ({s.cohort_b.length} vs {s.cohort_a.length}) — capacity dips on B's turn.
                          </span>
                        ) : null}
                      </p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Run log */}
      {runs.length > 0 ? (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-extrabold">Rotation log</h3>
          <div className="space-y-2">
            {runs.map((run) => {
              const bad = run.outcome !== "applied";
              return (
                <div key={run.id} className="rounded-lg border-2 border-ink p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{fmtDateShort(run.ran_at)}</span>
                    <span className="font-semibold">{run.campaign_name || "—"}</span>
                    <Badge tone="sky">{run.direction}</Badge>
                    <Badge tone={run.outcome === "applied" ? "mint" : run.outcome === "skipped" ? "sun" : "danger"}>
                      {run.outcome}
                    </Badge>
                    <span className="text-muted">
                      {run.swapped_in.length} in / {run.swapped_out.length} out
                    </span>
                  </div>
                  {run.pairs.length > 0 ? (
                    <Details summary={`Swap detail (${run.pairs.length})`} defaultOpen={bad}>
                      <ul className="space-y-0.5 text-[11px]">
                        {run.pairs.map((p, i) => (
                          <li key={i} className="flex items-center gap-1">
                            {p.out && p.in ? (
                              <>
                                <span className="font-mono">{p.out}</span>
                                <ArrowRight size={11} />
                                <span className="font-mono">{p.in}</span>
                              </>
                            ) : p.out ? (
                              <span className="font-mono text-muted">{p.out} → (rested, no replacement)</span>
                            ) : (
                              <span className="font-mono text-muted">(added) → {p.in}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {run.failures.length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-[11px] text-danger">
                          {run.failures.map((f, i) => (
                            <li key={i} className="flex items-start gap-1">
                              <X size={11} className="mt-0.5 shrink-0" />
                              {f.email ? `${f.email}: ` : ""}
                              {f.reason}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <p className="mt-1 text-[11px] text-muted">Email: {run.notification}</p>
                      {(run.log ?? []).length > 0 ? (
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg border-2 border-ink bg-white p-2 text-[11px]">
                          {(run.log ?? []).join("\n")}
                        </pre>
                      ) : null}
                    </Details>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* Enable preview modal */}
      <Modal
        open={enabling !== null}
        onClose={() => (busy ? undefined : setEnabling(null))}
        title={enabling ? `Enable rotation — ${enabling.campaign.name}` : "Enable rotation"}
        size="lg"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setEnabling(null)} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => void confirmEnable()}
              disabled={
                busy ||
                !enabling ||
                enabling.loading ||
                !enabling.cohortB ||
                enabling.cohortB.picks.length === 0 ||
                enabling.cohortA.length === 0
              }
              title={enabling && enabling.cohortB && enabling.cohortB.picks.length === 0 ? "No same-niche idle spares to form a partner cohort" : undefined}
            >
              {busy ? <Spinner /> : <Check size={14} />} Lock cohorts & enable
            </button>
          </>
        }
      >
        {enabling ? (
          enabling.loading ? (
            <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> Reading the campaign's live inbox set…</p>
          ) : enabling.error ? (
            <p className="flex items-start gap-2 rounded-lg border-2 border-ink bg-sun/30 p-3 text-sm">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              {enabling.error}
            </p>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-xs text-muted">
                Cohort A is this campaign's live set. Cohort B is auto-picked from idle, same-niche spares and
                locked as the fixed partner. Every {settings.rotation_interval_days} days the whole set alternates
                A↔B; the resting cohort re-warms until its turn.
              </p>
              <div className="flex flex-wrap gap-1">
                {enabling.campaignTags.map((t) => (
                  <Badge key={t} tone="lavender">{t}</Badge>
                ))}
              </div>
              <CohortView
                label={`Cohort A — connects now (${enabling.cohortA.length} inboxes, ${fmtNumber(capacityOf(enabling.cohortA, dailyLimitByEmail))}/day)`}
                emails={enabling.cohortA}
                dailyLimitByEmail={dailyLimitByEmail}
                activeTone
              />
              <CohortView
                label={`Cohort B — the locked partner (${enabling.cohortB?.picks.length ?? 0} inboxes, ${fmtNumber(capacityOf(enabling.cohortB?.picks ?? [], dailyLimitByEmail))}/day)`}
                emails={enabling.cohortB?.picks ?? []}
                dailyLimitByEmail={dailyLimitByEmail}
                activeTone={false}
              />
              {enabling.cohortB && enabling.cohortB.picks.length === 0 ? (
                <p className="flex items-start gap-1.5 rounded-lg border-2 border-ink bg-danger/15 p-2 text-[11px]">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>
                    No idle, same-niche spares are available to form a partner cohort, so rotation can't be
                    enabled here. Free up or tag some idle {enabling.campaignTags.join(" / ")} inboxes first.
                  </span>
                </p>
              ) : enabling.cohortB && enabling.cohortB.shortfall > 0 ? (
                <p className="flex items-start gap-1.5 rounded-lg border-2 border-ink bg-sun/30 p-2 text-[11px]">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>
                    Only {enabling.cohortB.picks.length} same-niche idle spare{enabling.cohortB.picks.length === 1 ? "" : "s"} available
                    for a set of {enabling.cohortA.length} — the partner cohort is <b>{enabling.cohortB.shortfall} short</b>. Rotation
                    proceeds anyway (your choice); daily capacity dips while cohort B is the one sending.
                  </span>
                </p>
              ) : null}
            </div>
          )
        ) : null}
      </Modal>
    </div>
  );
}

function CohortView({
  label,
  emails,
  dailyLimitByEmail,
  activeTone,
}: {
  label: string;
  emails: string[];
  dailyLimitByEmail: Map<string, number>;
  activeTone: boolean;
}) {
  return (
    <div className={"rounded-lg border-2 p-2 " + (activeTone ? "border-mint bg-mint/10" : "border-ink/30 bg-canvas")}>
      <p className="font-bold">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {emails.length === 0 ? (
          <span className="text-muted">— none —</span>
        ) : (
          emails.map((e) => (
            <span key={e} className="inline-flex items-center gap-1 rounded border border-ink/20 bg-white px-1.5 py-0.5 font-mono">
              {e}
              <span className="text-muted">{dailyLimitByEmail.get(e.toLowerCase()) ?? "?"}/d</span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}
