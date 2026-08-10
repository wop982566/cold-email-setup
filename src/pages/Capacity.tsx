import { useMemo, useState } from "react";
import {
  Gauge,
  Plus,
  Pencil,
  Trash2,
  Save,
  TrendingUp,
  Target,
  Lightbulb,
} from "lucide-react";
import { Card, ProgressBar, StatCard, Toggle, Badge } from "../components/ui/primitives";
import { Modal, ConfirmDialog } from "../components/ui/Modal";
import { Field, TextField, NumberField, SelectField, TextArea } from "../components/ui/Field";
import { ProviderLogo } from "../components/ui/badges";
import { useToast } from "../components/ui/toast";
import {
  useCollection,
  useInsert,
  useUpdate,
  useRemove,
  useSettings,
  useSaveSettings,
} from "../lib/hooks";
import { AppSettings, CapacitySource, Domain, TABLES } from "../lib/types";
import { computeCapacity } from "../lib/capacity";
import { fmtNumber, fmtPercent } from "../lib/format";
import { uuid } from "../lib/utils";

const PERIOD_OPTIONS = [
  { value: "day", label: "per day" },
  { value: "week", label: "per week" },
  { value: "month", label: "per month" },
];
const KIND_OPTIONS = [
  { value: "sending", label: "Sending limit" },
  { value: "contacts", label: "Contacts limit" },
];

