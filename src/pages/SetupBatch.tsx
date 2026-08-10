// ---------------------------------------------------------------------------
// Bulk domain setup: paste a batch of domains, paste the DKIM tokens SES gives
// you, get importable Cloudflare zone files, Domains rows and Instantly
// mailboxes.
//
// The record pattern is reproduced from the live zones — see dnsPlan.ts. The
// only things this page cannot derive are the SES DKIM tokens and the Netlify
// site per domain, so both are inputs and neither is ever guessed.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Layers,
  Download,
  Copy,
  Check,
  AlertTriangle,
  Plus,
  X,
  Zap,
  Eye,
  KeyRound,
  ClipboardList,
} from "lucide-react";
import { Card, Badge, StatCard, Toggle, Spinner } from "../components/ui/primitives";
import { Field, TextField, SelectField } from "../components/ui/Field";
import { useToast } from "../components/ui/toast";
import { useCollection, useInsertMany, useSettings } from "../lib/hooks";
import { Domain, MailProfile, TABLES } from "../lib/types";
import {
  DKIM_TOKEN_COUNT,
  checklistFor,
  csvFor,
  defaultBatchConfig,
  mailboxesFor,
  parseDkimTokens,
  parseDomains,
  recordsFor,
  spfValue,
  statusFor,
  trackingDomainFor,
  zoneBundle,
  zoneFileFor,
  type BatchConfig,
  type DomainSpec,
} from "../lib/dnsPlan";
import { instantly } from "../lib/instantly";
import { download, uuid } from "../lib/utils";
import { cn } from "../lib/utils";

const PREFIX_CHIPS = ["tanuj", "tanuj.s", "t.singh", "hello", "hi", "team", "info"];

/** Per-domain overrides. Absent keys fall back to the batch defaults. */
interface Override {
  prefixes?: string[];
  dkimText?: string;
  netlifySite?: string;
}

function expand(tpl: string, prefix: string, domain: string): string {
  return tpl.replace(/\{prefix\}/g, prefix).replace(/\{domain\}/g, domain);
}

