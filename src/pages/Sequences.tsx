import { useMemo, useState, type ReactNode } from "react";
import {
  Plus,
  Sparkles,
  FileText,
  Copy,
  Trash2,
  Pencil,
  Star,
  Trophy,
  Mail,
  Wand2,
  Clock,
  ChevronRight,
  AlertTriangle,
  KeyRound,
} from "lucide-react";
import { Card, Badge, EmptyState, Spinner } from "../components/ui/primitives";
import { Modal, ConfirmDialog } from "../components/ui/Modal";
import { Field, TextField, NumberField, SelectField, TextArea } from "../components/ui/Field";
import { ProviderLogo } from "../components/ui/badges";
import { useToast } from "../components/ui/toast";
import {
  useCollection,
  useInsert,
  useInsertMany,
  useUpdate,
  useRemove,
  useRemoveMany,
} from "../lib/hooks";
import {
  Campaign,
  Sequence,
  SequenceBrief,
  SequenceEmail,
  SequencePerformance,
  SequencePlatform,
  SequenceStatus,
  TABLES,
} from "../lib/types";
import {
  DEFAULT_BRIEF,
  DEFAULT_PERFORMANCE,
  PLATFORM_INFO,
  SEQUENCE_TYPES,
  buildTemplateSequence,
  diagnose,
  newEmailRow,
  sequenceRates,
} from "../lib/sequences";
import { generateSequence } from "../lib/functions";
import { cn, uuid } from "../lib/utils";

const PLATFORMS: SequencePlatform[] = ["instantly", "smartlead", "apollo", "lemlist", "gmail", "manual"];
const STATUSES: SequenceStatus[] = ["draft", "live", "paused", "won", "archived"];
const STATUS_TONE: Record<SequenceStatus, string> = {
  draft: "bg-white",
  live: "bg-mint text-white",
  paused: "bg-sun",
  won: "bg-pink",
  archived: "bg-white text-muted",
};

function Stars({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          disabled={!onChange}
          onClick={() => onChange?.(n === value ? 0 : n)}
          className={onChange ? "cursor-pointer" : "cursor-default"}
        >
          <Star size={16} className={n <= value ? "fill-sun text-ink" : "text-ink/30"} />
        </button>
      ))}
    </div>
  );
}

