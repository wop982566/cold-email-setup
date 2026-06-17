import { useEffect, useState } from "react";
import {
  Save,
  Plus,
  Trash2,
  Pencil,
  Database,
  HardDrive,
  Settings as SettingsIcon,
  Tag,
  SlidersHorizontal,
  Download,
  RotateCcw,
  KeyRound,
} from "lucide-react";
import { Card, Badge, Toggle } from "../components/ui/primitives";
import { Modal, ConfirmDialog } from "../components/ui/Modal";
import { Field, TextField, SelectField, TextArea, NumberField } from "../components/ui/Field";
import { useToast } from "../components/ui/toast";
import {
  useCollection,
  useInsert,
  useUpdate,
  useRemove,
  useSettings,
  useSaveSettings,
} from "../lib/hooks";
import {
  AppSettings,
  Campaign,
  CustomField,
  FieldType,
  TABLES,
} from "../lib/types";
import { db, dbMode } from "../lib/db";
import { supabaseInfo } from "../lib/supabase";
import { download, uuid, slugify } from "../lib/utils";

const CURRENCIES = ["USD", "EUR", "GBP", "INR", "CAD", "AUD"];

export default function Settings() {
  const toast = useToast();
  const { data: settings } = useSettings();
  const saveSettings = useSaveSettings();
  const [form, setForm] = useState<AppSettings | null>(null);

  useEffect(() => {
    if (settings && !form) setForm(settings);
  }, [settings, form]);

  if (!form) return null;
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setForm({ ...form, [k]: v });

  async function exportAll() {
    const tables = Object.values(TABLES);
    const dump: Record<string, unknown> = { exported_at: new Date().toISOString() };
    for (const t of tables) {
      if (t === TABLES.settings) continue;
      dump[t] = await db.list(t);
    }
    dump.settings = await db.getSettings();
    download(`cec-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(dump, null, 2), "application/json");
  }

  return (
    <div className="space-y-6">
      {/* Workspace */}
      <Card className="p-5">
        <h2 className="mb-4 flex items-center gap-2 text-lg">
          <SettingsIcon size={18} /> Workspace
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Workspace name">
            <TextField value={form.org_name} onChange={(v) => set("org_name", v)} />
          </Field>
          <Field label="Currency">
            <SelectField value={form.currency} onChange={(v) => set("currency", v)} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
          </Field>
          <Field label="Expiry reminder window (days)">
            <NumberField value={form.reminder_window_days} onChange={(v) => set("reminder_window_days", v ?? 30)} min={1} />
          </Field>
          <Field label="Accent color">
            <input type="color" className="input h-10 cursor-pointer p-1" value={form.accent} onChange={(e) => set("accent", e.target.value)} />
          </Field>
          <Field label="Emails per lead (default)">
            <NumberField value={form.default_sends_per_lead} onChange={(v) => set("default_sends_per_lead", v ?? 1)} min={1} />
          </Field>
          <Field label="AI enrichment">
            <div className="flex h-10 items-center">
              <Toggle checked={form.ai_enabled} onChange={(v) => set("ai_enabled", v)} label={form.ai_enabled ? "Enabled" : "Disabled"} />
            </div>
          </Field>
        </div>
        <button
          className="btn-primary mt-4"
          onClick={async () => {
            await saveSettings.mutateAsync(form);
            toast.push("Settings saved");
          }}
        >
          <Save size={16} /> Save settings
        </button>
      </Card>

      <CampaignsSection />
      <CustomFieldsSection />

      {/* Database / connection */}
      <Card className="p-5">
        <h2 className="mb-2 flex items-center gap-2 text-lg">
          {dbMode === "supabase" ? <Database size={18} /> : <HardDrive size={18} />} Database & connection
        </h2>
        {dbMode === "supabase" ? (
          <div className="space-y-2">
            <Badge tone="mint">Connected to Supabase</Badge>
            <p className="text-sm text-muted">Project URL: <code>{supabaseInfo.url}</code></p>
          </div>
        ) : (
          <div className="space-y-3">
            <Badge tone="sun">Local mode</Badge>
            <p className="text-sm">
              Data is stored in this browser only. To sync across devices and make it permanent, connect Supabase.
            </p>
            <div className="rounded-xl border-2 border-ink bg-canvas p-4">
              <p className="mb-2 flex items-center gap-2 font-bold">
                <KeyRound size={16} /> To connect Supabase, set these and redeploy:
              </p>
              <pre className="overflow-x-auto rounded-lg border-2 border-ink bg-white p-3 text-xs">
{`VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>`}
              </pre>
              <p className="mt-2 text-xs text-muted">
                Run the SQL in <code>supabase/migrations</code> first to create the tables and seed your 20 domains.
                See the README for the full step-by-step.
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* Secrets & integrations */}
      <Card className="p-5">
        <h2 className="mb-2 flex items-center gap-2 text-lg">
          <KeyRound size={18} /> Secrets & integrations
        </h2>
        <p className="mb-3 text-sm text-muted">
          Add these in <b>Netlify → Site settings → Environment variables</b>. Once set, the matching feature works
          automatically — no code change.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                <th className="table-cell">Variable</th>
                <th className="table-cell">Scope</th>
                <th className="table-cell">Enables</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["VITE_SUPABASE_URL", "Build", "Supabase database (project URL)"],
                ["VITE_SUPABASE_ANON_KEY", "Build", "Supabase database (anon public key)"],
                ["ANTHROPIC_API_KEY", "Functions", "Claude AI sequence generation"],
                ["ANTHROPIC_MODEL", "Functions", "Optional — defaults to claude-opus-4-8"],
                ["INSTANTLY_API_KEY", "Functions", "Instantly v2 key (read scopes) — live insights"],
                ["OPENAI_API_KEY", "Functions", "AI lead enrichment"],
                ["APP_FUNCTION_TOKEN", "Functions", "Optional — shared secret to lock the functions"],
                ["VITE_APP_TOKEN", "Build", "Optional — must match APP_FUNCTION_TOKEN"],
              ].map(([name, scope, enables]) => (
                <tr key={name} className="border-b border-ink/10">
                  <td className="table-cell"><code className="font-bold">{name}</code></td>
                  <td className="table-cell"><Badge tone={scope === "Build" ? "lavender" : "sky"}>{scope}</Badge></td>
                  <td className="table-cell text-muted">{enables}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Data tools */}
      <Card className="p-5">
        <h2 className="mb-3 text-lg">Data</h2>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={exportAll}>
            <Download size={16} /> Export everything (JSON)
          </button>
          {dbMode === "local" && db.resetLocal ? (
            <button
              className="btn bg-danger text-white shadow-hard"
              onClick={() => {
                db.resetLocal?.();
                toast.push("Local data reset to seed");
                setTimeout(() => window.location.reload(), 600);
              }}
            >
              <RotateCcw size={16} /> Reset local data to seed
            </button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function CampaignsSection() {
  const toast = useToast();
  const { data: campaigns = [] } = useCollection<Campaign>(TABLES.campaigns);
  const insert = useInsert<Campaign>(TABLES.campaigns);
  const update = useUpdate<Campaign>(TABLES.campaigns);
  const remove = useRemove(TABLES.campaigns);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [deleting, setDeleting] = useState<Campaign | null>(null);

  async function save(c: Campaign) {
    const exists = campaigns.some((x) => x.id === c.id);
    if (exists) {
      const { id, created_at, ...patch } = c;
      await update.mutateAsync({ id, patch });
    } else {
      await insert.mutateAsync(c);
    }
    toast.push("Campaign saved");
    setEditing(null);
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg">
          <Tag size={18} /> Campaigns
        </h2>
        <button
          className="btn-primary btn-sm"
          onClick={() => setEditing({ id: uuid(), name: "", type: "", description: "", color: "#FF90E8", status: "active" })}
        >
          <Plus size={14} /> Add campaign
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {campaigns.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-xl border-2 border-ink bg-white p-3">
            <div className="flex items-center gap-2">
              <span className="h-5 w-5 rounded-full border-2 border-ink" style={{ background: c.color }} />
              <div>
                <p className="font-bold">{c.name}</p>
                <p className="text-xs text-muted">{c.type}</p>
              </div>
            </div>
            <div className="flex gap-1">
              <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-canvas" onClick={() => setEditing(c)}>
                <Pencil size={13} />
              </button>
              <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-danger hover:text-white" onClick={() => setDeleting(c)}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing ? (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={editing.name ? "Edit campaign" : "Add campaign"}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={() => save(editing)} disabled={!editing.name}>
                Save
              </button>
            </>
          }
        >
          <div className="space-y-3">
            <Field label="Name">
              <TextField value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">
                <TextField value={editing.type} onChange={(v) => setEditing({ ...editing, type: v })} />
              </Field>
              <Field label="Color">
                <input type="color" className="input h-10 cursor-pointer p-1" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
              </Field>
            </div>
            <Field label="Description">
              <TextArea value={editing.description} onChange={(v) => setEditing({ ...editing, description: v })} />
            </Field>
          </div>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        title="Delete campaign"
        message={`Remove ${deleting?.name}? Domains keep their label but lose the link.`}
      />
    </Card>
  );
}

function CustomFieldsSection() {
  const toast = useToast();
  const { data: fields = [] } = useCollection<CustomField>(TABLES.customFields);
  const insert = useInsert<CustomField>(TABLES.customFields);
  const remove = useRemove(TABLES.customFields);
  const [editing, setEditing] = useState<CustomField | null>(null);

  const TYPES: { value: FieldType; label: string }[] = [
    { value: "text", label: "Text" },
    { value: "number", label: "Number" },
    { value: "date", label: "Date" },
    { value: "boolean", label: "Yes/No" },
    { value: "select", label: "Dropdown" },
  ];

  async function save(f: CustomField) {
    await insert.mutateAsync({ ...f, key: f.key || slugify(f.label) });
    toast.push("Custom field added");
    setEditing(null);
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg">
          <SlidersHorizontal size={18} /> Custom fields
        </h2>
        <button
          className="btn-primary btn-sm"
          onClick={() => setEditing({ id: uuid(), entity: "domains", key: "", label: "", type: "text", options: [], sort: fields.length })}
        >
          <Plus size={14} /> Add field
        </button>
      </div>
      {fields.length === 0 ? (
        <p className="text-sm text-muted">
          Add your own columns to Domains or Leads — e.g. "ESP score", "Persona", "Sequence". They show up in the edit forms.
        </p>
      ) : (
        <div className="space-y-2">
          {fields.map((f) => (
            <div key={f.id} className="flex items-center justify-between rounded-xl border-2 border-ink bg-white p-3">
              <div className="flex items-center gap-2">
                <Badge tone="lavender">{f.entity}</Badge>
                <span className="font-bold">{f.label}</span>
                <span className="text-xs text-muted">({f.type})</span>
              </div>
              <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-danger hover:text-white" onClick={() => remove.mutate(f.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {editing ? (
        <Modal
          open
          onClose={() => setEditing(null)}
          title="Add custom field"
          footer={
            <>
              <button className="btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={() => save(editing)} disabled={!editing.label}>
                Add
              </button>
            </>
          }
        >
          <div className="space-y-3">
            <Field label="Applies to">
              <SelectField
                value={editing.entity}
                onChange={(v) => setEditing({ ...editing, entity: v as CustomField["entity"] })}
                options={[{ value: "domains", label: "Domains" }, { value: "leads", label: "Leads" }]}
              />
            </Field>
            <Field label="Label">
              <TextField value={editing.label} onChange={(v) => setEditing({ ...editing, label: v })} />
            </Field>
            <Field label="Type">
              <SelectField value={editing.type} onChange={(v) => setEditing({ ...editing, type: v as FieldType })} options={TYPES} />
            </Field>
            {editing.type === "select" ? (
              <Field label="Options (comma separated)">
                <TextField
                  value={editing.options.join(", ")}
                  onChange={(v) => setEditing({ ...editing, options: v.split(",").map((s) => s.trim()).filter(Boolean) })}
                />
              </Field>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}
