// ---------------------------------------------------------------------------
// Inbox Tester: the ground-truth deliverability workbench.
//
//   1. Seeds  — inboxes we READ over IMAP (Gmail/Outlook/Yahoo…), added with
//               provider-specific setup help.
//   2. Senders — the accounts we SEND from, bulk-connected from Instantly with
//               one shared SMTP detail, or added manually.
//   3. Placement test — send from a sender to the whole seed panel, then see
//               where each landed (Primary / tab / spam / missing).
//   4. Blast  — send a custom body from any selection of senders to one address,
//               for external eyeball testing.
//
// Credentials never touch the client beyond what you type into the forms; the
// send/read/verify all happen server-side. Passwords are write-only here.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MailCheck,
  Plus,
  Trash2,
  ShieldCheck,
  Send,
  RefreshCw,
  Check,
  AlertTriangle,
  X,
  Copy,
  Info,
} from "lucide-react";
import { Card, Badge, Spinner, Details, EmptyState } from "../components/ui/primitives";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/toast";
import { useCollection, useInsert, useUpdate, useRemove } from "../lib/hooks";
import {
  TABLES,
  type SeedInbox,
  type SendInbox,
  type MailProfile,
  type SetupBatch,
  type InboxTest,
  type SendBlast,
  type MailProvider,
} from "../lib/types";
import { instantly, asItems, mailTester } from "../lib/instantly";
import { PROVIDER_ORDER, presetFor, guessProvider } from "../lib/mailProviders";
import { identifyConnected, type IdentifiedInbox } from "../lib/sendConnect";
import { rollupHealth } from "../lib/inboxPlacement";
import { fmtDateShort } from "../lib/format";
import { cn } from "../lib/utils";

const FOLDER_TONE: Record<string, "mint" | "sky" | "danger" | "white"> = {
  primary: "mint",
  tab: "sky",
  spam: "danger",
  missing: "white",
};
const CONN_TONE: Record<string, "mint" | "danger" | "sun" | "white"> = {
  ok: "mint",
  connected: "mint",
  failed: "danger",
  available: "sun",
  unknown: "white",
  none: "white",
};

function copy(text: string, toast: ReturnType<typeof useToast>) {
  void navigator.clipboard?.writeText(text);
  toast.push("Copied", "success");
}