export default function Capacity() {
  const toast = useToast();
  const { data: domains = [] } = useCollection<Domain>(TABLES.domains);
  const { data: sources = [] } = useCollection<CapacitySource>(TABLES.capacity);
  const { data: settings } = useSettings();
  const saveSettings = useSaveSettings();
  const insert = useInsert<CapacitySource>(TABLES.capacity);
  const update = useUpdate<CapacitySource>(TABLES.capacity);
  const remove = useRemove(TABLES.capacity);

  const [editing, setEditing] = useState<CapacitySource | null>(null);
  const [deleting, setDeleting] = useState<CapacitySource | null>(null);
  const [form, setForm] = useState<AppSettings | null>(null);

  const draft = form ?? settings ?? null;
  const cap = useMemo(
    () => (draft ? computeCapacity(domains, sources, draft) : null),
    [domains, sources, draft],
  );

  if (!draft || !cap) return null;

  const setS = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    setForm({ ...draft, [k]: v });

  // Recommendations
  const sesDaily = cap.sources.find((s) => s.name.toLowerCase().includes("ses"))?.daily ?? 0;
  const headroomDaily = Math.max(0, Math.round(sesDaily - cap.mailboxDaily));
  const mailboxesToMaxSes =
    draft.per_mailbox_daily_limit > 0 ? Math.ceil(sesDaily / draft.per_mailbox_daily_limit) : 0;
  const extraMailboxes = Math.max(0, mailboxesToMaxSes - cap.activeMailboxes);
  const extraDomains = Math.ceil(extraMailboxes / Math.max(1, draft.emails_per_domain));
  const leadsPerMonth =
    draft.default_sends_per_lead > 0
      ? Math.floor(cap.effectiveMonthly / draft.default_sends_per_lead)
      : 0;

  async function saveSource(s: CapacitySource) {
    const exists = sources.some((x) => x.id === s.id);
    if (exists) {
      const { id, created_at, ...patch } = s;
      await update.mutateAsync({ id, patch });
    } else {
      await insert.mutateAsync(s);
    }
    toast.push(`Saved ${s.name}`);
    setEditing(null);
  }

  return (
    <div className="space-y-6">
      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Active mailboxes" value={cap.activeMailboxes} sublabel={`${cap.mailboxes} total`} tone="lavender" />
        <StatCard label="Safe / day" value={fmtNumber(cap.effectiveDaily)} sublabel={`bottleneck: ${cap.bottleneck}`} tone="pink" />
        <StatCard label="Safe / month" value={fmtNumber(cap.effectiveMonthly)} sublabel={`${draft.sending_days_per_week} send-days/wk`} tone="mint" />
        <StatCard label="Leads / month" value={fmtNumber(leadsPerMonth)} sublabel={`@ ${draft.default_sends_per_lead} emails/lead`} tone="sun" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Capacity model settings */}
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border-2 border-ink bg-sky">
              <Gauge size={18} />
            </span>
            <h2 className="text-lg">Capacity model</h2>
          </div>
          <div className="space-y-3">
            <Field label="Per-mailbox daily limit" hint="Safe sends per inbox per day (cold-email best practice: 25–50)">
              <NumberField value={draft.per_mailbox_daily_limit} onChange={(v) => setS("per_mailbox_daily_limit", v ?? 0)} min={0} />
            </Field>
            <Field label="Mailboxes per domain">
              <NumberField value={draft.emails_per_domain} onChange={(v) => setS("emails_per_domain", v ?? 0)} min={0} />
            </Field>
            <Field label="Sending days / week">
              <NumberField value={draft.sending_days_per_week} onChange={(v) => setS("sending_days_per_week", v ?? 0)} min={1} step={1} />
            </Field>
            <Field label="Emails per lead (sequence steps)">
              <NumberField value={draft.default_sends_per_lead} onChange={(v) => setS("default_sends_per_lead", v ?? 1)} min={1} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Warmup ramp / day">
                <NumberField value={draft.warmup_ramp_per_day} onChange={(v) => setS("warmup_ramp_per_day", v ?? 0)} min={0} />
              </Field>
              <Field label="Warmup target">
                <NumberField value={draft.warmup_target} onChange={(v) => setS("warmup_target", v ?? 0)} min={0} />
              </Field>
            </div>
            <button
              className="btn-primary w-full"
              onClick={async () => {
                await saveSettings.mutateAsync(draft);
                toast.push("Capacity model saved");
                setForm(null);
              }}
            >
              <Save size={16} /> Save model
            </button>
          </div>
        </Card>

        {/* Bottleneck breakdown */}
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-4 text-lg">Where your ceiling comes from</h2>
          <p className="mb-4 text-sm text-muted">
            Your real capacity is the <b>lowest</b> of these limits. Raise the lowest bar to grow.
          </p>

          <div className="space-y-4">
            <CeilingBar
              label={`Mailbox capacity (${cap.activeMailboxes} × ${draft.per_mailbox_daily_limit}/day)`}
              value={cap.mailboxDaily}
              ceiling={cap.effectiveDaily}
              isBottleneck={cap.bottleneck === "Mailbox capacity"}
              color="#B23386"
            />
            {cap.sources
              .filter((s) => s.kind === "sending")
              .map((s) => (
                <CeilingBar
                  key={s.id}
                  label={`${s.name} (${fmtNumber(s.limit)} / ${s.period} → ${fmtNumber(Math.round(s.daily))}/day)`}
                  value={s.daily}
                  ceiling={cap.effectiveDaily}
                  isBottleneck={cap.bottleneck === s.name}
                  color={s.color}
                />
              ))}
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border-2 border-ink bg-mint/20 p-3">
              <p className="flex items-center gap-2 text-sm font-bold">
                <TrendingUp size={16} /> Daily headroom
              </p>
              <p className="mt-1 text-sm">
                You're sending up to <b>{fmtNumber(cap.mailboxDaily)}</b> from mailboxes against a{" "}
                <b>{fmtNumber(Math.round(sesDaily))}</b>/day server cap — about{" "}
                <b>{fmtNumber(headroomDaily)}</b> emails/day of unused server headroom.
              </p>
            </div>
            <div className="rounded-xl border-2 border-ink bg-pink/20 p-3">
              <p className="flex items-center gap-2 text-sm font-bold">
                <Target size={16} /> To max out the server cap
              </p>
              <p className="mt-1 text-sm">
                Add ~<b>{fmtNumber(extraMailboxes)}</b> mailboxes (≈ <b>{fmtNumber(extraDomains)}</b>{" "}
                more domains) to reach <b>{fmtNumber(Math.round(sesDaily))}</b>/day at{" "}
                {draft.per_mailbox_daily_limit}/inbox.
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Capacity sources */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg">Provider limits</h2>
          <button
            className="btn-primary btn-sm"
            onClick={() =>
              setEditing({
                id: uuid(),
                name: "",
                kind: "sending",
                limit_amount: 0,
                limit_period: "day",
                used_amount: 0,
                color: "#FF90E8",
                notes: "",
                enabled: true,
                sort: sources.length + 1,
              })
            }
          >
            <Plus size={14} /> Add limit
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sources
            .slice()
            .sort((a, b) => a.sort - b.sort)
            .map((s) => {
              const pct = s.limit_amount > 0 ? (s.used_amount / s.limit_amount) * 100 : 0;
              return (
                <div key={s.id} className="rounded-xl border-2 border-ink bg-white p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <ProviderLogo name={s.name} />
                      <div>
                        <p className="font-bold">{s.name}</p>
                        <p className="text-xs text-muted">
                          {fmtNumber(s.limit_amount)} {s.kind === "contacts" ? "contacts" : "emails"} /{" "}
                          {s.limit_period}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-canvas" onClick={() => setEditing(s)}>
                        <Pencil size={13} />
                      </button>
                      <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-danger hover:text-white" onClick={() => setDeleting(s)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  {s.used_amount > 0 ? (
                    <div className="mt-3">
                      <div className="mb-1 flex justify-between text-xs">
                        <span>Used {fmtNumber(s.used_amount)}</span>
                        <span>{fmtPercent(pct)}</span>
                      </div>
                      <ProgressBar value={s.used_amount} max={s.limit_amount} color={s.color} height={10} />
                    </div>
                  ) : null}
                  <div className="mt-3 flex items-center justify-between">
                    <Badge tone={s.kind === "sending" ? "mint" : "lavender"}>{s.kind}</Badge>
                    <Toggle checked={s.enabled} onChange={(v) => update.mutate({ id: s.id, patch: { enabled: v } })} label={s.enabled ? "On" : "Off"} />
                  </div>
                  {s.notes ? <p className="mt-2 text-xs text-muted">{s.notes}</p> : null}
                </div>
              );
            })}
        </div>
      </Card>

      {editing ? (
        <SourceModal
          source={editing}
          onClose={() => setEditing(null)}
          onSave={saveSource}
        />
      ) : null}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        title="Delete limit"
        message={`Remove ${deleting?.name}?`}
      />
    </div>
  );
}

