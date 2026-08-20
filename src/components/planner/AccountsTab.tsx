// ---------------------------------------------------------------------------
// The Accounts tab: every inbox, its niche tag, the IMAP/SMTP it's on, and —
// once verified — the exact campaigns it can be swapped into.
//
// The tag you attach here is written to the app's `mailbox_tags` table, which
// is the source of truth the swapper reads (unioned with Instantly's tags when
// that endpoint resolves). Verify recomputes eligibility with the SAME rule the
// maintenance/cron swap path uses (accountsTag.eligibleCampaignsFor), so what
// this tab shows is exactly what a swap would honour — no second opinion.
//
// "Match…" is the manual escape hatch: when Instantly has no tags to match on,
// it gives an account and the campaigns you pick a shared niche tag (writing
// the account's `mailbox_tags` and each campaign's `campaign_group_overrides`),
// which the same eligibility rule then honours — no swap-code change.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Tag, Check, ShieldCheck, AlertTriangle, Link2, RefreshCw } from "lucide-react";
import { Card, Badge, Spinner, StatCard } from "../ui/primitives";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/toast";
import { useCollection, useInsert, useUpdate } from "../../lib/hooks";
import { MailboxTag, TABLES } from "../../lib/types";
import {
  buildTagMap,
  mergeTagMaps,
  knownTags,
  normaliseTag,
  type TagMap,
} from "../../lib/tags";
import {
  resolveCampaignTags,
  eligibleCampaignsFor,
  buildAccountRows,
  tagCoverage,
  diagnoseNoMatch,
  applyManualMatch,
  type ResolvedCampaign,
  type CampaignLite,
  type NoMatchReason,
} from "../../lib/accountsTag";
import type { CredsWithSource } from "../../lib/accountCreds";

/** The sentence shown when an account matches no campaign — never just "none". */
function noMatchMessage(reason: NoMatchReason): string {
  switch (reason.kind) {
    case "account_untagged":
      return "This inbox has no tag — tag it above, or use Match… to bind it to campaigns.";
    case "no_campaign_tagged":
      return "No campaign has a tag yet, so tagging this inbox can't match anything. Use Match… to set a shared niche, or tag your campaigns in Instantly.";
    case "tag_mismatch":
      return `Tagged ${reason.accountTags.join(", ")}, but campaigns use ${reason.campaignTags.join(", ")}. Use Match… or align the tags.`;
    default:
      return "No campaign matches this tag.";
  }
}

