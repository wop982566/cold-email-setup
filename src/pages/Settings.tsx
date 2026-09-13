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
  RefreshCw,
  FileDown,
} from "lucide-react";
import { Card, Badge, Toggle, Spinner } from "../components/ui/primitives";
import { Modal, ConfirmDialog } from "../components/ui/Modal";
import { instantly, asItems } from "../lib/instantly";
import { buildInstantlyExport, type InstantlyExport } from "../lib/exportData";
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
  SECRET_TABLES,
  TABLES,
} from "../lib/types";
import { db, dbMode } from "../lib/db";
import { MailProfiles } from "../components/settings/MailProfiles";
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
      // Backups are downloaded, mailed around and pasted into chats. SMTP and
      // IMAP passwords do not belong in one.
      if (SECRET_TABLES.includes(t)) continue;
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
          {dbMode === "server" ? <Database size={18} /> : <HardDrive size={18} />} Data storage
        </h2>
        {dbMode === "server" ? (
          <div className="space-y-2">
            <Badge tone="mint">Netlify Blobs (server)</Badge>
            <p className="text-sm text-muted">
              Data is stored server-side in Netlify Blobs — no external database, nothing to pause, and it persists
              across devices. Nothing to configure: it works automatically on any Git-based Netlify deploy.
            </p>
            <p className="text-xs text-muted">
              Tip: a manual drag-and-drop zip deploy doesn't enable Blobs or Functions — deploy from Git.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Badge tone="sun">Local mode</Badge>
            <p className="text-sm">
              Data is stored in this browser only (VITE_FORCE_LOCAL is set). Remove that env var to use the shared
              Netlify Blobs store.
            </p>
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
                ["ANTHROPIC_API_KEY", "Functions", "Claude — sequences + lead analysis/classification"],
                ["ANTHROPIC_MODEL", "Functions", "Optional — defaults to claude-opus-4-8"],
                ["INSTANTLY_API_KEY", "Functions", "Instantly v2 key (read scopes) — live insights"],
                ["OPENAI_API_KEY", "Functions", "OpenAI — lead enrichment + analysis (alt. provider)"],
                ["APP_FUNCTION_TOKEN", "Functions", "Optional — shared secret to lock the functions"],
                ["VITE_APP_TOKEN", "Build", "Optional — must match APP_FUNCTION_TOKEN"],
                ["VITE_APP_USERNAME", "Build", "Login username (optional)"],
                ["VITE_APP_PASSWORD", "Build", "Login password — set to enable the login gate"],
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

      {/* Mailbox credentials — used when creating inboxes in bulk */}
      <MailProfiles />

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

      <InstantlyExportSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export the LIVE Instantly workspace to CSV: accounts (with tags + settings +
// the campaigns each is connected to), campaigns (with their connected inboxes
// + tags), and a flat campaign↔account map. Fetches through the same read-only
// proxy the rest of the app uses; the CSV build (exportData.ts) is pure/tested.
// Passwords are never included.
// ---------------------------------------------------------------------------
function InstantlyExportSection() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [built, setBuilt] = useState<InstantlyExport | null>(null);
  const stamp = new Date().toISOString().slice(0, 10);

  async function fetchAndBuild() {
    setBusy(true);
    setBuilt(null);
    setStatus("Fetching accounts, campaigns and tags from Instantly…");
    try {
      const [accRes, campRes, tagRes] = await Promise.all([
        instantly.accounts(),
        instantly.campaigns(),
        instantly.tags(),
      ]);
      if (!accRes.ok) {
        toast.push(
          accRes.configured === false
            ? "Instantly isn't connected — add INSTANTLY_API_KEY in Netlify."
            : `Couldn't fetch accounts: ${accRes.error ?? "failed"}`,
          "error",
        );
        return;
      }
      const accounts = asItems<Record<string, unknown>>(accRes.data);
      let campaigns = campRes.ok ? asItems<Record<string, unknown>>(campRes.data) : [];
      if (!campRes.ok) toast.push(`Campaigns didn't load: ${campRes.error ?? "failed"} — exporting accounts only.`, "info");

      // The /campaigns list may omit email_list (the campaign→inbox linkage).
      // Fetch the detail for any campaign missing it so the connections are complete.
      const idOf = (c: Record<string, unknown>) =>
        String(c.id ?? c.campaign_id ?? "").trim();
      const missing = campaigns.filter((c) => {
        const l = (c as { email_list?: unknown }).email_list;
        return (!Array.isArray(l) || l.length === 0) && idOf(c);
      });
      if (missing.length) {
        setStatus(`Resolving connected inboxes for ${missing.length} campaign(s)…`);
        const details = await Promise.all(missing.map((c) => instantly.campaignDetail(idOf(c))));
        const byId = new Map<string, Record<string, unknown>>();
        details.forEach((d, i) => {
          if (d.ok && d.data && typeof d.data === "object") byId.set(idOf(missing[i]), d.data as Record<string, unknown>);
        });
        campaigns = campaigns.map((c) => {
          const det = byId.get(idOf(c));
          const l = det?.email_list;
          return Array.isArray(l) ? { ...c, email_list: l } : c;
        });
      }

      const tagsPayload = tagRes.ok ? (tagRes as { data?: unknown }).data ?? null : null;
      setStatus("Building CSVs…");
      const out = buildInstantlyExport({ accounts, campaigns, tagsPayload });
      setBuilt(out);
      toast.push(
        `Ready: ${out.counts.accounts} accounts, ${out.counts.campaigns} campaigns, ${out.counts.connections} connections`,
        "success",
      );
    } catch (e) {
      toast.push(`Export failed: ${e instanceof Error ? e.message : "unknown error"}`, "error");
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  function downloadAll() {
    if (!built) return;
    download(`instantly-accounts-${stamp}.csv`, built.accountsCsv);
    download(`instantly-campaigns-${stamp}.csv`, built.campaignsCsv);
    download(`instantly-campaign-account-map-${stamp}.csv`, built.mapCsv);
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 flex items-center gap-2 text-lg">
        <Database size={18} /> Export Instantly data (CSV)
      </h2>
      <p className="mb-3 text-sm text-muted">
        Pulls your live Instantly workspace: every email account with its tags, settings and connected
        campaigns; every campaign with its connected inboxes; and a flat campaign↔account map. Passwords
        are never included.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={() => void fetchAndBuild()} disabled={busy}>
          {busy ? <Spinner /> : <RefreshCw size={16} />} {built ? "Refresh from Instantly" : "Fetch from Instantly"}
        </button>
        {status ? <span className="text-sm text-muted">{status}</span> : null}
      </div>

      {built ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge tone="mint">{built.counts.accounts} accounts</Badge>
            <Badge tone="sky">{built.counts.campaigns} campaigns</Badge>
            <Badge tone="lavender">{built.counts.connections} connections</Badge>
            <Badge tone="white">{built.counts.taggedAccounts} tagged</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost btn-sm" onClick={() => download(`instantly-accounts-${stamp}.csv`, built.accountsCsv)}>
              <FileDown size={14} /> accounts.csv
            </button>
            <button className="btn-ghost btn-sm" onClick={() => download(`instantly-campaigns-${stamp}.csv`, built.campaignsCsv)}>
              <FileDown size={14} /> campaigns.csv
            </button>
            <button className="btn-ghost btn-sm" onClick={() => download(`instantly-campaign-account-map-${stamp}.csv`, built.mapCsv)}>
              <FileDown size={14} /> campaign-account-map.csv
            </button>
            <button className="btn-primary btn-sm" onClick={downloadAll}>
              <Download size={14} /> Download all 3
            </button>
          </div>
          {built.counts.accounts === 0 ? (
            <p className="text-xs text-danger">Instantly returned no accounts — check the API key's read scopes.</p>
          ) : null}
        </div>
      ) : null}
    </Card>
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