function CeilingBar({
  label,
  value,
  ceiling,
  isBottleneck,
  color,
}: {
  label: string;
  value: number;
  ceiling: number;
  isBottleneck: boolean;
  color: string;
}) {
  const max = Math.max(value, ceiling, 1);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="font-semibold">{label}</span>
        {isBottleneck ? <Badge tone="danger"><Lightbulb size={11} /> Bottleneck</Badge> : null}
      </div>
      <ProgressBar value={value} max={max} color={isBottleneck ? "#E03131" : color} />
    </div>
  );
}

function SourceModal({
  source,
  onClose,
  onSave,
}: {
  source: CapacitySource;
  onClose: () => void;
  onSave: (s: CapacitySource) => void;
}) {
  const [form, setForm] = useState<CapacitySource>(source);
  const set = <K extends keyof CapacitySource>(k: K, v: CapacitySource[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      open
      onClose={onClose}
      title={source.name ? `Edit ${source.name}` : "Add provider limit"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(form)} disabled={!form.name}>
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          <TextField value={form.name} onChange={(v) => set("name", v)} placeholder="Amazon SES" />
        </Field>
        <Field label="Type">
          <SelectField value={form.kind} onChange={(v) => set("kind", v as CapacitySource["kind"])} options={KIND_OPTIONS} />
        </Field>
        <Field label="Color">
          <input type="color" className="input h-10 cursor-pointer p-1" value={form.color} onChange={(e) => set("color", e.target.value)} />
        </Field>
        <Field label="Limit amount">
          <NumberField value={form.limit_amount} onChange={(v) => set("limit_amount", v ?? 0)} min={0} />
        </Field>
        <Field label="Period">
          <SelectField value={form.limit_period} onChange={(v) => set("limit_period", v as CapacitySource["limit_period"])} options={PERIOD_OPTIONS} />
        </Field>
        <Field label="Currently used (optional)" className="sm:col-span-2">
          <NumberField value={form.used_amount} onChange={(v) => set("used_amount", v ?? 0)} min={0} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <TextArea value={form.notes} onChange={(v) => set("notes", v)} />
        </Field>
      </div>
    </Modal>
  );
}
