import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Papa from "papaparse";
import {
  Plus,
  Search,
  RefreshCw,
  Download,
  Upload,
  Pencil,
  Trash2,
  Globe,
  Calendar,
} from "lucide-react";
import { Card, Badge, EmptyState } from "../components/ui/primitives";
import { TriStateBadge, ProviderLogo } from "../components/ui/badges";
import { Modal, ConfirmDialog } from "../components/ui/Modal";
import { Field, TextField, NumberField, SelectField, TextArea } from "../components/ui/Field";
import { useToast } from "../components/ui/toast";
import {
  useCollection,
  useInsert,
  useUpdate,
  useRemove,
  useInsertMany,
} from "../lib/hooks";
import {
  Campaign,
  CustomField,
  Domain,
  TABLES,
  TriState,
} from "../lib/types";
import { daysUntil, fmtDate } from "../lib/format";
import { download, uuid } from "../lib/utils";
import { lookupDomainExpiry } from "../lib/functions";

const TRISTATE_OPTIONS = [
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" },
  { value: "Partially", label: "Partially" },
  { value: "NA", label: "N/A" },
  { value: "", label: "—" },
];

function blankDomain(position: number): Domain {
  return {
    id: uuid(),
    position,
    domain_name: "",
    email_1: "",
    email_2: "",
    expiry_date: null,
    expiry_source: "manual",
    expiry_checked_at: null,
    domain_provider: "IONOS",
    mailing_server: "Amazon SES",
    mailing_status: "",
    dns_provider: "Cloudflare",
    dns_status: "",
    email_forward: "Cloudflare",
    hosting_provider: "Netlify",
    hosting_account: "",
    website_note: "",
    emails_forwarded_to: "",
    campaign_id: null,
    campaign_label: "",
    gravatar: "",
    gmail_send_configured: "",
    connected_to_instantly: "",
    warmup_started: "",
    mailbox_daily_limit: null,
    renewal_cost: 12,
    notes: "",
    custom: {},
  };
}

function ExpiryBadge({ date }: { date: string | null }) {
  const days = daysUntil(date);
  if (date === null || days === null) return <span className="text-muted">—</span>;
  const tone = days < 0 ? "danger" : days <= 7 ? "danger" : days <= 30 ? "coral" : days <= 60 ? "sun" : "white";
  return (
    <span className="flex items-center gap-2">
      <span className="text-sm font-semibold">{fmtDate(date)}</span>
      <Badge tone={tone}>{days < 0 ? "Expired" : `${days}d`}</Badge>
    </span>
  );
}