export default function Sequences() {
  const toast = useToast();
  const { data: sequences = [], isLoading } = useCollection<Sequence>(TABLES.sequences);
  const { data: emails = [] } = useCollection<SequenceEmail>(TABLES.sequenceEmails);
  const { data: campaigns = [] } = useCollection<Campaign>(TABLES.campaigns);
  const insertSeq = useInsert<Sequence>(TABLES.sequences);
  const updateSeq = useUpdate<Sequence>(TABLES.sequences);
  const removeSeq = useRemove(TABLES.sequences);
  const insertEmails = useInsertMany<SequenceEmail>(TABLES.sequenceEmails);
  const updateEmail = useUpdate<SequenceEmail>(TABLES.sequenceEmails);
  const removeEmail = useRemove(TABLES.sequenceEmails);
  const removeManyEmails = useRemoveMany(TABLES.sequenceEmails);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [editingPerf, setEditingPerf] = useState<Sequence | null>(null);
  const [editingEmail, setEditingEmail] = useState<SequenceEmail | null>(null);
  const [deleting, setDeleting] = useState<Sequence | null>(null);
  const [winnersOnly, setWinnersOnly] = useState(false);

  const active = sequences.find((s) => s.id === activeId) ?? null;
  const activeEmails = useMemo(
    () => emails.filter((e) => e.sequence_id === active?.id).sort((a, b) => a.position - b.position),
    [emails, active],
  );

  const visible = winnersOnly ? sequences.filter((s) => s.performance?.is_winner) : sequences;

  async function createSequence(
    brief: SequenceBrief,
    platform: SequencePlatform,
    rows: Omit<SequenceEmail, "id" | "sequence_id">[],
    generatedBy: "ai" | "manual",
    model: string,
  ) {
    const seqId = uuid();
    await insertSeq.mutateAsync({
      id: seqId,
      name: brief.notes ? `${brief.audience || "New"} — ${platform}` : `${brief.audience || "New sequence"}`,
      platform,
      campaign_id: null,
      status: "draft",
      brief,
      performance: { ...DEFAULT_PERFORMANCE },
      generated_by: generatedBy,
      model,
    });
    await insertEmails.mutateAsync(
      rows.map((r) => ({ ...r, id: uuid(), sequence_id: seqId })),
    );
    setShowBuilder(false);
    setActiveId(seqId);
    toast.push(`Created sequence (${rows.length} emails)`);
  }

  async function duplicate(seq: Sequence) {
    const seqId = uuid();
    await insertSeq.mutateAsync({
      ...seq,
      id: seqId,
      name: `${seq.name} (copy)`,
      status: "draft",
      performance: { ...DEFAULT_PERFORMANCE },
      created_at: undefined,
    });
    const rows = emails
      .filter((e) => e.sequence_id === seq.id)
      .map((e) => ({ ...e, id: uuid(), sequence_id: seqId, created_at: undefined }));
    if (rows.length) await insertEmails.mutateAsync(rows);
    setActiveId(seqId);
    toast.push("Duplicated — reuse this winner");
  }

  async function deleteSequence(seq: Sequence) {
    const ids = emails.filter((e) => e.sequence_id === seq.id).map((e) => e.id);
    if (ids.length) await removeManyEmails.mutateAsync(ids);
    await removeSeq.mutateAsync(seq.id);
    if (activeId === seq.id) setActiveId(null);
    toast.push("Sequence deleted");
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
      {/* Sequence list */}
      <Card className="h-fit p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-extrabold uppercase">
            <Mail size={16} /> Sequences
          </h2>
          <button className="btn-primary btn-sm" onClick={() => setShowBuilder(true)}>
            <Plus size={14} /> New
          </button>
        </div>
        <button
          className={cn("mb-2 w-full", winnersOnly ? "btn-sun btn-sm" : "btn-ghost btn-sm")}
          onClick={() => setWinnersOnly((v) => !v)}
        >
          <Trophy size={14} /> Winners only
        </button>
        {isLoading ? (
          <Spinner />
        ) : visible.length === 0 ? (
          <p className="p-2 text-xs text-muted">No sequences yet.</p>
        ) : (
          <div className="space-y-1">
            {visible.map((s) => {
              const r = sequenceRates(s.performance ?? DEFAULT_PERFORMANCE);
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg border-2 px-2 py-2 text-left",
                    active?.id === s.id ? "border-ink bg-sun" : "border-transparent hover:bg-canvas",
                  )}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1 truncate text-sm font-bold">
                      {s.performance?.is_winner ? <Trophy size={12} className="text-pink-dark" /> : null}
                      {s.name}
                    </p>
                    <p className="flex items-center gap-2 text-xs text-muted">
                      <ProviderLogo name={s.platform} size={14} /> {s.platform}
                    </p>
                  </div>
                  <span className={cn("badge shrink-0", STATUS_TONE[s.status])}>{s.status}</span>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {/* Detail */}
      <div className="space-y-4">
        {!active ? (
          <Card className="p-6">
            <EmptyState
              icon={<Wand2 size={32} />}
              title="Craft a cold-email sequence"
              description="Answer a few questions and generate a personalized, platform-ready sequence (Instantly spintax + variables by default) with Claude — or scaffold one instantly with the offline template. Then track which ones win."
              action={
                <button className="btn-primary" onClick={() => setShowBuilder(true)}>
                  <Sparkles size={16} /> New sequence
                </button>
              }
            />
          </Card>
        ) : (
          <SequenceDetail
            seq={active}
            emails={activeEmails}
            campaigns={campaigns}
            onChangeStatus={(status) => updateSeq.mutate({ id: active.id, patch: { status } })}
            onChangeRating={(rating) =>
              updateSeq.mutate({
                id: active.id,
                patch: { performance: { ...(active.performance ?? DEFAULT_PERFORMANCE), rating } },
              })
            }
            onToggleWinner={() =>
              updateSeq.mutate({
                id: active.id,
                patch: {
                  performance: {
                    ...(active.performance ?? DEFAULT_PERFORMANCE),
                    is_winner: !(active.performance?.is_winner),
                  },
                },
              })
            }
            onEditPerf={() => setEditingPerf(active)}
            onEditEmail={(e) => setEditingEmail(e)}
            onAddEmail={() =>
              insertEmails.mutateAsync([newEmailRow(active.id, activeEmails.length + 1)]).then(() =>
                toast.push("Email added"),
              )
            }
            onDeleteEmail={(id) => removeEmail.mutate(id)}
            onDuplicate={() => duplicate(active)}
            onDelete={() => setDeleting(active)}
            onCopy={(t) => {
              navigator.clipboard?.writeText(t);
              toast.push("Copied to clipboard");
            }}
            onAssignCampaign={(campaign_id) => updateSeq.mutate({ id: active.id, patch: { campaign_id } })}
          />
        )}
      </div>

      {showBuilder ? (
        <BuilderModal
          campaigns={campaigns}
          onClose={() => setShowBuilder(false)}
          onCreate={createSequence}
        />
      ) : null}

      {editingPerf ? (
        <PerformanceModal
          seq={editingPerf}
          onClose={() => setEditingPerf(null)}
          onSave={(performance) => {
            updateSeq.mutate({ id: editingPerf.id, patch: { performance } });
            setEditingPerf(null);
            toast.push("Performance saved");
          }}
        />
      ) : null}

      {editingEmail ? (
        <EmailModal
          email={editingEmail}
          onClose={() => setEditingEmail(null)}
          onSave={(e) => {
            const { id, created_at, ...patch } = e;
            updateEmail.mutate({ id, patch: { ...patch, word_count: e.body.split(/\s+/).filter(Boolean).length } });
            setEditingEmail(null);
            toast.push("Email saved");
          }}
        />
      ) : null}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteSequence(deleting)}
        title="Delete sequence"
        message={`Remove "${deleting?.name}" and its emails?`}
      />
    </div>
  );
}

function SequenceDetail({
  seq,
  emails,
  campaigns,
  onChangeStatus,
  onChangeRating,
  onToggleWinner,
  onEditPerf,
  onEditEmail,
  onAddEmail,
  onDeleteEmail,
  onDuplicate,
  onDelete,
  onCopy,
  onAssignCampaign,
}: {
  seq: Sequence;
  emails: SequenceEmail[];
  campaigns: Campaign[];
  onChangeStatus: (s: SequenceStatus) => void;
  onChangeRating: (r: number) => void;
  onToggleWinner: () => void;
  onEditPerf: () => void;
  onEditEmail: (e: SequenceEmail) => void;
  onAddEmail: () => void;
  onDeleteEmail: (id: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onCopy: (t: string) => void;
  onAssignCampaign: (id: string | null) => void;
}) {
  const perf = seq.performance ?? DEFAULT_PERFORMANCE;
  const r = sequenceRates(perf);
  const diag = diagnose(perf);

  return (
    <>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ProviderLogo name={seq.platform} />
              <h2 className="text-2xl">{seq.name}</h2>
              {seq.performance?.is_winner ? <Badge tone="pink"><Trophy size={12} /> Winner</Badge> : null}
            </div>
            <p className="mt-1 text-sm text-muted">
              {seq.brief?.audience || "—"} · {seq.brief?.angle} · {emails.length} emails ·{" "}
              {seq.generated_by === "ai" ? `AI (${seq.model})` : "Template"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SelectField
              value={seq.status}
              onChange={(v) => onChangeStatus(v as SequenceStatus)}
              options={STATUSES.map((s) => ({ value: s, label: s }))}
              className="w-32"
            />
            <button className="btn-ghost btn-sm" onClick={onDuplicate}>
              <Copy size={14} /> Duplicate
            </button>
            <button className="btn-sm btn bg-danger text-white shadow-hard" onClick={onDelete}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-bold">Rating</span>
            <Stars value={perf.rating} onChange={onChangeRating} />
          </div>
          <button className={seq.performance?.is_winner ? "btn-sun btn-sm" : "btn-ghost btn-sm"} onClick={onToggleWinner}>
            <Trophy size={14} /> {seq.performance?.is_winner ? "Winner" : "Mark winner"}
          </button>
          <select
            className="input w-44 cursor-pointer"
            value={seq.campaign_id ?? ""}
            onChange={(e) => onAssignCampaign(e.target.value || null)}
          >
            <option value="">— No campaign —</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {/* Performance */}
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg">Performance</h3>
          <button className="btn-ghost btn-sm" onClick={onEditPerf}>
            <Pencil size={14} /> Update numbers
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Sent" value={perf.sent} />
          <Metric label="Open rate" value={`${Math.round(r.openRate)}%`} />
          <Metric label="Reply rate" value={`${r.replyRate.toFixed(1)}%`} />
          <Metric label="Meetings" value={perf.meetings} />
        </div>
        <div
          className={cn(
            "mt-3 flex items-start gap-2 rounded-xl border-2 border-ink p-3 text-sm font-semibold",
            diag.level === "ok" ? "bg-mint/20" : diag.level === "nodata" ? "bg-white" : "bg-sun/40",
          )}
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{diag.text}</span>
        </div>
      </Card>

      {/* Emails */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-extrabold">Emails ({emails.length})</h3>
        <button className="btn-primary btn-sm" onClick={onAddEmail}>
          <Plus size={14} /> Add email
        </button>
      </div>

      <div className="space-y-3">
        {emails.map((e) => (
          <Card key={e.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-ink bg-pink text-xs font-extrabold">
                  {e.position}
                </span>
                <Badge tone="lavender">
                  <Clock size={11} /> Day {e.day} · {e.send_time || "10:00"}
                </Badge>
                <Badge tone="sky">{e.angle}</Badge>
              </div>
              <div className="flex gap-1">
                <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-canvas" onClick={() => onEditEmail(e)}>
                  <Pencil size={13} />
                </button>
                <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-danger hover:text-white" onClick={() => onDeleteEmail(e.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            <div className="mt-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold uppercase text-muted">Subject</p>
                <button className="text-xs text-muted hover:text-ink" onClick={() => onCopy(e.subject)}>
                  <Copy size={12} className="inline" /> copy
                </button>
              </div>
              <p className="font-bold">{e.subject}</p>
              {e.subject_variants?.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {e.subject_variants.map((s, i) => (
                    <span key={i} className="chip">
                      {s}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="mt-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold uppercase text-muted">Body</p>
                <button className="text-xs text-muted hover:text-ink" onClick={() => onCopy(e.body)}>
                  <Copy size={12} className="inline" /> copy
                </button>
              </div>
              <pre className="mt-1 whitespace-pre-wrap rounded-xl border-2 border-ink bg-canvas p-3 font-sans text-sm">
                {e.body}
              </pre>
              <p className="mt-1 text-xs text-muted">
                {e.goal} · {e.word_count || e.body.split(/\s+/).filter(Boolean).length} words
              </p>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border-2 border-ink bg-canvas p-3">
      <p className="text-xs font-bold uppercase text-muted">{label}</p>
      <p className="text-2xl font-extrabold">{value}</p>
    </div>
  );
}

function BuilderModal({
  campaigns,
  onClose,
  onCreate,
}: {
  campaigns: Campaign[];
  onClose: () => void;
  onCreate: (
    brief: SequenceBrief,
    platform: SequencePlatform,
    rows: Omit<SequenceEmail, "id" | "sequence_id">[],
    generatedBy: "ai" | "manual",
    model: string,
  ) => void;
}) {
  const toast = useToast();
  const [platform, setPlatform] = useState<SequencePlatform>("instantly");
  const [brief, setBrief] = useState<SequenceBrief>({ ...DEFAULT_BRIEF });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof SequenceBrief>(k: K, v: SequenceBrief[K]) => setBrief((b) => ({ ...b, [k]: v }));
  const info = PLATFORM_INFO[platform];

  async function generateAI() {
    setBusy(true);
    const res = await generateSequence(brief, platform);
    setBusy(false);
    if (!res.ok || !res.emails) {
      toast.push(res.error ?? "AI unavailable — use the template instead.", "error");
      return;
    }
    const rows = res.emails.map((e, i) => ({
      position: e.position ?? i + 1,
      day: e.day ?? i * 3,
      send_time: e.send_time ?? "10:00",
      subject: e.subject,
      subject_variants: e.subject_variants ?? [],
      body: e.body,
      angle: e.angle ?? "",
      goal: e.goal ?? "",
      word_count: e.word_count ?? e.body.split(/\s+/).filter(Boolean).length,
      notes: "",
    }));
    onCreate(brief, platform, rows, "ai", res.model ?? "claude");
  }

  function useTemplate() {
    onCreate(brief, platform, buildTemplateSequence(brief), "manual", "template");
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="New cold-email sequence"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-ghost" onClick={useTemplate} disabled={busy}>
            <FileText size={16} /> Use template
          </button>
          <button className="btn-primary" onClick={generateAI} disabled={busy}>
            <Sparkles size={16} /> {busy ? "Generating…" : "Generate with Claude"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Sending platform">
          <SelectField value={platform} onChange={(v) => setPlatform(v as SequencePlatform)} options={PLATFORMS.map((p) => ({ value: p, label: PLATFORM_INFO[p].label }))} />
        </Field>
        <Field label="Sequence type">
          <SelectField
            value={brief.sequence_type}
            onChange={(v) => {
              const t = SEQUENCE_TYPES.find((x) => x.value === v);
              setBrief((b) => ({ ...b, sequence_type: v, email_count: t?.count ?? b.email_count }));
            }}
            options={SEQUENCE_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          />
        </Field>
        <Field label="Target audience / ICP" className="sm:col-span-2" hint="Role, company type, size">
          <TextField value={brief.audience} onChange={(v) => set("audience", v)} placeholder="VP Sales at 50-200 person B2B SaaS" />
        </Field>
        <Field label="Your name">
          <TextField value={brief.sender_name} onChange={(v) => set("sender_name", v)} />
        </Field>
        <Field label="Your role">
          <TextField value={brief.sender_role} onChange={(v) => set("sender_role", v)} />
        </Field>
        <Field label="Offer / value prop" className="sm:col-span-2" hint="The specific problem you solve">
          <TextField value={brief.offer} onChange={(v) => set("offer", v)} placeholder="cut SDR ramp time without adding headcount" />
        </Field>
        <Field label="Proof / credibility" className="sm:col-span-2">
          <TextField value={brief.proof} onChange={(v) => set("proof", v)} placeholder="helped Acme cut ramp 40% in 6 weeks" />
        </Field>
        <Field label="Trigger / research signal (optional)" className="sm:col-span-2">
          <TextField value={brief.signal} onChange={(v) => set("signal", v)} placeholder="saw you're hiring 15 reps" />
        </Field>
        <Field label="Industry">
          <TextField value={brief.industry} onChange={(v) => set("industry", v)} />
        </Field>
        <Field label="Angle">
          <TextField value={brief.angle} onChange={(v) => set("angle", v)} placeholder="save time / reduce risk / growth" />
        </Field>
        <Field label="Personalization level">
          <SelectField
            value={brief.personalization}
            onChange={(v) => set("personalization", v as SequenceBrief["personalization"])}
            options={[
              { value: "hyper", label: "Hyper-personal (per prospect)" },
              { value: "account", label: "Account-based" },
              { value: "segment", label: "Segment / industry" },
              { value: "volume", label: "Volume (merge tags)" },
            ]}
          />
        </Field>
        <Field label="Tone">
          <SelectField
            value={brief.tone}
            onChange={(v) => set("tone", v)}
            options={[
              { value: "peer / conversational", label: "Peer / conversational" },
              { value: "professional", label: "Professional" },
              { value: "technical / precise", label: "Technical / precise" },
              { value: "C-suite ultra-brief", label: "C-suite ultra-brief" },
            ]}
          />
        </Field>
        <Field label="Emails in sequence">
          <NumberField value={brief.email_count} onChange={(v) => set("email_count", v ?? 7)} min={2} />
        </Field>
        <Field label="Email length">
          <SelectField
            value={brief.length_pref}
            onChange={(v) => set("length_pref", v)}
            options={[
              { value: "ultra-short", label: "Ultra-short (≤50 words)" },
              { value: "short", label: "Short (50-100 words)" },
              { value: "medium", label: "Medium (100-150 words)" },
            ]}
          />
        </Field>
        <Field label="CTA style">
          <SelectField
            value={brief.cta_style}
            onChange={(v) => set("cta_style", v)}
            options={[
              { value: "interest", label: "Interest-based question" },
              { value: "soft", label: "Soft / low-commitment" },
              { value: "direct", label: "Direct meeting ask" },
            ]}
          />
        </Field>
        <Field label="Use spintax">
          <SelectField value={brief.use_spintax ? "yes" : "no"} onChange={(v) => set("use_spintax", v === "yes")} options={[{ value: "yes", label: "Yes (recommended)" }, { value: "no", label: "No" }]} />
        </Field>
        <Field label="Extra instructions" className="sm:col-span-2">
          <TextArea value={brief.notes} onChange={(v) => set("notes", v)} placeholder="Anything else the writer should know…" />
        </Field>
      </div>

      <div className="mt-4 rounded-xl border-2 border-ink bg-lavender/40 p-3 text-xs">
        <p className="font-bold">{info.label} variables & spintax</p>
        <p className="mt-1">{info.note}</p>
        <p className="mt-1">
          <span className="font-semibold">Variables:</span> {info.variables.join("  ")}
        </p>
        <p className="mt-0.5">
          <span className="font-semibold">Fallback:</span> {info.fallback} &nbsp;·&nbsp;
          <span className="font-semibold">Spintax:</span> {info.spintax}
        </p>
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-xl border-2 border-ink bg-canvas p-3 text-xs">
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        <span>
          "Generate with Claude" needs <code>ANTHROPIC_API_KEY</code> set in Netlify (functions scope). Until then,
          "Use template" builds a full {brief.email_count}-email sequence offline with {info.label} variables.
        </span>
      </div>
    </Modal>
  );
}

function PerformanceModal({
  seq,
  onClose,
  onSave,
}: {
  seq: Sequence;
  onClose: () => void;
  onSave: (p: SequencePerformance) => void;
}) {
  const [p, setP] = useState<SequencePerformance>({ ...DEFAULT_PERFORMANCE, ...(seq.performance ?? {}) });
  const set = <K extends keyof SequencePerformance>(k: K, v: SequencePerformance[K]) => setP((x) => ({ ...x, [k]: v }));
  return (
    <Modal
      open
      onClose={onClose}
      title="Update performance"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(p)}>
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Emails sent">
          <NumberField value={p.sent} onChange={(v) => set("sent", v ?? 0)} min={0} />
        </Field>
        <Field label="Opens">
          <NumberField value={p.opens} onChange={(v) => set("opens", v ?? 0)} min={0} />
        </Field>
        <Field label="Replies">
          <NumberField value={p.replies} onChange={(v) => set("replies", v ?? 0)} min={0} />
        </Field>
        <Field label="Positive replies">
          <NumberField value={p.positive_replies} onChange={(v) => set("positive_replies", v ?? 0)} min={0} />
        </Field>
        <Field label="Meetings booked">
          <NumberField value={p.meetings} onChange={(v) => set("meetings", v ?? 0)} min={0} />
        </Field>
        <Field label="Rating (0-5)">
          <NumberField value={p.rating} onChange={(v) => set("rating", v ?? 0)} min={0} />
        </Field>
        <Field label="Notes" className="col-span-2">
          <TextArea value={p.notes} onChange={(v) => set("notes", v)} />
        </Field>
      </div>
    </Modal>
  );
}

function EmailModal({
  email,
  onClose,
  onSave,
}: {
  email: SequenceEmail;
  onClose: () => void;
  onSave: (e: SequenceEmail) => void;
}) {
  const [e, setE] = useState<SequenceEmail>(email);
  const set = <K extends keyof SequenceEmail>(k: K, v: SequenceEmail[K]) => setE((x) => ({ ...x, [k]: v }));
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Edit email ${email.position}`}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(e)}>
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Day">
          <NumberField value={e.day} onChange={(v) => set("day", v ?? 0)} min={0} />
        </Field>
        <Field label="Send time">
          <TextField value={e.send_time} onChange={(v) => set("send_time", v)} placeholder="10:00" />
        </Field>
        <Field label="Angle">
          <TextField value={e.angle} onChange={(v) => set("angle", v)} />
        </Field>
        <Field label="Subject" className="sm:col-span-3">
          <TextField value={e.subject} onChange={(v) => set("subject", v)} />
        </Field>
        <Field label="Subject variants (one per line)" className="sm:col-span-3">
          <TextArea value={e.subject_variants.join("\n")} onChange={(v) => set("subject_variants", v.split("\n").map((s) => s.trim()).filter(Boolean))} rows={2} />
        </Field>
        <Field label="Body" className="sm:col-span-3">
          <TextArea value={e.body} onChange={(v) => set("body", v)} rows={8} />
        </Field>
        <Field label="Goal" className="sm:col-span-3">
          <TextField value={e.goal} onChange={(v) => set("goal", v)} />
        </Field>
      </div>
    </Modal>
  );
}
