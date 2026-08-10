import { useMemo, useState } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  BookOpenCheck,
  ChevronUp,
  ChevronDown,
  ExternalLink,
  CheckCircle2,
  Circle,
  ListChecks,
} from "lucide-react";
import { Card, Badge, EmptyState } from "../components/ui/primitives";
import { Modal, ConfirmDialog } from "../components/ui/Modal";
import { Field, TextField, TextArea, SelectField } from "../components/ui/Field";
import { ProviderLogo } from "../components/ui/badges";
import { useToast } from "../components/ui/toast";
import {
  useCollection,
  useInsert,
  useUpdate,
  useRemove,
} from "../lib/hooks";
import { SetupPlaybook, SetupStep, TABLES } from "../lib/types";
import { fmtDate } from "../lib/format";
import { uuid } from "../lib/utils";

const CATEGORIES = [
  "Domains",
  "DNS",
  "Email Server",
  "Forwarding",
  "Sites",
  "Gmail",
  "Sending Tool",
  "Warmup",
  "Other",
];

export default function Setups() {
  const toast = useToast();
  const { data: setups = [] } = useCollection<SetupPlaybook>(TABLES.setups);
  const { data: steps = [] } = useCollection<SetupStep>(TABLES.setupSteps);
  const insertSetup = useInsert<SetupPlaybook>(TABLES.setups);
  const updateSetup = useUpdate<SetupPlaybook>(TABLES.setups);
  const removeSetup = useRemove(TABLES.setups);
  const insertStep = useInsert<SetupStep>(TABLES.setupSteps);
  const updateStep = useUpdate<SetupStep>(TABLES.setupSteps);
  const removeStep = useRemove(TABLES.setupSteps);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingSetup, setEditingSetup] = useState<SetupPlaybook | null>(null);
  const [editingStep, setEditingStep] = useState<SetupStep | null>(null);
  const [deletingStep, setDeletingStep] = useState<SetupStep | null>(null);

  const active = setups.find((s) => s.id === activeId) ?? setups[0] ?? null;
  const activeSteps = useMemo(
    () => steps.filter((s) => s.setup_id === active?.id).sort((a, b) => a.position - b.position),
    [steps, active],
  );

  async function saveSetup(s: SetupPlaybook) {
    const exists = setups.some((x) => x.id === s.id);
    if (exists) {
      const { id, created_at, ...patch } = s;
      await updateSetup.mutateAsync({ id, patch });
    } else {
      await insertSetup.mutateAsync(s);
      setActiveId(s.id);
    }
    toast.push("Setup saved");
    setEditingSetup(null);
  }

  async function saveStep(s: SetupStep) {
    const exists = steps.some((x) => x.id === s.id);
    if (exists) {
      const { id, created_at, ...patch } = s;
      await updateStep.mutateAsync({ id, patch });
    } else {
      await insertStep.mutateAsync(s);
    }
    toast.push("Step saved");
    setEditingStep(null);
  }

  async function moveStep(step: SetupStep, dir: -1 | 1) {
    const idx = activeSteps.findIndex((s) => s.id === step.id);
    const swap = activeSteps[idx + dir];
    if (!swap) return;
    await updateStep.mutateAsync({ id: step.id, patch: { position: swap.position } });
    await updateStep.mutateAsync({ id: swap.id, patch: { position: step.position } });
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
      {/* Setups list */}
      <Card className="h-fit p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-extrabold uppercase">
            <BookOpenCheck size={16} /> Playbooks
          </h2>
          <button
            className="btn-ghost btn-sm"
            onClick={() =>
              setEditingSetup({
                id: uuid(),
                name: "",
                date: new Date().toISOString().slice(0, 10),
                summary: "",
                status: "active",
              })
            }
          >
            <Plus size={14} />
          </button>
        </div>
        {setups.length === 0 ? (
          <p className="p-2 text-xs text-muted">No playbooks yet.</p>
        ) : (
          setups.map((s) => (
            <button
              key={s.id}
              className={`mb-1 w-full rounded-lg border-2 px-2 py-2 text-left ${
                active?.id === s.id ? "border-ink bg-sun" : "border-transparent hover:bg-canvas"
              }`}
              onClick={() => setActiveId(s.id)}
            >
              <p className="text-sm font-bold leading-tight">{s.name}</p>
              <p className="text-xs text-muted">{fmtDate(s.date)}</p>
            </button>
          ))
        )}
      </Card>

      {/* Setup detail */}
      <div className="space-y-4">
        {!active ? (
          <Card className="p-6">
            <EmptyState
              icon={<BookOpenCheck size={32} />}
              title="Document a setup"
              description="Record exactly how you built a cold-email setup — registrar, DNS, mail server, forwarding, sites, Gmail send-as, warmup — so next year's you remembers everything."
              action={
                <button
                  className="btn-primary btn-sm"
                  onClick={() =>
                    setEditingSetup({
                      id: uuid(),
                      name: "",
                      date: new Date().toISOString().slice(0, 10),
                      summary: "",
                      status: "active",
                    })
                  }
                >
                  <Plus size={14} /> New playbook
                </button>
              }
            />
          </Card>
        ) : (
          <>
            <Card className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-2xl">{active.name}</h2>
                    <Badge tone={active.status === "active" ? "mint" : "white"}>{active.status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted">{fmtDate(active.date)}</p>
                  <p className="mt-3 max-w-3xl text-sm">{active.summary}</p>
                </div>
                <div className="flex gap-2">
                  <button className="btn-ghost btn-sm" onClick={() => setEditingSetup(active)}>
                    <Pencil size={14} /> Edit
                  </button>
                  <button
                    className="btn-sm btn bg-danger text-white shadow-hard"
                    onClick={() => {
                      removeSetup.mutate(active.id);
                      activeSteps.forEach((s) => removeStep.mutate(s.id));
                      setActiveId(null);
                      toast.push("Playbook deleted");
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </Card>

            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-lg font-extrabold">
                <ListChecks size={18} /> Steps ({activeSteps.length})
              </h3>
              <button
                className="btn-primary btn-sm"
                onClick={() =>
                  setEditingStep({
                    id: uuid(),
                    setup_id: active.id,
                    position: activeSteps.length + 1,
                    title: "",
                    category: "Other",
                    platform: "",
                    account_used: "",
                    details: "",
                    links: [],
                    done: false,
                  })
                }
              >
                <Plus size={14} /> Add step
              </button>
            </div>

            {/* Timeline */}
            <div className="space-y-3">
              {activeSteps.map((step, i) => (
                <Card key={step.id} className="p-4">
                  <div className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-ink bg-pink text-sm font-extrabold">
                        {i + 1}
                      </span>
                      {i < activeSteps.length - 1 ? <span className="my-1 w-0.5 flex-1 bg-ink/20" /> : null}
                    </div>
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {step.platform ? <ProviderLogo name={step.platform} /> : null}
                          <h4 className="text-base font-extrabold">{step.title}</h4>
                          <Badge tone="lavender">{step.category}</Badge>
                          {step.done ? (
                            <CheckCircle2 size={16} className="text-mint" />
                          ) : (
                            <Circle size={16} className="text-muted" />
                          )}
                        </div>
                        <div className="flex gap-1">
                          <button className="rounded-lg border-2 border-ink bg-white p-1 disabled:opacity-30" onClick={() => moveStep(step, -1)} disabled={i === 0}>
                            <ChevronUp size={13} />
                          </button>
                          <button className="rounded-lg border-2 border-ink bg-white p-1 disabled:opacity-30" onClick={() => moveStep(step, 1)} disabled={i === activeSteps.length - 1}>
                            <ChevronDown size={13} />
                          </button>
                          <button className="rounded-lg border-2 border-ink bg-white p-1" onClick={() => setEditingStep(step)}>
                            <Pencil size={13} />
                          </button>
                          <button className="rounded-lg border-2 border-ink bg-white p-1 hover:bg-danger hover:text-white" onClick={() => setDeletingStep(step)}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      {step.platform || step.account_used ? (
                        <p className="mt-1 text-xs font-semibold text-muted">
                          {step.platform}
                          {step.account_used ? ` · ${step.account_used}` : ""}
                        </p>
                      ) : null}
                      {step.details ? <p className="mt-2 text-sm">{step.details}</p> : null}
                      {step.links.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {step.links.map((l, li) => (
                            <a key={li} href={l.url} target="_blank" rel="noreferrer" className="chip hover:bg-sun">
                              <ExternalLink size={11} /> {l.label}
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>

      {editingSetup ? (
        <SetupModal setup={editingSetup} onClose={() => setEditingSetup(null)} onSave={saveSetup} />
      ) : null}
      {editingStep ? (
        <StepModal step={editingStep} onClose={() => setEditingStep(null)} onSave={saveStep} />
      ) : null}
      <ConfirmDialog
        open={!!deletingStep}
        onClose={() => setDeletingStep(null)}
        onConfirm={() => deletingStep && removeStep.mutate(deletingStep.id)}
        title="Delete step"
        message={`Remove "${deletingStep?.title}"?`}
      />
    </div>
  );
}

function SetupModal({
  setup,
  onClose,
  onSave,
}: {
  setup: SetupPlaybook;
  onClose: () => void;
  onSave: (s: SetupPlaybook) => void;
}) {
  const [form, setForm] = useState<SetupPlaybook>(setup);
  return (
    <Modal
      open
      onClose={onClose}
      title={setup.name ? "Edit playbook" : "New playbook"}
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
      <div className="space-y-3">
        <Field label="Name" hint="e.g. 'Cold Email Setup — Spring 2026'">
          <TextField value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextField type="date" value={form.date ?? ""} onChange={(v) => setForm({ ...form, date: v || null })} />
          </Field>
          <Field label="Status">
            <SelectField value={form.status} onChange={(v) => setForm({ ...form, status: v as SetupPlaybook["status"] })} options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }]} />
          </Field>
        </div>
        <Field label="Summary">
          <TextArea rows={4} value={form.summary} onChange={(v) => setForm({ ...form, summary: v })} />
        </Field>
      </div>
    </Modal>
  );
}

function StepModal({
  step,
  onClose,
  onSave,
}: {
  step: SetupStep;
  onClose: () => void;
  onSave: (s: SetupStep) => void;
}) {
  const [form, setForm] = useState<SetupStep>(step);
  const set = <K extends keyof SetupStep>(k: K, v: SetupStep[K]) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={step.title ? "Edit step" : "Add step"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(form)} disabled={!form.title}>
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Title" className="sm:col-span-2">
          <TextField value={form.title} onChange={(v) => set("title", v)} placeholder="Bought the domains" />
        </Field>
        <Field label="Category">
          <SelectField value={form.category} onChange={(v) => set("category", v)} options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
        </Field>
        <Field label="Platform">
          <TextField value={form.platform} onChange={(v) => set("platform", v)} placeholder="IONOS, Cloudflare…" />
        </Field>
        <Field label="Account used" className="sm:col-span-2">
          <TextField value={form.account_used} onChange={(v) => set("account_used", v)} placeholder="git login - tanuj9825" />
        </Field>
        <Field label="Details" className="sm:col-span-2">
          <TextArea rows={4} value={form.details} onChange={(v) => set("details", v)} />
        </Field>
        <Field label="Links (one per line as 'Label | https://url')" className="sm:col-span-2">
          <TextArea
            rows={3}
            value={form.links.map((l) => `${l.label} | ${l.url}`).join("\n")}
            onChange={(v) =>
              set(
                "links",
                v
                  .split("\n")
                  .map((line) => {
                    const [label, url] = line.split("|").map((p) => p.trim());
                    return label && url ? { label, url } : null;
                  })
                  .filter(Boolean) as { label: string; url: string }[],
              )
            }
          />
        </Field>
        <Field label="Completed">
          <SelectField value={form.done ? "yes" : "no"} onChange={(v) => set("done", v === "yes")} options={[{ value: "yes", label: "Done" }, { value: "no", label: "Not done" }]} />
        </Field>
      </div>
    </Modal>
  );
}
