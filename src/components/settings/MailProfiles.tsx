// ---------------------------------------------------------------------------
// Reusable SMTP/IMAP combinations for creating mailboxes in bulk.
//
// These rows hold live credentials. The /data function refuses to serve the
// mail_profiles table unless APP_FUNCTION_TOKEN is set, so an unauthenticated
// deployment simply cannot read or write them — the card explains that rather
// than showing an empty list.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { KeyRound, Plus, Pencil, Trash2, Copy, Eye, EyeOff, Lock, AlertTriangle } from "lucide-react";
import { Card, Badge } from "../ui/primitives";
import { Modal, ConfirmDialog } from "../ui/Modal";
import { Field, TextField, NumberField, TextArea, SelectField } from "../ui/Field";
import { useToast } from "../ui/toast";
import { useCollection, useInsert, useUpdate, useRemove } from "../../lib/hooks";
import { MailProfile, TABLES } from "../../lib/types";
import { uuid } from "../../lib/utils";

/** Sensible starting point: SES sends, the forwarded Gmail receives. */
function blank(): MailProfile {
  return {
    id: uuid(),
    name: "",
    iam_user_name: "",
    smtp_username: "",
    smtp_password: "",
    smtp_host: "email-smtp.us-east-1.amazonaws.com",
    smtp_port: 587,
    imap_username: "{prefix}@{domain}",
    imap_password: "",
    imap_host: "imap.gmail.com",
    imap_port: 993,
    provider_code: 2,
    daily_limit: 30,
    warmup_limit: 20,
    warmup_increment: 1,
    warmup_reply_rate: 30,
    tracking_domain_prefix: "inst",
    notes: "",
  };
}

function PasswordField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-1">
      <input
        type={show ? "text" : "password"}
        className="input flex-1"
        value={value}
        placeholder={placeholder}
        autoComplete="new-password"
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="rounded-lg border-2 border-ink bg-white px-2 hover:bg-canvas"
        onClick={() => setShow((s) => !s)}
        title={show ? "Hide" : "Reveal"}
      >
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