export default function InboxTester() {
  const toast = useToast();
  const qc = useQueryClient();

  const seedsQ = useCollection<SeedInbox>(TABLES.seedInboxes, { retry: false });
  const sendsQ = useCollection<SendInbox>(TABLES.sendInboxes, { retry: false });
  const profilesQ = useCollection<MailProfile>(TABLES.mailProfiles, { retry: false });
  const batchesQ = useCollection<SetupBatch>(TABLES.setupBatches);
  const testsQ = useCollection<InboxTest>(TABLES.inboxTests);
  const blastsQ = useCollection<SendBlast>(TABLES.sendBlasts);

  const seeds = seedsQ.data ?? [];
  const sends = sendsQ.data ?? [];
  const profiles = profilesQ.data ?? [];
  const batches = batchesQ.data ?? [];
  const tests = testsQ.data ?? [];
  const blasts = blastsQ.data ?? [];

  const insertSeed = useInsert<SeedInbox>(TABLES.seedInboxes);
  const updateSeed = useUpdate<SeedInbox>(TABLES.seedInboxes);
  const removeSeed = useRemove(TABLES.seedInboxes);
  const insertSend = useInsert<SendInbox>(TABLES.sendInboxes);
  const updateSend = useUpdate<SendInbox>(TABLES.sendInboxes);
  const removeSend = useRemove(TABLES.sendInboxes);
  const insertProfile = useInsert<MailProfile>(TABLES.mailProfiles);

  // Live polling while any test or blast is in flight.
  const anyActive =
    tests.some((t) => t.status === "queued" || t.status === "sending" || t.status === "reading") ||
    blasts.some((b) => b.status === "queued" || b.status === "sending");
  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(() => {
      qc.invalidateQueries({ queryKey: [TABLES.inboxTests] });
      qc.invalidateQueries({ queryKey: [TABLES.sendBlasts] });
      qc.invalidateQueries({ queryKey: [TABLES.seedInboxes] });
      qc.invalidateQueries({ queryKey: [TABLES.sendInboxes] });
    }, 5000);
    return () => clearInterval(id);
  }, [anyActive, qc]);

  const secretsLocked = seedsQ.isError || sendsQ.isError;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-extrabold">
          <MailCheck size={24} /> Inbox Tester
        </h1>
        <span className="text-sm text-muted">Send from your inboxes to a seed panel and see where it lands.</span>
      </div>

      {secretsLocked ? (
        <Card className="flex items-start gap-2 border-ink bg-sun/30 p-3 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            Credential storage is locked. Set <code>APP_FUNCTION_TOKEN</code> in Netlify (and{" "}
            <code>VITE_APP_TOKEN</code> to the same value) so seed/sender passwords can be saved — without it this
            table is readable by anyone with the URL, so it stays disabled.
          </span>
        </Card>
      ) : null}

      <SeedsSection
        seeds={seeds}
        loading={seedsQ.isLoading}
        onAdd={(row) => insertSeed.mutateAsync(row)}
        onDelete={(id) => removeSeed.mutateAsync(id)}
        toast={toast}
        qc={qc}
      />

      <SendersSection
        sends={sends}
        profiles={profiles}
        batches={batches}
        onConnect={async (emails, profileId) => {
          for (const email of emails) {
            const existing = sends.find((s) => s.email.toLowerCase() === email);
            if (existing) await updateSend.mutateAsync({ id: existing.id, patch: { profile_id: profileId, connected: "unknown", last_error: "" } });
            else await insertSend.mutateAsync({ email, source: "instantly", profile_id: profileId, connected: "unknown" });
          }
        }}
        onManualAdd={(row) => insertSend.mutateAsync(row)}
        onCreateProfile={(row) => insertProfile.mutateAsync(row)}
        onDelete={(id) => removeSend.mutateAsync(id)}
        toast={toast}
        qc={qc}
      />

      <PlacementSection sends={sends} tests={tests} toast={toast} />

      <BlastSection sends={sends} blasts={blasts} toast={toast} />
    </div>
  );
}