export function AccountsTab({
  emails,
  campaigns,
  overrides,
  instantlyTagsByEmail,
  instantlyTagsByCampaign,
  allInstantlyTags,
  onPatchSettings,
  credsByEmail,
  rawAccountsByEmail,
  onLoadImap,
  loadingImap,
  canLoadImap,
}: {
  /** Every connected inbox address. */
  emails: string[];
  campaigns: CampaignLite[];
  overrides: Record<string, string>;
  /** Tags Instantly reports per inbox, merged with the app's own table. */
  instantlyTagsByEmail: TagMap;
  instantlyTagsByCampaign: Map<string, string[]>;
  /** Every tag seen live in Instantly — feeds the picker. */
  allInstantlyTags: string[];
  /** Persist a settings patch (used to write campaign_group_overrides). */
  onPatchSettings: (patch: { campaign_group_overrides: Record<string, string> }) => Promise<void>;
  /** IMAP/SMTP identity per inbox (live Instantly ∪ setup log), if available. */
  credsByEmail?: Map<string, CredsWithSource>;
  /** Raw account JSON per inbox, for the key-discovery expander. */
  rawAccountsByEmail?: Map<string, Record<string, unknown>>;
  onLoadImap?: () => void;
  loadingImap?: boolean;
  canLoadImap?: boolean;
}) {
  const toast = useToast();
  const tagRowsQ = useCollection<MailboxTag>(TABLES.mailboxTags);
  const insertTag = useInsert<MailboxTag>(TABLES.mailboxTags);
  const updateTag = useUpdate<MailboxTag>(TABLES.mailboxTags);

  // App tags unioned with Instantly's — the exact map the swapper consults.
  const tagMap = useMemo(
    () => mergeTagMaps(buildTagMap(tagRowsQ.data ?? []), instantlyTagsByEmail),
    [tagRowsQ.data, instantlyTagsByEmail],
  );

  const resolved = useMemo(
    () => resolveCampaignTags(campaigns, overrides, instantlyTagsByCampaign),
    [campaigns, overrides, instantlyTagsByCampaign],
  );

  // The picker's options: every niche your campaigns use + every Instantly tag
  // seen + anything already assigned. "Fetched live" is allInstantlyTags.
  const tagOptions = useMemo(() => {
    const assigned = (tagRowsQ.data ?? []).flatMap((r) => r.tags ?? []);
    return knownTags(campaigns, overrides, [...assigned, ...allInstantlyTags]);
  }, [campaigns, overrides, tagRowsQ.data, allInstantlyTags]);

  const rows = useMemo(() => buildAccountRows(emails, tagMap), [emails, tagMap]);
  const coverage = useMemo(() => tagCoverage(rows), [rows]);
  const campaignsWithTag = resolved.filter((c) => c.tags.length > 0).length;

  // Verified eligibility, keyed by email — populated on demand, never stale-hidden.
  const [verified, setVerified] = useState<Map<string, ResolvedCampaign[]>>(new Map());
  const [draft, setDraft] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);

  // --- Manual match modal state -------------------------------------------
  const [matchFor, setMatchFor] = useState<string | null>(null);
  const [matchNiche, setMatchNiche] = useState("");
  const [matchChecked, setMatchChecked] = useState<Set<string>>(new Set());
  const [matchBusy, setMatchBusy] = useState(false);

  async function attach(email: string, raw: string) {
    const tags = raw.split(",").map(normaliseTag).filter(Boolean);
    if (tags.length === 0) {
      toast.push("Pick or type a tag first", "error");
      return;
    }
    setBusy(email);
    const existing = (tagRowsQ.data ?? []).find(
      (r) => (r.email ?? "").trim().toLowerCase() === email.trim().toLowerCase(),
    );
    try {
      if (existing) await updateTag.mutateAsync({ id: existing.id, patch: { tags, source: "manual" } });
      else await insertTag.mutateAsync({ email, tags, source: "manual" } as Partial<MailboxTag>);
      // Clear any stale verification — the tag changed, so re-verify.
      setVerified((m) => {
        const n = new Map(m);
        n.delete(email.toLowerCase());
        return n;
      });
      toast.push(`${email} tagged ${tags.join(", ")}`, "success");
    } catch (err) {
      toast.push(`Couldn't save: ${err instanceof Error ? err.message : "error"}`, "error");
    } finally {
      setBusy(null);
    }
  }

  /** Verify = compute the campaigns this account may swap into, live. */
  function verify(email: string, tags: string[]) {
    const elig = eligibleCampaignsFor(tags, resolved);
    setVerified((m) => new Map(m).set(email.toLowerCase(), elig));
    if (elig.length === 0) {
      toast.push(`${email}: ${noMatchMessage(diagnoseNoMatch(tags, resolved))}`, "info");
    } else {
      toast.push(`${email}: eligible for ${elig.length} campaign${elig.length === 1 ? "" : "s"}`, "success");
    }
  }

  function verifyAll() {
    const next = new Map<string, ResolvedCampaign[]>();
    for (const r of rows) next.set(r.email.toLowerCase(), eligibleCampaignsFor(r.tags, resolved));
    setVerified(next);
    toast.push("Verified all accounts", "success");
  }

  // --- Match modal ---------------------------------------------------------
  function openMatch(email: string, currentTag: string) {
    setMatchFor(email);
    setMatchNiche(currentTag);
    setMatchChecked(new Set());
  }

  async function confirmMatch() {
    if (matchFor === null) return;
    const email = matchFor;
    if (normaliseTag(matchNiche) === "") {
      toast.push("Type a niche first", "error");
      return;
    }
    const row = rows.find((r) => r.email === email);
    const result = applyManualMatch(
      overrides,
      matchNiche,
      [...matchChecked],
      row?.tags ?? [],
      campaigns,
      instantlyTagsByCampaign,
    );
    setMatchBusy(true);
    try {
      // 1. The account gets the niche in mailbox_tags (the swapper's tag source).
      const existing = (tagRowsQ.data ?? []).find(
        (r) => (r.email ?? "").trim().toLowerCase() === email.trim().toLowerCase(),
      );
      if (existing) await updateTag.mutateAsync({ id: existing.id, patch: { tags: result.tags, source: "manual" } });
      else await insertTag.mutateAsync({ email, tags: result.tags, source: "manual" } as Partial<MailboxTag>);
      // 2. Each chosen untagged campaign gets the niche as its override.
      await onPatchSettings({ campaign_group_overrides: result.overrides });
      // 3. Instantly-tagged campaigns can't be overridden — say so plainly.
      if (result.ignoredInstantly.length) {
        const names = result.ignoredInstantly.map((id) => resolved.find((c) => c.id === id)?.name ?? id);
        toast.push(
          `Already tagged in Instantly: ${names.join(", ")} — those keep Instantly's tag. Retag them there to change it.`,
          "info",
        );
      }
      // 4. Re-verify against the new binding.
      setVerified((m) => {
        const n = new Map(m);
        n.delete(email.toLowerCase());
        return n;
      });
      const bound = result.changed.length + result.alreadyEligible.length;
      toast.push(
        bound > 0
          ? `${email} matched to ${bound} campaign${bound === 1 ? "" : "s"} (niche ${normaliseTag(matchNiche)})`
          : `${email} tagged ${normaliseTag(matchNiche)} — tick campaigns to bind them`,
        bound > 0 ? "success" : "info",
      );
      setMatchFor(null);
    } catch (err) {
      toast.push(`Couldn't save match: ${err instanceof Error ? err.message : "error"}`, "error");
    } finally {
      setMatchBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Inboxes" value={coverage.total} tone="pink" icon={<Tag size={18} />} />
        <StatCard label="Tagged" value={coverage.tagged} tone="mint" sublabel="swap-eligible" />
        <StatCard label="Untagged" value={coverage.untagged} tone="sun" sublabel="can't be swapped" />
        <StatCard label="Campaigns w/ a tag" value={campaignsWithTag} tone="sky" />
      </div>

      {campaignsWithTag === 0 ? (
        <Card className="flex items-start gap-2 bg-sun/30 p-4 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p>
            <b>None of your campaigns has a tag</b>, so no account can be verified against one yet.
            Tag campaigns in Instantly, or use <b>Match…</b> on any account to give it and the
            campaigns you pick a shared niche — the swapper honours that immediately.
          </p>
        </Card>
      ) : null}

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink p-4">
          <div>
            <h3 className="text-base font-extrabold">Accounts &amp; swap eligibility</h3>
            <p className="text-xs text-muted">
              Tag an inbox, then Verify to see which campaigns it can be swapped into — the
              same tag rule the swapper enforces. The line under each address is the IMAP/SMTP it uses.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onLoadImap && canLoadImap ? (
              <button className="btn-ghost btn-sm" onClick={onLoadImap} disabled={loadingImap}>
                {loadingImap ? <Spinner /> : <RefreshCw size={14} />} Load IMAP details
              </button>
            ) : null}
            <button className="btn-ghost btn-sm" onClick={verifyAll}>
              <ShieldCheck size={14} /> Verify all
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted">No connected inboxes yet.</p>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full min-w-[820px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                  <th className="px-3 py-2">Inbox &amp; IMAP</th>
                  <th className="w-28 px-3 py-2">Current tag</th>
                  <th className="w-72 px-3 py-2">Tag / match</th>
                  <th className="px-3 py-2">Eligible campaigns (verify)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const elig = verified.get(r.email.toLowerCase());
                  const pick = draft.get(r.email) ?? "";
                  const cw = credsByEmail?.get(r.email.toLowerCase());
                  const raw = rawAccountsByEmail?.get(r.email.toLowerCase());
                  const c = cw?.creds;
                  const hasImap = Boolean(c && (c.imapHost || c.imapUsername));
                  return (
                    <tr key={r.email} className="border-b border-ink/10 align-top">
                      <td className="px-3 py-2">
                        <div className="font-semibold">{r.email}</div>
                        <div className="mt-0.5 text-[11px] font-normal text-muted">
                          {hasImap ? (
                            <span
                              title={
                                `IMAP: ${c!.imapUsername ?? "?"} @ ${c!.imapHost ?? "?"}${c!.imapPort ? ":" + c!.imapPort : ""}\n` +
                                `SMTP: ${c!.smtpUsername ?? "?"} @ ${c!.smtpHost ?? "?"}${c!.smtpPort ? ":" + c!.smtpPort : ""}`
                              }
                            >
                              IMAP {c!.imapUsername ?? c!.imapHost}
                              {c!.imapHost && c!.imapUsername ? ` @ ${c!.imapHost}` : ""}
                            </span>
                          ) : (
                            <span>IMAP not reported</span>
                          )}
                          {cw ? (
                            <Badge tone={cw.source === "live" ? "mint" : "sun"} className="ml-1.5 !px-1.5 !py-0 text-[10px]">
                              {cw.source === "live" ? "live" : "setup log"}
                            </Badge>
                          ) : null}
                          {raw ? (
                            <details className="mt-1">
                              <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wide">raw</summary>
                              <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-ink/20 bg-canvas p-2 text-[10px] leading-tight">
                                {JSON.stringify(raw, null, 2)}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {r.tags.length ? (
                          r.tags.map((t) => (
                            <Badge key={t} tone="mint" className="mr-1">{t}</Badge>
                          ))
                        ) : (
                          <Badge tone="sun">
                            <AlertTriangle size={11} /> untagged
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input
                            className="input h-8 w-32 text-xs"
                            list="acct-tag-options"
                            value={pick}
                            onChange={(e) => setDraft((m) => new Map(m).set(r.email, e.target.value))}
                            placeholder={r.tags[0] ?? "choose tag"}
                          />
                          <button
                            className="btn-ghost btn-sm"
                            disabled={busy === r.email}
                            onClick={() => void attach(r.email, pick || r.tags.join(","))}
                          >
                            {busy === r.email ? <Spinner /> : <Tag size={13} />} Save
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => verify(r.email, pick ? [normaliseTag(pick)] : r.tags)}
                            title="Compute the campaigns this account may swap into"
                          >
                            <Check size={13} /> Verify
                          </button>
                          <button
                            className="btn-ghost btn-sm"
                            onClick={() => openMatch(r.email, pick || r.tags[0] || "")}
                            title="Bind this account to specific campaigns via a shared niche"
                          >
                            <Link2 size={13} /> Match…
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {elig === undefined ? (
                          <span className="text-muted">— not verified —</span>
                        ) : elig.length === 0 ? (
                          <span className="text-muted">{noMatchMessage(diagnoseNoMatch(r.tags, resolved))}</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {elig.map((c2) => (
                              <span key={c2.id} title={`tags: ${c2.tags.join(", ")}`}>
                                <Badge tone="sky">{c2.name}</Badge>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Campaign-tag reference — so a mismatch like "FOR AEO CAMPAIGN" vs "AEO"
          is always inspectable, and untagged campaigns are visible. */}
      <Card className="p-4">
        <details>
          <summary className="cursor-pointer select-none text-sm font-bold">
            Campaign tags ({campaignsWithTag}/{resolved.length} tagged)
          </summary>
          <div className="mt-3 flex flex-col gap-1.5">
            {resolved.length === 0 ? (
              <p className="text-xs text-muted">No campaigns loaded.</p>
            ) : (
              resolved.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{c.name}</span>
                  <span className="flex shrink-0 flex-wrap gap-1">
                    {c.tags.length ? (
                      c.tags.map((t) => <Badge key={t} tone="sky">{t}</Badge>)
                    ) : (
                      <Badge tone="sun">untagged</Badge>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </details>
      </Card>

      {/* Live tag options for every row's datalist. */}
      <datalist id="acct-tag-options">
        {tagOptions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      {/* Manual match modal. */}
      <Modal
        open={matchFor !== null}
        onClose={() => setMatchFor(null)}
        title={`Match ${matchFor ?? ""} to campaigns`}
        size="lg"
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setMatchFor(null)} disabled={matchBusy}>
              Cancel
            </button>
            <button
              className="btn btn-sm"
              onClick={() => void confirmMatch()}
              disabled={matchBusy || normaliseTag(matchNiche) === ""}
            >
              {matchBusy ? <Spinner /> : <Link2 size={14} />} Match
            </button>
          </>
        }
      >
        <p className="text-xs text-muted">
          This gives the inbox and the campaigns you tick a <b>shared niche tag</b>. The swapper
          (and the daily auto-swap) then treat the inbox as eligible for those campaigns. A campaign
          already tagged in Instantly keeps that tag — it's shown below and left unchanged.
        </p>
        <label className="mt-3 block">
          <span className="label">Niche</span>
          <input
            className="input"
            list="acct-tag-options"
            value={matchNiche}
            onChange={(e) => setMatchNiche(e.target.value)}
            placeholder="e.g. AEO"
          />
        </label>
        <p className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-muted">Campaigns</p>
        <div className="max-h-72 space-y-1 overflow-auto rounded-lg border-2 border-ink p-2">
          {resolved.length === 0 ? (
            <p className="p-2 text-xs text-muted">No campaigns loaded.</p>
          ) : (
            resolved.map((c) => {
              const checked = matchChecked.has(c.id);
              return (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-canvas">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-ink"
                    checked={checked}
                    onChange={() =>
                      setMatchChecked((s) => {
                        const n = new Set(s);
                        if (n.has(c.id)) n.delete(c.id);
                        else n.add(c.id);
                        return n;
                      })
                    }
                  />
                  <span className="flex-1 truncate text-sm">{c.name}</span>
                  <span className="flex shrink-0 flex-wrap gap-1">
                    {c.tags.length ? (
                      c.tags.map((t) => <Badge key={t} tone="sky">{t}</Badge>)
                    ) : (
                      <Badge tone="sun">untagged</Badge>
                    )}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </Modal>
    </div>
  );
}