export default function Domains() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const { data: domains = [], isLoading } = useCollection<Domain>(TABLES.domains);
  const { data: campaigns = [] } = useCollection<Campaign>(TABLES.campaigns);
  const { data: customFields = [] } = useCollection<CustomField>(TABLES.customFields);
  const insert = useInsert<Domain>(TABLES.domains);
  const insertMany = useInsertMany<Domain>(TABLES.domains);
  const update = useUpdate<Domain>(TABLES.domains);
  const remove = useRemove(TABLES.domains);

  const [search, setSearch] = useState("");
  const [campaignFilter, setCampaignFilter] = useState("");
  const [editing, setEditing] = useState<Domain | null>(null);
  const [deleting, setDeleting] = useState<Domain | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [bulkChecking, setBulkChecking] = useState(false);

  const expiringOnly = params.get("filter") === "expiring";
  const domainCustomFields = customFields.filter((f) => f.entity === "domains");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return domains
      .filter((d) => {
        if (q) {
          const hay = `${d.domain_name} ${d.email_1} ${d.email_2} ${d.emails_forwarded_to} ${d.campaign_label}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (campaignFilter && d.campaign_id !== campaignFilter) return false;
        if (expiringOnly) {
          const days = daysUntil(d.expiry_date);
          if (days === null || days > 30) return false;
        }
        return true;
      })
      .sort((a, b) => a.position - b.position);
  }, [domains, search, campaignFilter, expiringOnly]);

  async function save(d: Domain) {
    const campaign = campaigns.find((c) => c.id === d.campaign_id);
    const payload = { ...d, campaign_label: campaign?.name ?? d.campaign_label };
    const exists = domains.some((x) => x.id === d.id);
    try {
      if (exists) {
        const { id, created_at, ...patch } = payload;
        await update.mutateAsync({ id, patch });
      } else {
        await insert.mutateAsync(payload);
      }
      toast.push(`Saved ${d.domain_name}`);
      setEditing(null);
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Save failed", "error");
    }
  }

  async function checkExpiry(d: Domain) {
    setChecking(d.id);
    const res = await lookupDomainExpiry(d.domain_name);
    setChecking(null);
    if (res.ok && res.expiry) {
      await update.mutateAsync({
        id: d.id,
        patch: {
          expiry_date: res.expiry,
          expiry_source: "auto",
          expiry_checked_at: new Date().toISOString(),
          domain_provider: res.registrar || d.domain_provider,
        } as Partial<Domain>,
      });
      toast.push(`${d.domain_name}: expiry ${res.expiry}`);
    } else {
      toast.push(
        `Couldn't auto-fetch ${d.domain_name} (${res.error ?? "no data"}). Enter it manually.`,
        "error",
      );
    }
  }

  async function checkAll() {
    setBulkChecking(true);
    let ok = 0;
    for (const d of filtered) {
      const res = await lookupDomainExpiry(d.domain_name);
      if (res.ok && res.expiry) {
        ok++;
        await update.mutateAsync({
          id: d.id,
          patch: {
            expiry_date: res.expiry,
            expiry_source: "auto",
            expiry_checked_at: new Date().toISOString(),
          } as Partial<Domain>,
        });
      }
    }
    setBulkChecking(false);
    toast.push(`Auto-fetched ${ok}/${filtered.length} expiry dates`, ok ? "success" : "error");
  }

  function exportCsv() {
    const rows = filtered.map((d) => ({
      No: d.position,
      Domain: d.domain_name,
      "Email 1": d.email_1,
      "Email 2": d.email_2,
      "Expiry date": d.expiry_date ?? "",
      "Domain provider": d.domain_provider,
      "Mailing server": d.mailing_server,
      DNS: d.dns_provider,
      "Email forward": d.email_forward,
      "Hosting / Website": d.website_note,
      "Forwarded to": d.emails_forwarded_to,
      Campaign: d.campaign_label,
      Gravatar: d.gravatar,
      "Gmail send configured": d.gmail_send_configured,
      "Connected to Instantly": d.connected_to_instantly,
      "Warmup started": d.warmup_started,
      "Per-mailbox/day": d.mailbox_daily_limit ?? "",
      Notes: d.notes,
    }));
    download(`domains-${new Date().toISOString().slice(0, 10)}.csv`, Papa.unparse(rows));
  }

  function importCsv(file: File) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        const maxPos = domains.reduce((m, d) => Math.max(m, d.position), 0);
        const rows: Domain[] = (result.data as Record<string, string>[])
          .filter((r) => r["Domain"] || r["Domain name"] || r["domain_name"])
          .map((r, i) => {
            const name = r["Domain"] || r["Domain name"] || r["domain_name"] || "";
            return {
              ...blankDomain(maxPos + i + 1),
              domain_name: name,
              email_1: r["Email 1"] || `tanuj@${name}`,
              email_2: r["Email 2"] || `tanuj.s@${name}`,
              expiry_date: r["Expiry date"] || null,
              domain_provider: r["Domain provider"] || "IONOS",
              emails_forwarded_to: r["Forwarded to"] || r["Emails forwarded to"] || "",
              campaign_label: r["Campaign"] || r["To use in"] || "",
              connected_to_instantly: (r["Connected to Instantly"] as TriState) || "",
              warmup_started: (r["Warmup started"] as TriState) || "",
              gmail_send_configured: (r["Gmail send configured"] as TriState) || "",
            };
          });
        if (rows.length === 0) {
          toast.push("No rows found in CSV", "error");
          return;
        }
        await insertMany.mutateAsync(rows);
        toast.push(`Imported ${rows.length} domains`);
      },
      error: () => toast.push("Failed to parse CSV", "error"),
    });
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input pl-9"
            placeholder="Search domains, emails…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="input max-w-[180px] cursor-pointer"
          value={campaignFilter}
          onChange={(e) => setCampaignFilter(e.target.value)}
        >
          <option value="">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          className={expiringOnly ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
          onClick={() => {
            const next = new URLSearchParams(params);
            if (expiringOnly) next.delete("filter");
            else next.set("filter", "expiring");
            setParams(next);
          }}
        >
          <Calendar size={14} /> Expiring ≤30d
        </button>
        <button className="btn-ghost btn-sm" onClick={checkAll} disabled={bulkChecking}>
          <RefreshCw size={14} className={bulkChecking ? "animate-spin" : ""} /> Auto-fetch expiry
        </button>
        <button className="btn-ghost btn-sm" onClick={exportCsv}>
          <Download size={14} /> Export
        </button>
        <label className="btn-ghost btn-sm cursor-pointer">
          <Upload size={14} /> Import
          <input
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
          />
        </label>
        <button
          className="btn-primary btn-sm"
          onClick={() =>
            setEditing(blankDomain(domains.reduce((m, d) => Math.max(m, d.position), 0) + 1))
          }
        >
          <Plus size={14} /> Add domain
        </button>
      </Card>

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {isLoading ? (
          <div className="p-8 text-center text-muted">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Globe size={32} />}
              title="No domains yet"
              description="Add your first sending domain or import a CSV."
              action={
                <button className="btn-primary btn-sm" onClick={() => setEditing(blankDomain(1))}>
                  <Plus size={14} /> Add domain
                </button>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-ink bg-canvas text-xs uppercase tracking-wide">
                  <th className="table-cell">#</th>
                  <th className="table-cell">Domain</th>
                  <th className="table-cell">Mailboxes</th>
                  <th className="table-cell">Expiry</th>
                  <th className="table-cell">Provider</th>
                  <th className="table-cell">DNS</th>
                  <th className="table-cell">Campaign</th>
                  <th className="table-cell">Instantly</th>
                  <th className="table-cell">Warmup</th>
                  <th className="table-cell">Gmail</th>
                  <th className="table-cell text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => {
                  const campaign = campaigns.find((c) => c.id === d.campaign_id);
                  return (
                    <tr key={d.id} className="border-b border-ink/10 hover:bg-canvas/60">
                      <td className="table-cell font-bold text-muted">{d.position}</td>
                      <td className="table-cell">
                        <p className="font-bold">{d.domain_name}</p>
                        <p className="text-xs text-muted">{d.website_note}</p>
                      </td>
                      <td className="table-cell text-xs">
                        <p>{d.email_1}</p>
                        <p className="text-muted">{d.email_2}</p>
                      </td>
                      <td className="table-cell">
                        <div className="flex items-center gap-2">
                          <ExpiryBadge date={d.expiry_date} />
                          <button
                            title="Auto-fetch expiry"
                            className="text-muted hover:text-ink"
                            onClick={() => checkExpiry(d)}
                          >
                            <RefreshCw size={13} className={checking === d.id ? "animate-spin" : ""} />
                          </button>
                        </div>
                      </td>
                      <td className="table-cell">
                        <ProviderLogo name={d.domain_provider} />
                      </td>
                      <td className="table-cell">
                        <ProviderLogo name={d.dns_provider} />
                      </td>
                      <td className="table-cell">
                        {campaign ? (
                          <span
                            className="badge"
                            style={{ background: campaign.color }}
                          >
                            {campaign.name}
                          </span>
                        ) : (
                          <span className="text-muted">{d.campaign_label || "—"}</span>
                        )}
                      </td>
                      <td className="table-cell">
                        <TriStateBadge value={d.connected_to_instantly} />
                      </td>
                      <td className="table-cell">
                        <TriStateBadge value={d.warmup_started} />
                      </td>
                      <td className="table-cell">
                        <TriStateBadge value={d.gmail_send_configured} />
                      </td>
                      <td className="table-cell text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-canvas"
                            onClick={() => setEditing(d)}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-danger hover:text-white"
                            onClick={() => setDeleting(d)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted">
        Showing {filtered.length} of {domains.length} domains.
      </p>

      {editing ? (
        <DomainModal
          domain={editing}
          campaigns={campaigns}
          customFields={domainCustomFields}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            remove.mutate(deleting.id);
            toast.push(`Deleted ${deleting.domain_name}`);
          }
        }}
        title="Delete domain"
        message={`Remove ${deleting?.domain_name}? This can't be undone.`}
      />
    </div>
  );
}

function DomainModal({
  domain,
  campaigns,
  customFields,
  onClose,
  onSave,
}: {
  domain: Domain;
  campaigns: Campaign[];
  customFields: CustomField[];
  onClose: () => void;
  onSave: (d: Domain) => void;
}) {
  const [form, setForm] = useState<Domain>(domain);
  const set = <K extends keyof Domain>(k: K, v: Domain[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const setCustom = (key: string, v: unknown) =>
    setForm((f) => ({ ...f, custom: { ...f.custom, [key]: v } }));

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={domain.domain_name ? `Edit ${domain.domain_name}` : "Add domain"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(form)} disabled={!form.domain_name}>
            Save domain
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Domain name" className="sm:col-span-2">
          <TextField value={form.domain_name} onChange={(v) => set("domain_name", v)} placeholder="example.com" />
        </Field>
        <Field label="Email 1">
          <TextField value={form.email_1} onChange={(v) => set("email_1", v)} />
        </Field>
        <Field label="Email 2">
          <TextField value={form.email_2} onChange={(v) => set("email_2", v)} />
        </Field>
        <Field label="Expiry date" hint={form.expiry_source === "auto" ? "Auto-fetched" : "Manual"}>
          <TextField type="date" value={form.expiry_date ?? ""} onChange={(v) => set("expiry_date", v || null)} />
        </Field>
        <Field label="Per-mailbox daily limit (override)" hint="Leave blank to use the global default">
          <NumberField value={form.mailbox_daily_limit} onChange={(v) => set("mailbox_daily_limit", v)} min={0} />
        </Field>
        <Field label="Domain provider / registrar">
          <TextField value={form.domain_provider} onChange={(v) => set("domain_provider", v)} />
        </Field>
        <Field label="Renewal cost / year">
          <NumberField value={form.renewal_cost} onChange={(v) => set("renewal_cost", v ?? 0)} min={0} step={0.01} />
        </Field>
        <Field label="Mailing server">
          <TextField value={form.mailing_server} onChange={(v) => set("mailing_server", v)} />
        </Field>
        <Field label="Mailing server status">
          <SelectField value={form.mailing_status} onChange={(v) => set("mailing_status", v as TriState)} options={TRISTATE_OPTIONS} />
        </Field>
        <Field label="DNS provider">
          <TextField value={form.dns_provider} onChange={(v) => set("dns_provider", v)} />
        </Field>
        <Field label="DNS status">
          <SelectField value={form.dns_status} onChange={(v) => set("dns_status", v as TriState)} options={TRISTATE_OPTIONS} />
        </Field>
        <Field label="Email forward (provider)">
          <TextField value={form.email_forward} onChange={(v) => set("email_forward", v)} />
        </Field>
        <Field label="Emails forwarded to">
          <TextField value={form.emails_forwarded_to} onChange={(v) => set("emails_forwarded_to", v)} />
        </Field>
        <Field label="Hosting provider">
          <TextField value={form.hosting_provider} onChange={(v) => set("hosting_provider", v)} />
        </Field>
        <Field label="Hosting account">
          <TextField value={form.hosting_account} onChange={(v) => set("hosting_account", v)} placeholder="git login - tanuj9825" />
        </Field>
        <Field label="Website / hosting note" className="sm:col-span-2">
          <TextField value={form.website_note} onChange={(v) => set("website_note", v)} />
        </Field>
        <Field label="Campaign">
          <select className="input cursor-pointer" value={form.campaign_id ?? ""} onChange={(e) => set("campaign_id", e.target.value || null)}>
            <option value="">— Unassigned —</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Gravatar set up">
          <SelectField value={form.gravatar} onChange={(v) => set("gravatar", v as TriState)} options={TRISTATE_OPTIONS} />
        </Field>
        <Field label="Gmail send-as configured">
          <SelectField value={form.gmail_send_configured} onChange={(v) => set("gmail_send_configured", v as TriState)} options={TRISTATE_OPTIONS} />
        </Field>
        <Field label="Connected to Instantly">
          <SelectField value={form.connected_to_instantly} onChange={(v) => set("connected_to_instantly", v as TriState)} options={TRISTATE_OPTIONS} />
        </Field>
        <Field label="Warmup started">
          <SelectField value={form.warmup_started} onChange={(v) => set("warmup_started", v as TriState)} options={TRISTATE_OPTIONS} />
        </Field>

        {customFields.map((cf) => (
          <Field key={cf.id} label={cf.label}>
            {cf.type === "select" ? (
              <SelectField
                value={String(form.custom[cf.key] ?? "")}
                onChange={(v) => setCustom(cf.key, v)}
                options={[{ value: "", label: "—" }, ...cf.options.map((o) => ({ value: o, label: o }))]}
              />
            ) : cf.type === "number" ? (
              <NumberField value={(form.custom[cf.key] as number) ?? null} onChange={(v) => setCustom(cf.key, v)} />
            ) : (
              <TextField
                type={cf.type === "date" ? "date" : "text"}
                value={String(form.custom[cf.key] ?? "")}
                onChange={(v) => setCustom(cf.key, v)}
              />
            )}
          </Field>
        ))}

        <Field label="Notes" className="sm:col-span-2">
          <TextArea value={form.notes} onChange={(v) => set("notes", v)} />
        </Field>
      </div>
    </Modal>
  );
}