// =========================================================================
// 1. Seeds
// =========================================================================
function SeedsSection({
  seeds,
  loading,
  onAdd,
  onDelete,
  toast,
  qc,
}: {
  seeds: SeedInbox[];
  loading: boolean;
  onAdd: (row: Partial<SeedInbox>) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  toast: ReturnType<typeof useToast>;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [open, setOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [provider, setProvider] = useState<MailProvider>("gmail");
  const [email, setEmail] = useState("");
  const [host, setHost] = useState(presetFor("gmail").imapHost);
  const [port, setPort] = useState(presetFor("gmail").imapPort);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const preset = presetFor(provider);

  function pickProvider(p: MailProvider) {
    setProvider(p);
    setHost(presetFor(p).imapHost);
    setPort(presetFor(p).imapPort);
  }

  async function add() {
    const e = email.trim().toLowerCase();
    if (!e || !host || !password) {
      toast.push("Email, IMAP host and password are required", "error");
      return;
    }
    await onAdd({
      provider,
      email: e,
      imap_host: host,
      imap_port: port,
      imap_secure: port === 993,
      imap_user: user.trim() || e,
      imap_password: password,
      active: true,
      connected: "unknown",
    });
    setEmail("");
    setUser("");
    setPassword("");
    setOpen(false);
    toast.push("Seed added — Verify it to confirm the login", "success");
  }

  async function verifyAll() {
    if (seeds.length === 0) return;
    setVerifying(true);
    const r = await mailTester.verify({ seedIds: seeds.map((s) => s.id) });
    setVerifying(false);
    qc.invalidateQueries({ queryKey: [TABLES.seedInboxes] });
    if (!r.ok) toast.push(`Verify failed: ${r.error}`, "error");
    else toast.push("Verified — see each seed's status", "success");
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-extrabold">1 · Seed inboxes</h2>
        <Badge tone="white">{seeds.length}</Badge>
        <span className="text-xs text-muted">The panel we read to see where your mail lands.</span>
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost btn-sm" onClick={() => void verifyAll()} disabled={verifying || seeds.length === 0}>
            {verifying ? <Spinner /> : <ShieldCheck size={14} />} Verify all
          </button>
          <button className="btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={14} /> Add seed
          </button>
        </div>
      </div>

      {loading ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted"><Spinner /> Loading…</p>
      ) : seeds.length === 0 ? (
        <EmptyState title="No seed inboxes yet" description="Add a few dedicated Gmail/Outlook/Yahoo accounts to read placement from." />
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                <th className="px-3 py-2">Seed</th>
                <th className="px-3 py-2">Provider</th>
                <th className="px-3 py-2">IMAP</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {seeds.map((s) => (
                <tr key={s.id} className="border-b border-ink/10">
                  <td className="px-3 py-2 font-semibold">{s.email}</td>
                  <td className="px-3 py-2 text-xs">{presetFor(s.provider).label}</td>
                  <td className="px-3 py-2 text-xs text-muted">{s.imap_host}:{s.imap_port}</td>
                  <td className="px-3 py-2">
                    <span title={s.last_error || undefined}>
                      <Badge tone={CONN_TONE[s.connected] ?? "white"}>{s.connected}</Badge>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button className="btn-ghost btn-sm" onClick={() => void onDelete(s.id)} title="Remove seed">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a seed inbox"
        size="lg"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={() => void add()}>
              <Plus size={14} /> Add seed
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="text-xs font-bold uppercase text-muted">Provider</span>
            <select
              className="input mt-1 w-full"
              value={provider}
              onChange={(e) => pickProvider(e.target.value as MailProvider)}
            >
              {PROVIDER_ORDER.map((p) => (
                <option key={p} value={p}>{presetFor(p).label}</option>
              ))}
            </select>
          </label>

          <div className="rounded-lg border-2 border-ink bg-canvas p-3 text-xs">
            <p className="flex items-center gap-1 font-bold"><Info size={13} /> How to get the app password</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4">
              {preset.steps.map((step, i) => <li key={i}>{step}</li>)}
            </ol>
            {preset.appPasswordUrl ? (
              <a href={preset.appPasswordUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block font-bold underline">
                Open app-password page →
              </a>
            ) : null}
            {preset.caveat ? <p className="mt-1 text-danger">{preset.caveat}</p> : null}
          </div>

          <label className="block">
            <span className="text-xs font-bold uppercase text-muted">Email</span>
            <input
              className="input mt-1 w-full"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (provider === "gmail") { const g = guessProvider(e.target.value); if (g !== "other") pickProvider(g); }
              }}
              placeholder="seed@gmail.com"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-bold uppercase text-muted">IMAP host</span>
              <input className="input mt-1 w-full" value={host} onChange={(e) => setHost(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase text-muted">IMAP port</span>
              <input className="input mt-1 w-full" type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 993)} />
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-bold uppercase text-muted">Username (blank = email)</span>
            <input className="input mt-1 w-full" value={user} onChange={(e) => setUser(e.target.value)} placeholder={email || "seed@gmail.com"} />
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase text-muted">App password</span>
            <input className="input mt-1 w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="write-only — stored server-side" />
          </label>
        </div>
      </Modal>
    </Card>
  );
}

// =========================================================================
// 2. Senders (bulk connect from Instantly)
// =========================================================================
function SendersSection({
  sends,
  profiles,
  batches,
  onConnect,
  onManualAdd,
  onCreateProfile,
  onDelete,
  toast,
  qc,
}: {
  sends: SendInbox[];
  profiles: MailProfile[];
  batches: SetupBatch[];
  onConnect: (emails: string[], profileId: string) => Promise<unknown>;
  onManualAdd: (row: Partial<SendInbox>) => Promise<unknown>;
  onCreateProfile: (row: Partial<MailProfile>) => Promise<MailProfile>;
  onDelete: (id: string) => Promise<unknown>;
  toast: ReturnType<typeof useToast>;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [connectOpen, setConnectOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [filter, setFilter] = useState("");

  async function fetchFromInstantly() {
    setFetching(true);
    const res = await instantly.accounts();
    setFetching(false);
    if (!res.ok) {
      toast.push(`Couldn't fetch accounts: ${res.error}`, "error");
      return;
    }
    const emails = asItems<Record<string, unknown>>(res.data)
      .map((a) => String(a.email ?? "").trim().toLowerCase())
      .filter(Boolean)
      .sort();
    setFetched([...new Set(emails)]);
    toast.push(`Fetched ${emails.length} accounts from Instantly`, "success");
  }

  const identified: IdentifiedInbox[] = useMemo(
    () => (fetched ? identifyConnected(fetched, sends, profiles, batches) : []),
    [fetched, sends, profiles, batches],
  );
  const shown = identified.filter((i) => !filter || i.email.includes(filter.toLowerCase()));

  function toggle(email: string) {
    setSelected((s) => { const n = new Set(s); n.has(email) ? n.delete(email) : n.add(email); return n; });
  }
  function selectAllShown() {
    setSelected(new Set(shown.map((i) => i.email)));
  }

  async function verifySelectedSends() {
    const ids = sends.filter((s) => selected.has(s.email.toLowerCase())).map((s) => s.id);
    if (ids.length === 0) { toast.push("Select connected senders to verify", "info"); return; }
    setVerifying(true);
    // Verify in chunks of 25 (the server caps per call).
    for (let i = 0; i < ids.length; i += 25) {
      await mailTester.verify({ sendIds: ids.slice(i, i + 25) });
      qc.invalidateQueries({ queryKey: [TABLES.sendInboxes] });
    }
    setVerifying(false);
    toast.push("Verified — see each sender's status", "success");
  }

  const connectedCount = sends.filter((s) => s.connected === "ok").length;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-extrabold">2 · Sending inboxes</h2>
        <Badge tone="white">{sends.length} on file</Badge>
        <Badge tone={connectedCount > 0 ? "mint" : "white"}>{connectedCount} connected</Badge>
        <span className="text-xs text-muted">The accounts under test — send from these.</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button className="btn-ghost btn-sm" onClick={() => void fetchFromInstantly()} disabled={fetching}>
            {fetching ? <Spinner /> : <RefreshCw size={14} />} Fetch from Instantly
          </button>
          <button className="btn-ghost btn-sm" onClick={() => void verifySelectedSends()} disabled={verifying || selected.size === 0}>
            {verifying ? <Spinner /> : <ShieldCheck size={14} />} Verify selected
          </button>
          <button className="btn-primary btn-sm" onClick={() => setConnectOpen(true)} disabled={selected.size === 0}>
            <Check size={14} /> Connect selected ({selected.size})
          </button>
        </div>
      </div>

      {fetched === null ? (
        <EmptyState title="Fetch your accounts" description="Pull every inbox from Instantly, pick the ones to test, and connect them with one SMTP detail." />
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input className="input w-56" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button className="btn-ghost btn-sm" onClick={selectAllShown}>Select all ({shown.length})</button>
            <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
          <div className="mt-2 max-h-80 overflow-auto rounded-lg border-2 border-ink">
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
              <thead className="sticky top-0">
                <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                  <th className="w-10 px-3 py-2"></th>
                  <th className="px-3 py-2">Inbox</th>
                  <th className="px-3 py-2">State</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.email} className="border-b border-ink/10">
                    <td className="px-3 py-2">
                      <input type="checkbox" className="h-4 w-4 accent-ink" checked={selected.has(i.email)} onChange={() => toggle(i.email)} />
                    </td>
                    <td className="px-3 py-2 font-semibold">{i.email}</td>
                    <td className="px-3 py-2">
                      <span title={i.error || undefined}>
                        <Badge tone={CONN_TONE[i.status] ?? "white"}>{i.status}</Badge>
                      </span>
                      {i.via ? <span className="ml-1 text-[11px] text-muted">via {i.via === "send_inbox" ? "saved" : "setup profile"}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ConnectModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        count={selected.size}
        profiles={profiles}
        onConfirm={async (profileId) => {
          await onConnect([...selected], profileId);
          setConnectOpen(false);
          setSelected(new Set());
          toast.push("Connected — Verify them to confirm the SMTP login", "success");
        }}
        onCreateProfile={onCreateProfile}
        toast={toast}
      />
    </Card>
  );
}

function ConnectModal({
  open,
  onClose,
  count,
  profiles,
  onConfirm,
  onCreateProfile,
  toast,
}: {
  open: boolean;
  onClose: () => void;
  count: number;
  profiles: MailProfile[];
  onConfirm: (profileId: string) => Promise<void>;
  onCreateProfile: (row: Partial<MailProfile>) => Promise<MailProfile>;
  toast: ReturnType<typeof useToast>;
}) {
  const [mode, setMode] = useState<"existing" | "new">(profiles.length > 0 ? "existing" : "new");
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  // New-profile fields (one SMTP detail for all selected).
  const [name, setName] = useState("Inbox tester SMTP");
  const [host, setHost] = useState("email-smtp.us-east-1.amazonaws.com");
  const [port, setPort] = useState(465);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function confirm() {
    setBusy(true);
    try {
      let pid = profileId;
      if (mode === "new") {
        if (!host || !username || !password) { toast.push("SMTP host, username and password are required", "error"); setBusy(false); return; }
        const created = await onCreateProfile({
          name,
          smtp_host: host,
          smtp_port: port,
          smtp_username: username,
          smtp_password: password,
          // Unused-by-the-tester fields, kept valid.
          iam_user_name: "",
          imap_username: "",
          imap_password: "",
          imap_host: "",
          imap_port: 993,
          provider_code: 0,
          daily_limit: 0,
          warmup_limit: 0,
          warmup_increment: 0,
          warmup_reply_rate: 0,
          tracking_domain_prefix: "",
          notes: "Created by Inbox Tester bulk connect",
        });
        pid = created.id;
      }
      if (!pid) { toast.push("Pick or create a profile", "error"); setBusy(false); return; }
      await onConfirm(pid);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`Connect ${count} inbox${count === 1 ? "" : "es"} to SMTP`}
      size="md"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void confirm()} disabled={busy}>
            {busy ? <Spinner /> : <Check size={14} />} Connect
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted">
          One SMTP credential connects all selected inboxes. For an SES setup the username is your SES SMTP key and the
          <b> from</b> is each mailbox; for per-mailbox logins use a username template like <code>{"{email}"}</code>.
        </p>
        {profiles.length > 0 ? (
          <div className="flex gap-2 text-xs">
            <button className={cn("btn-sm", mode === "existing" ? "btn-primary" : "btn-ghost")} onClick={() => setMode("existing")}>Use a saved profile</button>
            <button className={cn("btn-sm", mode === "new" ? "btn-primary" : "btn-ghost")} onClick={() => setMode("new")}>New SMTP detail</button>
          </div>
        ) : null}

        {mode === "existing" && profiles.length > 0 ? (
          <label className="block">
            <span className="text-xs font-bold uppercase text-muted">Mail profile</span>
            <select className="input mt-1 w-full" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.smtp_host}</option>)}
            </select>
          </label>
        ) : (
          <div className="space-y-2">
            <label className="block">
              <span className="text-xs font-bold uppercase text-muted">Name</span>
              <input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-xs font-bold uppercase text-muted">SMTP host</span>
                <input className="input mt-1 w-full" value={host} onChange={(e) => setHost(e.target.value)} />
              </label>
              <label className="block">
                <span className="text-xs font-bold uppercase text-muted">Port</span>
                <input className="input mt-1 w-full" type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 465)} />
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-bold uppercase text-muted">SMTP username (or {"{email}"} template)</span>
              <input className="input mt-1 w-full" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="AKIA… or {email}" />
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase text-muted">SMTP password</span>
              <input className="input mt-1 w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="write-only — stored server-side" />
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}

// =========================================================================
// 3. Placement test
// =========================================================================
function PlacementSection({ sends, tests, toast }: { sends: SendInbox[]; tests: InboxTest[]; toast: ReturnType<typeof useToast> }) {
  const connected = sends.filter((s) => s.connected === "ok" || s.connected === "unknown");
  const [mailbox, setMailbox] = useState("");
  const [starting, setStarting] = useState(false);
  const active = mailbox || connected[0]?.email || "";

  const forMailbox = useMemo(
    () => tests.filter((t) => t.mailbox === active).sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? "")),
    [tests, active],
  );
  const latest = forMailbox[0];
  const roll = useMemo(() => rollupHealth(forMailbox), [forMailbox]);

  async function testNow() {
    if (!active) { toast.push("Connect a sending inbox first", "error"); return; }
    setStarting(true);
    const r = await mailTester.testNow(active);
    setStarting(false);
    if (!r.ok) toast.push(`Couldn't start: ${r.error}`, "error");
    else toast.push("Test sent to the seed panel — reading placement after the wait", "success");
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-extrabold">3 · Placement test</h2>
        <span className="text-xs text-muted">Send to every seed, then see where it landed.</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select className="input" value={active} onChange={(e) => setMailbox(e.target.value)}>
            {connected.length === 0 ? <option value="">— connect a sender first —</option> : null}
            {connected.map((s) => <option key={s.id} value={s.email}>{s.email}</option>)}
          </select>
          <button className="btn-primary btn-sm" onClick={() => void testNow()} disabled={starting || !active}>
            {starting ? <Spinner /> : <Send size={14} />} Test now
          </button>
        </div>
      </div>

      {roll.primaryRate !== null ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={roll.band === "good" ? "mint" : roll.band === "watch" ? "sky" : roll.band === "warn" ? "sun" : "danger"}>
            {roll.primaryRate}% primary
          </Badge>
          <span className="text-muted">across {roll.samples} test{roll.samples === 1 ? "" : "s"}{roll.provisional ? " (provisional)" : ""}</span>
        </div>
      ) : null}

      {latest ? (
        <div className="mt-3 rounded-lg border-2 border-ink p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-bold">{fmtDateShort(latest.started_at)}</span>
            {latest.status === "done" && latest.summary ? (
              <>
                <Badge tone="mint">{latest.summary.primaryRate}% primary</Badge>
                <Badge tone="sky">{latest.summary.tabRate}% tab</Badge>
                <Badge tone="danger">{latest.summary.spamRate}% spam</Badge>
                <span className="text-muted">score {latest.summary.placementScore}</span>
              </>
            ) : latest.status === "failed" ? (
              <Badge tone="danger">failed</Badge>
            ) : (
              <span className="flex items-center gap-1 text-muted"><Spinner /> {latest.status === "reading" ? "waiting to read the seeds…" : latest.status}</span>
            )}
          </div>
          {latest.error ? <p className="mt-1 text-xs text-danger">{latest.error}</p> : null}
          {latest.results.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {latest.results.map((r) => (
                <span key={r.seed} className="inline-flex items-center gap-1 rounded border border-ink/20 bg-white px-1.5 py-0.5 text-[11px]" title={r.auth ? `spf ${r.auth.spf ?? "?"} · dkim ${r.auth.dkim ?? "?"} · dmarc ${r.auth.dmarc ?? "?"}` : undefined}>
                  <Badge tone={FOLDER_TONE[r.folder] ?? "white"}>{r.folder}</Badge>
                  <span className="font-mono">{r.seed}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState title="No tests yet" description="Pick a connected sender and hit Test now." />
      )}
    </Card>
  );
}

// =========================================================================
// 4. Custom blast
// =========================================================================
function BlastSection({ sends, blasts, toast }: { sends: SendInbox[]; blasts: SendBlast[]; toast: ReturnType<typeof useToast> }) {
  const connected = sends.filter((s) => s.connected === "ok" || s.connected === "unknown");
  const [target, setTarget] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  const latest = [...blasts].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0];

  function toggle(email: string) {
    setChosen((s) => { const n = new Set(s); n.has(email) ? n.delete(email) : n.add(email); return n; });
  }

  async function send() {
    const from = chosen.size > 0 ? [...chosen] : connected.map((s) => s.email);
    if (!target.trim() || !subject.trim() || from.length === 0) {
      toast.push("Target, subject and at least one sender are required", "error");
      return;
    }
    setSending(true);
    const r = await mailTester.blast({ target: target.trim(), subject: subject.trim(), body, fromEmails: from });
    setSending(false);
    if (!r.ok) toast.push(`Couldn't start blast: ${r.error}`, "error");
    else toast.push(`Blasting from ${from.length} inbox${from.length === 1 ? "" : "es"} to ${target}`, "success");
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-extrabold">4 · Custom blast</h2>
        <span className="text-xs text-muted">Send a custom email from your inboxes to one address you can check yourself.</span>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs font-bold uppercase text-muted">Send to (any address)</span>
            <input className="input mt-1 w-full" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="you@gmail.com" />
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase text-muted">Subject</span>
            <input className="input mt-1 w-full" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase text-muted">Body</span>
            <textarea className="input mt-1 h-28 w-full" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Your test message…" />
          </label>
          <button className="btn-primary btn-sm" onClick={() => void send()} disabled={sending}>
            {sending ? <Spinner /> : <Send size={14} />} Send from {chosen.size > 0 ? `${chosen.size} selected` : `all ${connected.length}`}
          </button>
        </div>

        <div>
          <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="font-bold uppercase text-muted">Senders</span>
            <button className="btn-ghost btn-sm" onClick={() => setChosen(new Set(connected.map((s) => s.email)))}>All</button>
            <button className="btn-ghost btn-sm" onClick={() => setChosen(new Set())}>None (=all)</button>
          </div>
          <div className="max-h-52 overflow-auto rounded-lg border-2 border-ink">
            {connected.length === 0 ? (
              <p className="p-3 text-xs text-muted">No connected senders yet.</p>
            ) : (
              connected.map((s) => (
                <label key={s.id} className="flex items-center gap-2 border-b border-ink/10 px-3 py-1.5 text-sm last:border-0">
                  <input type="checkbox" className="h-4 w-4 accent-ink" checked={chosen.has(s.email)} onChange={() => toggle(s.email)} />
                  <span className="font-mono text-xs">{s.email}</span>
                </label>
              ))
            )}
          </div>
        </div>
      </div>

      {latest ? (
        <div className="mt-3 rounded-lg border-2 border-ink p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold">{fmtDateShort(latest.started_at)} → {latest.target}</span>
            <Badge tone={latest.status === "done" ? "mint" : "sun"}>{latest.status}</Badge>
            <span className="text-muted">
              {latest.results.filter((r) => r.outcome === "sent").length}/{latest.from_emails.length} sent
            </span>
            <button className="btn-ghost btn-sm ml-auto" onClick={() => copy(latest.results.map((r) => `${r.email}: ${r.outcome}${r.error ? " — " + r.error : ""}`).join("\n"), toast)}>
              <Copy size={12} /> Copy results
            </button>
          </div>
          {latest.results.length > 0 ? (
            <Details summary={`Per-inbox results (${latest.results.length})`}>
              <ul className="space-y-0.5 text-[11px]">
                {latest.results.map((r, i) => (
                  <li key={i} className="flex items-center gap-1">
                    {r.outcome === "sent" ? <Check size={11} className="text-mint" /> : r.outcome === "failed" ? <X size={11} className="text-danger" /> : <AlertTriangle size={11} className="text-sun-dark" />}
                    <span className="font-mono">{r.email}</span>
                    <span className="text-muted">{r.outcome}{r.error ? ` — ${r.error}` : ""}</span>
                  </li>
                ))}
              </ul>
            </Details>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