export default function SetupBatch() {
  const toast = useToast();
  const { data: settings } = useSettings();
  const { data: existingDomains = [] } = useCollection<Domain>(TABLES.domains);
  const profilesQ = useCollection<MailProfile>(TABLES.mailProfiles);
  const insertDomains = useInsertMany<Domain>(TABLES.domains);

  const [config, setConfig] = useState<BatchConfig>(defaultBatchConfig);
  const [domainsText, setDomainsText] = useState("");
  const [defaultPrefixes, setDefaultPrefixes] = useState<string[]>(["tanuj", "tanuj.s"]);
  const [newPrefix, setNewPrefix] = useState("");
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [profileId, setProfileId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createLog, setCreateLog] = useState<string[]>([]);

  const setCfg = <K extends keyof BatchConfig>(k: K, v: BatchConfig[K]) =>
    setConfig((c) => ({ ...c, [k]: v }));
  const setOverride = (domain: string, patch: Override) =>
    setOverrides((o) => ({ ...o, [domain]: { ...o[domain], ...patch } }));

  const domains = useMemo(() => parseDomains(domainsText), [domainsText]);

  const specs: DomainSpec[] = useMemo(
    () =>
      domains.map((domain) => {
        const o = overrides[domain] ?? {};
        return {
          domain,
          prefixes: o.prefixes ?? defaultPrefixes,
          dkimTokens: parseDkimTokens(o.dkimText ?? ""),
          netlifySite: o.netlifySite ?? "",
        };
      }),
    [domains, overrides, defaultPrefixes],
  );

  const statuses = useMemo(() => specs.map((s) => statusFor(s, config)), [specs, config]);
  const readyCount = statuses.filter((s) => s.dkimComplete).length;
  const totalMailboxes = specs.reduce((n, s) => n + mailboxesFor(s).length, 0);
  const profiles = profilesQ.data ?? [];
  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const profilesLocked =
    profilesQ.error instanceof Error && /APP_FUNCTION_TOKEN/i.test(profilesQ.error.message);

  const knownDomains = useMemo(
    () => new Set(existingDomains.map((d) => (d.domain_name ?? "").trim().toLowerCase())),
    [existingDomains],
  );

  function copy(text: string, label: string) {
    void navigator.clipboard?.writeText(text);
    toast.push(`${label} copied`, "success");
  }

  function addPrefix(p: string) {
    const v = p.trim().toLowerCase();
    if (!v || defaultPrefixes.includes(v)) return;
    setDefaultPrefixes((s) => [...s, v]);
    setNewPrefix("");
  }

  /** Write the batch into the Domains table so it joins the rest of the app. */
  async function createDomainRows() {
    const fresh = specs.filter((s) => !knownDomains.has(s.domain));
    if (fresh.length === 0) {
      toast.push("Every domain in this batch is already in your Domains list", "info");
      return;
    }
    const base = existingDomains.length;
    const rows: Partial<Domain>[] = fresh.map((s, i) => {
      const boxes = mailboxesFor(s);
      return {
        id: uuid(),
        position: base + i + 1,
        domain_name: s.domain,
        email_1: boxes[0] ?? "",
        email_2: boxes[1] ?? "",
        expiry_date: null,
        expiry_source: "manual",
        expiry_checked_at: null,
        domain_provider: "IONOS",
        mailing_server: "Amazon SES",
        mailing_status: s.dkimTokens.length === DKIM_TOKEN_COUNT ? "Partially" : "",
        dns_provider: "Cloudflare",
        dns_status: "",
        email_forward: "Cloudflare",
        hosting_provider: "Netlify",
        hosting_account: "",
        website_note: s.netlifySite ? `${s.netlifySite}.netlify.app` : "",
        emails_forwarded_to: config.forwardTo,
        campaign_id: null,
        campaign_label: "",
        gravatar: "",
        gmail_send_configured: "",
        connected_to_instantly: "",
        warmup_started: "",
        mailbox_daily_limit: null,
        renewal_cost: 12,
        notes: `Created from bulk setup. Tracking: ${trackingDomainFor(s, config)}`,
        custom: {},
      };
    });
    await insertDomains.mutateAsync(rows);
    toast.push(`Added ${rows.length} domain${rows.length === 1 ? "" : "s"}`, "success");
  }

  /**
   * Create every mailbox in the batch. Dry run shows the exact payloads
   * without sending them; the real run reports per mailbox so a partial
   * failure is visible rather than hidden behind one summary line.
   */
  async function createMailboxes(dryRun: boolean) {
    if (!profile) {
      toast.push("Pick a credential profile first", "error");
      return;
    }
    setCreating(true);
    setCreateLog([]);
    const log: string[] = [];

    for (const spec of specs) {
      for (const prefix of spec.prefixes) {
        const email = `${prefix}@${spec.domain}`;
        const res = await instantly.createAccount(
          {
            email,
            first_name: prefix.split(/[._-]/)[0] ?? prefix,
            last_name: "",
            provider_code: profile.provider_code,
            smtp_username: profile.smtp_username
              ? expand(profile.smtp_username, prefix, spec.domain)
              : email,
            smtp_password: profile.smtp_password,
            smtp_host: profile.smtp_host,
            smtp_port: profile.smtp_port,
            imap_username: profile.imap_username
              ? expand(profile.imap_username, prefix, spec.domain)
              : email,
            imap_password: profile.imap_password,
            imap_host: profile.imap_host,
            imap_port: profile.imap_port,
            daily_limit: profile.daily_limit,
            warmup_limit: profile.warmup_limit,
            warmup_increment: profile.warmup_increment,
            warmup_reply_rate: profile.warmup_reply_rate,
            tracking_domain_name: trackingDomainFor(spec, config),
          },
          dryRun,
        );
        log.push(
          res.ok
            ? dryRun
              ? `would create ${email}`
              : `created ${email}`
            : `FAILED ${email} — ${res.error}`,
        );
        setCreateLog([...log]);
        if (res.writesDisabled) {
          log.push("Stopped: writes are disabled.");
          setCreateLog([...log]);
          setCreating(false);
          return;
        }
      }
    }
    setCreating(false);
    const failed = log.filter((l) => l.startsWith("FAILED")).length;
    toast.push(
      failed === 0
        ? dryRun
          ? `${log.length} mailboxes ready to create`
          : `Created ${log.length} mailboxes`
        : `${failed} of ${log.length} failed — see the log`,
      failed === 0 ? "success" : "error",
    );
  }

  const checklist = useMemo(() => checklistFor(specs, config), [specs, config]);
  const emailsPerDomain = settings?.emails_per_domain ?? 2;

  return (
    <div className="space-y-6">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border-2 border-ink bg-lime shadow-hard-sm">
            <Layers size={18} />
          </span>
          <div>
            <h2 className="text-lg leading-none">Bulk domain setup</h2>
            <p className="text-xs text-muted">
              Domains in, Cloudflare zone files and Instantly mailboxes out
            </p>
          </div>
        </div>
        <Link to="/domains" className="btn-ghost btn-sm">
          Domains
        </Link>
      </Card>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Domains" value={domains.length} sublabel="in this batch" icon={<Layers size={18} />} />
        <StatCard
          label="DKIM complete"
          value={`${readyCount}/${domains.length || 0}`}
          sublabel={readyCount === domains.length && domains.length > 0 ? "all ready" : "paste from SES"}
          tone={domains.length > 0 && readyCount === domains.length ? "mint" : "sun"}
        />
        <StatCard label="Mailboxes" value={totalMailboxes} sublabel={`${emailsPerDomain}/domain suggested`} tone="sky" />
        <StatCard
          label="New to your list"
          value={specs.filter((s) => !knownDomains.has(s.domain)).length}
          sublabel="not yet in Domains"
          tone="lavender"
        />
      </div>

      {/* 1. The batch */}
      <Card className="p-5">
        <h3 className="mb-1 text-lg">1. The batch</h3>
        <p className="mb-3 text-xs text-muted">
          Paste your domains one per line. Protocols, <code>www.</code> and trailing slashes are
          stripped, and duplicates are dropped.
        </p>
        <textarea
          className="input min-h-[120px] font-mono text-sm"
          value={domainsText}
          onChange={(e) => setDomainsText(e.target.value)}
          placeholder={"aeoagency.cloud\naeoagency.online\n…"}
        />

        <p className="mt-4 label">Default mailbox prefixes</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {defaultPrefixes.map((p) => (
            <span key={p} className="chip flex items-center gap-1">
              {p}
              <button
                onClick={() => setDefaultPrefixes((s) => s.filter((x) => x !== p))}
                title={`Remove ${p}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <input
            className="input h-8 w-32"
            value={newPrefix}
            placeholder="add prefix"
            onChange={(e) => setNewPrefix(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addPrefix(newPrefix);
              }
            }}
          />
          <button className="btn-ghost btn-sm" onClick={() => addPrefix(newPrefix)} disabled={!newPrefix.trim()}>
            <Plus size={13} /> Add
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {PREFIX_CHIPS.filter((c) => !defaultPrefixes.includes(c)).map((c) => (
            <button key={c} className="chip hover:bg-lime" onClick={() => addPrefix(c)}>
              + {c}
            </button>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Forward replies to" hint="Cloudflare Email Routing destination">
            <TextField
              value={config.forwardTo}
              onChange={(v) => setCfg("forwardTo", v)}
              placeholder="you@gmail.com"
            />
          </Field>
          <Field label="DMARC reports to">
            <TextField
              value={config.dmarcReportTo}
              onChange={(v) => setCfg("dmarcReportTo", v)}
              placeholder="you@gmail.com"
            />
          </Field>
          <Field label="DMARC policy">
            <SelectField
              value={config.dmarcPolicy}
              onChange={(v) => setCfg("dmarcPolicy", v as BatchConfig["dmarcPolicy"])}
              options={[
                { value: "none", label: "none (monitor only)" },
                { value: "quarantine", label: "quarantine" },
                { value: "reject", label: "reject" },
              ]}
            />
          </Field>
          <Field label="Tracking prefix" hint="inst → inst.yourdomain.com">
            <TextField value={config.trackingPrefix} onChange={(v) => setCfg("trackingPrefix", v)} />
          </Field>
          <Field label="Tracking target">
            <TextField value={config.trackingTarget} onChange={(v) => setCfg("trackingTarget", v)} />
          </Field>
          <Field label="Apex target">
            <TextField value={config.apexTarget} onChange={(v) => setCfg("apexTarget", v)} />
          </Field>
        </div>

        <div className="mt-3 space-y-2">
          <Toggle
            checked={config.includeSes}
            onChange={(v) => setCfg("includeSes", v)}
            label="Authorise Amazon SES in SPF"
          />
          <p className="text-xs text-muted">
            <code>{spfValue(config)}</code>
            {config.includeSes ? (
              <>
                {" "}
                — your two live domains publish the Cloudflare include only, which means SPF fails
                alignment on every send. DKIM still carries DMARC, so mail delivers either way.
              </>
            ) : (
              " — matches your existing domains exactly."
            )}
          </p>
          <Toggle
            checked={config.omitEmailRoutingRecords}
            onChange={(v) => setCfg("omitEmailRoutingRecords", v)}
            label="Leave out records Cloudflare Email Routing creates itself (MX + its DKIM key)"
          />
        </div>
      </Card>

      {/* 2. DKIM */}
      {specs.length > 0 ? (
        <Card className="p-5">
          <h3 className="mb-1 text-lg">2. DKIM tokens from SES</h3>
          <p className="mb-3 text-xs text-muted">
            Add each domain as an identity in Amazon SES with Easy DKIM, then paste what it shows —
            the three CNAME rows, full BIND lines, or just the tokens, in any order. SES mints these
            per domain, so they cannot be generated here.
          </p>

          <div className="space-y-3">
            {specs.map((spec, i) => {
              const st = statuses[i];
              const o = overrides[spec.domain] ?? {};
              return (
                <div key={spec.domain} className="rounded-xl border-2 border-ink bg-canvas p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-extrabold">{spec.domain}</span>
                    <Badge tone={st.dkimComplete ? "mint" : st.dkimCount > 0 ? "sun" : "white"}>
                      {st.dkimCount}/{DKIM_TOKEN_COUNT} DKIM
                    </Badge>
                    {knownDomains.has(spec.domain) ? <Badge tone="sky">already in Domains</Badge> : null}
                    <span className="text-[11px] text-muted">{st.mailboxes.join(" · ") || "no mailboxes"}</span>
                  </div>

                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                    <div className="lg:col-span-2">
                      <textarea
                        className="input min-h-[72px] font-mono text-xs"
                        value={o.dkimText ?? ""}
                        onChange={(e) => setOverride(spec.domain, { dkimText: e.target.value })}
                        placeholder="Paste the three DKIM CNAME rows from SES…"
                      />
                    </div>
                    <div className="space-y-2">
                      <Field label="Netlify site" hint="Blank omits the www record">
                        <TextField
                          value={o.netlifySite ?? ""}
                          onChange={(v) => setOverride(spec.domain, { netlifySite: v })}
                          placeholder="stupendous-sorbet-8f8c44"
                        />
                      </Field>
                      <Field label="Prefixes for this domain" hint="Comma separated; blank uses the batch default">
                        <TextField
                          value={(o.prefixes ?? defaultPrefixes).join(", ")}
                          onChange={(v) =>
                            setOverride(spec.domain, {
                              prefixes: v.split(",").map((x) => x.trim()).filter(Boolean),
                            })
                          }
                        />
                      </Field>
                    </div>
                  </div>

                  {st.problems.length > 0 ? (
                    <p className="mt-2 flex items-start gap-1.5 text-[11px] text-muted">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      {st.problems.join(" · ")}
                    </p>
                  ) : (
                    <p className="mt-2 flex items-center gap-1.5 text-[11px] font-bold text-mint">
                      <Check size={12} /> Ready to export
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* 3. Export */}
      {specs.length > 0 ? (
        <Card className="p-5">
          <h3 className="mb-1 text-lg">3. Export and apply</h3>
          <p className="mb-3 text-xs text-muted">
            Zone files import at Cloudflare under DNS → Records → Import and Export. Enable Email
            Routing before importing, so its MX records aren't written twice.
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              className="btn-primary btn-sm"
              onClick={() => download(`zones-${new Date().toISOString().slice(0, 10)}.txt`, zoneBundle(specs, config), "text/plain")}
            >
              <Download size={14} /> All zone files
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={() => download(`dns-${new Date().toISOString().slice(0, 10)}.csv`, csvFor(specs, config))}
            >
              <Download size={14} /> CSV
            </button>
            <button className="btn-ghost btn-sm" onClick={() => copy(checklist.map((c, i) => `${i + 1}. ${c}`).join("\n"), "Checklist")}>
              <ClipboardList size={14} /> Copy checklist
            </button>
            <button className="btn-ghost btn-sm" onClick={() => void createDomainRows()}>
              <Plus size={14} /> Add to Domains
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {specs.map((spec) => {
              const zone = zoneFileFor(spec, config);
              const records = recordsFor(spec, config);
              return (
                <details key={spec.domain} className="rounded-xl border-2 border-ink bg-canvas">
                  <summary className="cursor-pointer p-3 text-sm font-bold">
                    {spec.domain}{" "}
                    <span className="font-normal text-muted">— {records.length} records</span>
                  </summary>
                  <div className="border-t-2 border-ink/10 p-3">
                    <div className="mb-2 flex gap-2">
                      <button className="btn-ghost btn-sm" onClick={() => copy(zone, `${spec.domain} zone`)}>
                        <Copy size={13} /> Copy zone
                      </button>
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => download(`${spec.domain}.txt`, zone, "text/plain")}
                      >
                        <Download size={13} /> Download
                      </button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px] border-collapse text-left text-xs">
                        <thead>
                          <tr className="uppercase text-muted">
                            <th className="py-1 pr-3">Type</th>
                            <th className="py-1 pr-3">Name</th>
                            <th className="py-1 pr-3">Value</th>
                            <th className="py-1">Why</th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.map((r, i) => (
                            <tr key={`${r.type}-${r.name}-${i}`} className="border-t border-ink/10">
                              <td className="py-1 pr-3 font-bold">{r.type}</td>
                              <td className="max-w-[220px] truncate py-1 pr-3 font-mono" title={r.name}>
                                {r.name}
                              </td>
                              <td className="max-w-[260px] truncate py-1 pr-3 font-mono" title={r.value}>
                                {r.priority !== undefined ? `${r.priority} ` : ""}
                                {r.value}
                              </td>
                              <td className="py-1 text-muted">{r.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <pre className="mt-2 max-h-56 overflow-auto rounded-lg border-2 border-ink bg-white p-2 text-[11px]">
                      {zone}
                    </pre>
                  </div>
                </details>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* 4. Mailboxes */}
      {specs.length > 0 ? (
        <Card className="p-5">
          <h3 className="mb-1 flex items-center gap-2 text-lg">
            <KeyRound size={18} /> 4. Create the mailboxes
          </h3>
          <p className="mb-3 text-xs text-muted">
            Uses a saved credential profile. Preview first — it shows the exact payload per mailbox
            without sending anything.
          </p>

          {profilesLocked ? (
            <p className="rounded-xl border-2 border-ink bg-sun/30 p-3 text-xs">
              Credential profiles are locked until <code>APP_FUNCTION_TOKEN</code> is set. Add it in
              Netlify, then create a profile under <Link to="/settings" className="underline">Settings</Link>.
            </p>
          ) : profiles.length === 0 ? (
            <p className="rounded-xl border-2 border-ink bg-canvas p-3 text-xs">
              No credential profiles yet. Create one under{" "}
              <Link to="/settings" className="underline">Settings → Mailbox credentials</Link>.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Credential profile">
                  <SelectField
                    value={profileId}
                    onChange={setProfileId}
                    options={[
                      { value: "", label: "Choose…" },
                      ...profiles.map((p) => ({ value: p.id, label: p.name || "Untitled" })),
                    ]}
                  />
                </Field>
                <button
                  className="btn-ghost btn-sm"
                  disabled={!profile || creating}
                  onClick={() => void createMailboxes(true)}
                >
                  <Eye size={14} /> Preview {totalMailboxes}
                </button>
                <button
                  className="btn-primary btn-sm"
                  disabled={!profile || creating}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Create ${totalMailboxes} mailbox${totalMailboxes === 1 ? "" : "es"} in Instantly?`,
                      )
                    ) {
                      void createMailboxes(false);
                    }
                  }}
                >
                  {creating ? <Spinner /> : <Zap size={14} />} Create {totalMailboxes}
                </button>
              </div>

              {profile ? (
                <p className="mt-2 text-[11px] text-muted">
                  {profile.smtp_host}:{profile.smtp_port} sending · {profile.imap_host}:
                  {profile.imap_port} receiving · {profile.daily_limit}/day · warmup{" "}
                  {profile.warmup_limit}
                </p>
              ) : null}

              {createLog.length > 0 ? (
                <pre
                  className={cn(
                    "mt-3 max-h-56 overflow-auto rounded-lg border-2 border-ink p-2 text-[11px]",
                    createLog.some((l) => l.startsWith("FAILED")) ? "bg-danger/10" : "bg-canvas",
                  )}
                >
                  {createLog.join("\n")}
                </pre>
              ) : null}
            </>
          )}
        </Card>
      ) : null}

      {/* Checklist */}
      {specs.length > 0 ? (
        <Card className="p-5">
          <h3 className="mb-3 flex items-center gap-2 text-lg">
            <ClipboardList size={18} /> Order of operations
          </h3>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            {checklist.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        </Card>
      ) : null}
    </div>
  );
}
