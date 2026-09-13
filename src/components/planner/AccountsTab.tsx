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
// Tag writes are OPTIMISTIC and de-duplicated (planTagWrites): the chip flips
// immediately, a retag REPLACES rather than piling a second row on (which the
// tag-map union would otherwise never clear), and one write covers many inboxes
// so bulk tagging can't race itself.
//
// "Match…" is the manual escape hatch: it gives an account and the campaigns you
// pick a shared niche tag (writing the account's `mailbox_tags` and each
// campaign's `campaign_group_overrides`), which the same eligibility rule then
// honours — no swap-code change. Bulk Match does the same across a selection.
// ---------------------------------------------------------------------------
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Tag, Check, ShieldCheck, AlertTriangle, Link2, RefreshCw, Trash2, Search } from "lucide-react";
import { Card, Badge, Spinner, StatCard } from "../ui/primitives";
import { Modal, ConfirmDialog } from "../ui/Modal";
import { useToast } from "../ui/toast";
import { useCollection, useUpsertMany, useRemoveMany } from "../../lib/hooks";
import { MailboxTag, TABLES } from "../../lib/types";
import { uuid } from "../../lib/utils";
import {
  buildTagMap,
  mergeTagMaps,
  knownTags,
  normaliseTag,
  normaliseTags,
  type TagMap,
} from "../../lib/tags";
import {
  resolveCampaignTags,
  eligibleCampaignsFor,
  buildAccountRows,
  tagCoverage,
  diagnoseNoMatch,
  applyManualMatch,
  planTagWrites,
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
  const qc = useQueryClient();
  const tagRowsQ = useCollection<MailboxTag>(TABLES.mailboxTags);
  const upsertTags = useUpsertMany<MailboxTag>(TABLES.mailboxTags);
  const removeTags = useRemoveMany(TABLES.mailboxTags);
  const TAGS_KEY = [TABLES.mailboxTags];

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

  // --- Selection + filter --------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.email.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [rows, query]);
  const visibleKeys = filtered.map((r) => r.email.toLowerCase());
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));
  const selectedEmails = () => rows.filter((r) => selected.has(r.email.toLowerCase())).map((r) => r.email);

  function toggleOne(email: string) {
    const k = email.toLowerCase();
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }
  function toggleAllVisible() {
    setSelected((s) => {
      const n = new Set(s);
      if (allVisibleSelected) visibleKeys.forEach((k) => n.delete(k));
      else visibleKeys.forEach((k) => n.add(k));
      return n;
    });
  }
  const selectUntagged = () =>
    setSelected(new Set(filtered.filter((r) => r.state === "untagged").map((r) => r.email.toLowerCase())));
  const clearSelection = () => setSelected(new Set());

  // --- Campaign tagging ----------------------------------------------------
  const [campDraft, setCampDraft] = useState<Map<string, string>>(new Map());
  const [campBusy, setCampBusy] = useState<string | null>(null);
  const [campQuery, setCampQuery] = useState("");
  // Campaigns Instantly itself tagged — their override is ignored (Instantly wins),
  // so we lock those rather than let you set a no-op override.
  const instantlyTaggedCampaign = (id: string) =>
    (instantlyTagsByCampaign.get(id)?.length ?? 0) > 0 ||
    ((campaigns.find((c) => c.id === id)?.instantlyTags?.length ?? 0) > 0);

  /** Set/clear a campaign's niche via the app override (campaign_group_overrides). */
  async function saveCampaignTag(id: string, raw: string) {
    const niche = normaliseTags(raw.split(",")).join(",");
    const next = { ...overrides };
    if (niche) next[id] = niche;
    else delete next[id];
    setCampBusy(id);
    try {
      await onPatchSettings({ campaign_group_overrides: next });
      toast.push(niche ? `Campaign tagged ${niche}` : "Campaign tag cleared", niche ? "success" : "info");
    } catch (err) {
      toast.push(`Couldn't save campaign tag: ${err instanceof Error ? err.message : "error"}`, "error");
    } finally {
      setCampBusy(null);
    }
  }

  // --- Single match modal --------------------------------------------------
  const [matchFor, setMatchFor] = useState<string | null>(null);
  const [matchNiche, setMatchNiche] = useState("");
  const [matchChecked, setMatchChecked] = useState<Set<string>>(new Set());
  const [matchBusy, setMatchBusy] = useState(false);

  // --- Bulk modals ---------------------------------------------------------
  const [bulkOpen, setBulkOpen] = useState<null | "tag" | "match">(null);
  const [bulkNiche, setBulkNiche] = useState("");
  const [bulkChecked, setBulkChecked] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // -------------------------------------------------------------------------
  // The one write path: optimistic, de-duplicated, race-safe.
  // -------------------------------------------------------------------------
  async function saveTags(targets: { email: string; tags: string[] }[], successMsg?: string): Promise<void> {
    const plan = planTagWrites(targets, tagRowsQ.data ?? [], uuid);
    if (plan.upserts.length === 0 && plan.removeIds.length === 0) return;
    const prev = qc.getQueryData<MailboxTag[]>(TAGS_KEY);

    // Optimistic cache: apply the plan so the chip flips before the round-trip.
    const removeSet = new Set(plan.removeIds);
    const upsertById = new Map(plan.upserts.map((u) => [u.id, u]));
    const existingIds = new Set((prev ?? []).map((r) => r.id));
    const next: MailboxTag[] = [];
    for (const r of prev ?? []) {
      if (removeSet.has(r.id)) continue;
      const u = upsertById.get(r.id);
      next.push(u ? ({ ...r, tags: u.tags, source: u.source } as MailboxTag) : r);
    }
    for (const u of plan.upserts) {
      if (!existingIds.has(u.id)) next.push({ id: u.id, email: u.email, tags: u.tags, source: u.source } as MailboxTag);
    }
    qc.setQueryData(TAGS_KEY, next);

    try {
      if (plan.upserts.length) await upsertTags.mutateAsync(plan.upserts as Partial<MailboxTag>[]);
      if (plan.removeIds.length) await removeTags.mutateAsync(plan.removeIds);
      // Re-verify against the just-saved tags rather than dropping the result —
      // saving the tag you verified should keep the eligible-campaigns column
      // populated, not blank it back to "not verified".
      setVerified((m) => {
        const n = new Map(m);
        for (const t of targets) n.set(t.email.toLowerCase(), eligibleCampaignsFor(t.tags, resolved));
        return n;
      });
      if (successMsg) toast.push(successMsg, "success");
    } catch (err) {
      qc.setQueryData(TAGS_KEY, prev); // roll back the optimistic write
      qc.invalidateQueries({ queryKey: TAGS_KEY });
      toast.push(`Couldn't save: ${err instanceof Error ? err.message : "error"}`, "error");
    }
  }

  async function clearTags(emailList: string[]): Promise<void> {
    const set = new Set(emailList.map((e) => e.toLowerCase()));
    const ids = (tagRowsQ.data ?? [])
      .filter((r) => set.has((r.email ?? "").trim().toLowerCase()))
      .map((r) => r.id);
    if (ids.length === 0) {
      toast.push("Those inboxes have no app tag to clear", "info");
      return;
    }
    const prev = qc.getQueryData<MailboxTag[]>(TAGS_KEY);
    const rm = new Set(ids);
    qc.setQueryData(TAGS_KEY, (prev ?? []).filter((r) => !rm.has(r.id)));
    try {
      await removeTags.mutateAsync(ids);
      // Cleared = untagged = eligible for nothing; keep the column meaningful.
      setVerified((m) => {
        const n = new Map(m);
        for (const e of set) n.set(e, []);
        return n;
      });
      toast.push(`Cleared the tag on ${emailList.length} inbox${emailList.length === 1 ? "" : "es"}`, "success");
    } catch (err) {
      qc.setQueryData(TAGS_KEY, prev);
      qc.invalidateQueries({ queryKey: TAGS_KEY });
      toast.push(`Couldn't clear: ${err instanceof Error ? err.message : "error"}`, "error");
    }
  }

  async function attach(email: string, raw: string) {
    const tags = raw.split(",").map(normaliseTag).filter(Boolean);
    if (tags.length === 0) {
      toast.push("Pick or type a tag first", "error");
      return;
    }
    setBusy(email);
    await saveTags([{ email, tags }], `${email} tagged ${tags.join(", ")}`);
    setBusy(null);
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

  function verifyRows(subset: typeof rows, label: string) {
    setVerified((m) => {
      const n = new Map(m);
      for (const r of subset) n.set(r.email.toLowerCase(), eligibleCampaignsFor(r.tags, resolved));
      return n;
    });
    toast.push(label, "success");
  }

  // --- Single match --------------------------------------------------------
  function openMatch(email: string, currentTag: string) {
    setMatchFor(email);
    setMatchNiche(currentTag);
    setMatchChecked(new Set());
  }

  /** Persist a manual match for one or many accounts by a shared niche. */
  async function runMatch(emailList: string[], niche: string, campaignIds: string[]): Promise<boolean> {
    if (normaliseTag(niche) === "") {
      toast.push("Type a niche first", "error");
      return false;
    }
    // Thread the overrides map through every account so they accumulate into one
    // settings write, and collect the tag rows for one saveTags call.
    let acc = overrides;
    const ignored = new Set<string>();
    const tagTargets: { email: string; tags: string[] }[] = [];
    for (const email of emailList) {
      const row = rows.find((r) => r.email === email);
      const result = applyManualMatch(acc, niche, campaignIds, row?.tags ?? [], campaigns, instantlyTagsByCampaign);
      acc = result.overrides;
      result.ignoredInstantly.forEach((id) => ignored.add(id));
      tagTargets.push({ email, tags: result.tags });
    }
    try {
      await onPatchSettings({ campaign_group_overrides: acc });
      await saveTags(tagTargets);
      if (ignored.size) {
        const names = [...ignored].map((id) => resolved.find((c) => c.id === id)?.name ?? id);
        toast.push(
          `Already tagged in Instantly: ${names.join(", ")} — those keep Instantly's tag. Retag them there to change it.`,
          "info",
        );
      }
      toast.push(
        `Matched ${emailList.length} inbox${emailList.length === 1 ? "" : "es"} to ${campaignIds.length} campaign${campaignIds.length === 1 ? "" : "s"} (niche ${normaliseTag(niche)})`,
        "success",
      );
      return true;
    } catch (err) {
      toast.push(`Couldn't save match: ${err instanceof Error ? err.message : "error"}`, "error");
      return false;
    }
  }

  async function confirmMatch() {
    if (matchFor === null) return;
    setMatchBusy(true);
    const ok = await runMatch([matchFor], matchNiche, [...matchChecked]);
    setMatchBusy(false);
    if (ok) setMatchFor(null);
  }

  async function confirmBulkTag() {
    const niche = normaliseTag(bulkNiche);
    if (!niche) {
      toast.push("Type a niche first", "error");
      return;
    }
    const list = selectedEmails();
    setBulkBusy(true);
    await saveTags(list.map((email) => ({ email, tags: [niche] })), `Tagged ${list.length} inbox${list.length === 1 ? "" : "es"} ${niche}`);
    setBulkBusy(false);
    setBulkOpen(null);
    clearSelection();
  }

  async function confirmBulkMatch() {
    setBulkBusy(true);
    const ok = await runMatch(selectedEmails(), bulkNiche, [...bulkChecked]);
    setBulkBusy(false);
    if (ok) {
      setBulkOpen(null);
      clearSelection();
    }
  }

  function openBulk(kind: "tag" | "match") {
    setBulkNiche("");
    setBulkChecked(new Set());
    setBulkOpen(kind);
  }

  const toggleCampaign = (setter: Dispatch<SetStateAction<Set<string>>>) => (id: string) =>
    setter((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // A reusable campaign checklist for the single + bulk match modals.
  const campaignChecklist = (checked: Set<string>, onToggle: (id: string) => void) => (
    <div className="max-h-72 space-y-1 overflow-auto rounded-lg border-2 border-ink p-2">
      {resolved.length === 0 ? (
        <p className="p-2 text-xs text-muted">No campaigns loaded.</p>
      ) : (
        resolved.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-canvas">
            <input type="checkbox" className="h-4 w-4 accent-ink" checked={checked.has(c.id)} onChange={() => onToggle(c.id)} />
            <span className="flex-1 truncate text-sm">{c.name}</span>
            <span className="flex shrink-0 flex-wrap gap-1">
              {c.tags.length ? c.tags.map((t) => <Badge key={t} tone="sky">{t}</Badge>) : <Badge tone="sun">untagged</Badge>}
            </span>
          </label>
        ))
      )}
    </div>
  );

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

      {/* Bulk action bar — appears when inboxes are selected. */}
      {selected.size > 0 ? (
        <Card className="flex flex-wrap items-center gap-2 bg-pink/30 p-3">
          <span className="text-sm font-bold">{selected.size} selected</span>
          <button className="btn btn-sm" onClick={() => openBulk("tag")}>
            <Tag size={13} /> Tag…
          </button>
          <button className="btn-ghost btn-sm" onClick={() => openBulk("match")}>
            <Link2 size={13} /> Match…
          </button>
          <button
            className="btn-ghost btn-sm"
            onClick={() => verifyRows(rows.filter((r) => selected.has(r.email.toLowerCase())), `Verified ${selected.size} inboxes`)}
          >
            <Check size={13} /> Verify
          </button>
          <button className="btn-ghost btn-sm" onClick={() => setConfirmClear(true)}>
            <Trash2 size={13} /> Clear tags
          </button>
          <button className="btn-ghost btn-sm" onClick={clearSelection}>
            Clear selection
          </button>
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
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                className="input h-8 w-44 pl-7 text-xs"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by email or tag"
              />
            </div>
            <button className="btn-ghost btn-sm" onClick={selectUntagged} title="Select every untagged inbox in view">
              Select untagged
            </button>
            {onLoadImap && canLoadImap ? (
              <button className="btn-ghost btn-sm" onClick={onLoadImap} disabled={loadingImap}>
                {loadingImap ? <Spinner /> : <RefreshCw size={14} />} Load IMAP details
              </button>
            ) : null}
            <button className="btn-ghost btn-sm" onClick={() => verifyRows(rows, "Verified all accounts")}>
              <ShieldCheck size={14} /> Verify all
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted">No connected inboxes yet.</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-sm text-muted">No inboxes match “{query}”.</p>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full min-w-[860px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-ink"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      title="Select all in view"
                    />
                  </th>
                  <th className="px-3 py-2">Inbox &amp; IMAP</th>
                  <th className="w-28 px-3 py-2">Current tag</th>
                  <th className="w-72 px-3 py-2">Tag / match</th>
                  <th className="px-3 py-2">Eligible campaigns (verify)</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const elig = verified.get(r.email.toLowerCase());
                  const pick = draft.get(r.email) ?? "";
                  const cw = credsByEmail?.get(r.email.toLowerCase());
                  const raw = rawAccountsByEmail?.get(r.email.toLowerCase());
                  const c = cw?.creds;
                  const hasImap = Boolean(c && (c.imapHost || c.imapUsername));
                  const isSel = selected.has(r.email.toLowerCase());
                  return (
                    <tr key={r.email} className={`border-b border-ink/10 align-top ${isSel ? "bg-pink/10" : ""}`}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-ink"
                          checked={isSel}
                          onChange={() => toggleOne(r.email)}
                        />
                      </td>
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

      {/* Campaign tags — editable. Tag each campaign with its niche so accounts
          of that niche become swap-eligible for it. The list is live from
          Instantly, so newly-created campaigns appear here on Refresh. */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink p-4">
          <div>
            <h3 className="text-base font-extrabold">Campaign tags ({campaignsWithTag}/{resolved.length} tagged)</h3>
            <p className="text-xs text-muted">
              Set each campaign's niche. Campaigns come live from Instantly — new ones appear on
              <b> Refresh</b>. A campaign already tagged in Instantly keeps that tag.
            </p>
          </div>
          {resolved.length > 8 ? (
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                className="input h-8 w-44 pl-7 text-xs"
                value={campQuery}
                onChange={(e) => setCampQuery(e.target.value)}
                placeholder="Filter campaigns"
              />
            </div>
          ) : null}
        </div>
        {resolved.length === 0 ? (
          <p className="p-4 text-sm text-muted">No campaigns loaded.</p>
        ) : (
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full min-w-[620px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                  <th className="px-3 py-2">Campaign</th>
                  <th className="w-28 px-3 py-2">Current tag</th>
                  <th className="w-64 px-3 py-2">Set niche</th>
                </tr>
              </thead>
              <tbody>
                {resolved
                  .filter((c) => !campQuery.trim() || c.name.toLowerCase().includes(campQuery.trim().toLowerCase()))
                  .map((c) => {
                    const locked = instantlyTaggedCampaign(c.id);
                    const pick = campDraft.get(c.id) ?? (overrides[c.id] ?? "");
                    return (
                      <tr key={c.id} className="border-b border-ink/10 align-top">
                        <td className="px-3 py-2 font-semibold">{c.name}</td>
                        <td className="px-3 py-2">
                          {c.tags.length ? (
                            c.tags.map((t) => <Badge key={t} tone="sky" className="mr-1">{t}</Badge>)
                          ) : (
                            <Badge tone="sun">untagged</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {locked ? (
                            <span className="text-[11px] text-muted">tagged in Instantly — edit it there</span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <input
                                className="input h-8 w-32 text-xs"
                                list="acct-tag-options"
                                value={pick}
                                onChange={(e) => setCampDraft((m) => new Map(m).set(c.id, e.target.value))}
                                placeholder="choose niche"
                              />
                              <button
                                className="btn-ghost btn-sm"
                                disabled={campBusy === c.id}
                                onClick={() => void saveCampaignTag(c.id, pick)}
                              >
                                {campBusy === c.id ? <Spinner /> : <Tag size={13} />} Save
                              </button>
                              {(overrides[c.id] ?? "") ? (
                                <button
                                  className="btn-ghost btn-sm"
                                  disabled={campBusy === c.id}
                                  onClick={() => { setCampDraft((m) => new Map(m).set(c.id, "")); void saveCampaignTag(c.id, ""); }}
                                >
                                  Clear
                                </button>
                              ) : null}
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

      {/* Live tag options for every row's datalist. */}
      <datalist id="acct-tag-options">
        {tagOptions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      {/* Single manual match modal. */}
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
            <button className="btn btn-sm" onClick={() => void confirmMatch()} disabled={matchBusy || normaliseTag(matchNiche) === ""}>
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
          <input className="input" list="acct-tag-options" value={matchNiche} onChange={(e) => setMatchNiche(e.target.value)} placeholder="e.g. AEO" />
        </label>
        <p className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-muted">Campaigns</p>
        {campaignChecklist(matchChecked, toggleCampaign(setMatchChecked))}
      </Modal>

      {/* Bulk Tag / Bulk Match modal. */}
      <Modal
        open={bulkOpen !== null}
        onClose={() => setBulkOpen(null)}
        title={bulkOpen === "match" ? `Match ${selected.size} inboxes to campaigns` : `Tag ${selected.size} inboxes`}
        size="lg"
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setBulkOpen(null)} disabled={bulkBusy}>
              Cancel
            </button>
            <button
              className="btn btn-sm"
              onClick={() => void (bulkOpen === "match" ? confirmBulkMatch() : confirmBulkTag())}
              disabled={bulkBusy || normaliseTag(bulkNiche) === ""}
            >
              {bulkBusy ? <Spinner /> : bulkOpen === "match" ? <Link2 size={14} /> : <Tag size={14} />}{" "}
              {bulkOpen === "match" ? "Match all" : "Tag all"}
            </button>
          </>
        }
      >
        <p className="text-xs text-muted">
          {bulkOpen === "match"
            ? "Give every selected inbox and the campaigns you tick a shared niche tag. Campaigns already tagged in Instantly keep their tag."
            : "Set this niche tag on every selected inbox. It replaces any existing app tag on those inboxes."}
        </p>
        <label className="mt-3 block">
          <span className="label">Niche</span>
          <input className="input" list="acct-tag-options" value={bulkNiche} onChange={(e) => setBulkNiche(e.target.value)} placeholder="e.g. AEO" />
        </label>
        {bulkOpen === "match" ? (
          <>
            <p className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-muted">Campaigns</p>
            {campaignChecklist(bulkChecked, toggleCampaign(setBulkChecked))}
          </>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          void clearTags(selectedEmails());
          clearSelection();
        }}
        title="Clear tags"
        message={`Remove the app tag from ${selected.size} inbox${selected.size === 1 ? "" : "es"}? They become untagged and won't be swapped until tagged again. (Any tag Instantly itself reports is unaffected.)`}
        confirmLabel="Clear tags"
      />
    </div>
  );
}