export function MailProfiles() {
  const toast = useToast();
  // A locked table is a permanent 403, so don't spend three retries on it.
  const q = useCollection<MailProfile>(TABLES.mailProfiles, { retry: false });
  const insert = useInsert<MailProfile>(TABLES.mailProfiles);
  const update = useUpdate<MailProfile>(TABLES.mailProfiles);
  const remove = useRemove(TABLES.mailProfiles);

  const [editing, setEditing] = useState<MailProfile | null>(null);
  const [deleting, setDeleting] = useState<MailProfile | null>(null);

  const profiles = q.data ?? [];
  // The gate returns a 403 with an explanatory message; db throws it verbatim.
  const lockedError =
    q.error instanceof Error && /APP_FUNCTION_TOKEN/i.test(q.error.message) ? q.error.message : null;

  async function save(p: MailProfile) {
    const exists = profiles.some((x) => x.id === p.id);
    try {
      if (exists) await update.mutateAsync({ id: p.id, patch: p });
      else await insert.mutateAsync(p);
      setEditing(null);
      toast.push("Profile saved", "success");
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not save profile", "error");
    }
  }

  const set = <K extends keyof MailProfile>(k: K, v: MailProfile[K]) =>
    setEditing((p) => (p ? { ...p, [k]: v } : p));

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg">
          <KeyRound size={18} /> Mailbox credentials
        </h2>
        <button className="btn-primary btn-sm" onClick={() => setEditing(blank())} disabled={!!lockedError}>
          <Plus size={14} /> Add profile
        </button>
      </div>
      <p className="mb-4 text-xs text-muted">
        SMTP and IMAP combinations reused when creating mailboxes in bulk. Usernames accept{" "}
        <code>{"{prefix}"}</code> and <code>{"{domain}"}</code>, so one profile covers a whole batch
        of domains.
      </p>

      {lockedError ? (
        <div className="flex items-start gap-2 rounded-xl border-2 border-ink bg-sun/30 p-3 text-sm">
          <Lock size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-bold">Credentials are locked</p>
            <p className="mt-1 text-xs">{lockedError}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2 rounded-xl border-2 border-ink bg-canvas p-3 text-xs">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p>
              Passwords are stored in your data store so they can be reused without re-entry. They're
              masked here and excluded from backups, but keep <code>APP_FUNCTION_TOKEN</code> set —
              it's the only thing standing between this table and anyone who learns your function
              URL.
            </p>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {profiles.length === 0 ? (
              <p className="text-sm text-muted">
                No profiles yet. Add one to create mailboxes from the bulk setup page.
              </p>
            ) : null}
            {profiles.map((p) => (
              <div key={p.id} className="rounded-xl border-2 border-ink bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-bold">{p.name || "Untitled profile"}</p>
                    <p className="truncate text-xs text-muted">
                      {p.smtp_host}:{p.smtp_port} → {p.imap_host}:{p.imap_port}
                    </p>
                    {p.iam_user_name ? (
                      <p className="truncate text-[11px] text-muted">IAM: {p.iam_user_name}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-canvas"
                      title="Duplicate"
                      onClick={() => setEditing({ ...p, id: uuid(), name: `${p.name} copy` })}
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-canvas"
                      onClick={() => setEditing(p)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-danger hover:text-white"
                      onClick={() => setDeleting(p)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge tone="white">{p.daily_limit}/day</Badge>
                  <Badge tone="lavender">warmup {p.warmup_limit}</Badge>
                  {p.tracking_domain_prefix ? (
                    <Badge tone="sky">{p.tracking_domain_prefix}.*</Badge>
                  ) : null}
                  <Badge tone={p.smtp_password && p.imap_password ? "mint" : "sun"}>
                    {p.smtp_password && p.imap_password ? "complete" : "missing password"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {editing ? (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={profiles.some((x) => x.id === editing.id) ? "Edit profile" : "Add profile"}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={() => void save(editing)} disabled={!editing.name}>
                Save
              </button>
            </>
          }
        >
          <div className="space-y-3">
            <Field label="Profile name" hint="How it appears in the dropdown">
              <TextField
                value={editing.name}
                onChange={(v) => set("name", v)}
                placeholder="SES us-east-1 + Gmail IMAP"
              />
            </Field>
            <Field label="IAM user name" hint="The AWS user the SMTP credential was created under">
              <TextField value={editing.iam_user_name} onChange={(v) => set("iam_user_name", v)} />
            </Field>

            <p className="pt-1 text-xs font-bold uppercase text-muted">Sending (SMTP)</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="SMTP host">
                <TextField value={editing.smtp_host} onChange={(v) => set("smtp_host", v)} />
              </Field>
              <Field label="SMTP port">
                <NumberField value={editing.smtp_port} onChange={(v) => set("smtp_port", v ?? 0)} />
              </Field>
            </div>
            <Field label="SMTP username" hint="The login — e.g. your SES access key. NOT the mailbox address. For per-mailbox Google use {prefix}@{domain}.">
              <TextField
                value={editing.smtp_username}
                onChange={(v) => set("smtp_username", v)}
                placeholder="AKIA…"
              />
            </Field>
            <Field label="SMTP password">
              <PasswordField
                value={editing.smtp_password}
                onChange={(v) => set("smtp_password", v)}
                placeholder="SES SMTP password"
              />
            </Field>

            <p className="pt-1 text-xs font-bold uppercase text-muted">Receiving (IMAP)</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="IMAP host">
                <TextField value={editing.imap_host} onChange={(v) => set("imap_host", v)} />
              </Field>
              <Field label="IMAP port">
                <NumberField value={editing.imap_port} onChange={(v) => set("imap_port", v ?? 0)} />
              </Field>
            </div>
            <Field label="IMAP username" hint="The IMAP login. A shared inbox uses one address for all; per-mailbox uses {prefix}@{domain}. Not auto-filled from the email.">
              <TextField value={editing.imap_username} onChange={(v) => set("imap_username", v)} />
            </Field>
            <Field label="IMAP password" hint="For Gmail this is an app password">
              <PasswordField value={editing.imap_password} onChange={(v) => set("imap_password", v)} />
            </Field>

            <p className="pt-1 text-xs font-bold uppercase text-muted">Sending behaviour</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Daily limit">
                <NumberField value={editing.daily_limit} onChange={(v) => set("daily_limit", v ?? 0)} />
              </Field>
              <Field
                label="Provider"
                hint="Custom SMTP (SES) uses a different code from Google/Microsoft. If a create fails with a provider error, the bulk-setup log now shows the code Instantly expected."
              >
                <div className="flex gap-2">
                  <SelectField
                    value={String(editing.provider_code)}
                    onChange={(v) => set("provider_code", Number(v))}
                    options={[
                      { value: "1", label: "Custom SMTP / IMAP" },
                      { value: "2", label: "Google Workspace" },
                      { value: "3", label: "Microsoft 365" },
                    ]}
                  />
                  {/* Kept editable: the labels are the common mapping, but the
                      code Instantly actually wants is authoritative and now
                      visible in the create error, so an override must be possible. */}
                  <NumberField value={editing.provider_code} onChange={(v) => set("provider_code", v ?? 0)} />
                </div>
              </Field>
              <Field label="Warmup limit">
                <NumberField value={editing.warmup_limit} onChange={(v) => set("warmup_limit", v ?? 0)} />
              </Field>
              <Field label="Warmup increment">
                <NumberField value={editing.warmup_increment} onChange={(v) => set("warmup_increment", v ?? 0)} />
              </Field>
              <Field label="Warmup reply rate %">
                <NumberField
                  value={editing.warmup_reply_rate}
                  onChange={(v) => set("warmup_reply_rate", v ?? 0)}
                />
              </Field>
              <Field label="Tracking prefix" hint="inst → inst.yourdomain.com">
                <TextField
                  value={editing.tracking_domain_prefix}
                  onChange={(v) => set("tracking_domain_prefix", v)}
                />
              </Field>
            </div>

            <Field label="Notes">
              <TextArea value={editing.notes} onChange={(v) => set("notes", v)} />
            </Field>
          </div>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        title="Delete profile"
        message={`Remove ${deleting?.name}? Mailboxes already created keep working — this only removes the saved credentials.`}
      />
    </Card>
  );
}
