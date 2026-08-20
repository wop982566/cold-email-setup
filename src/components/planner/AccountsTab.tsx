// ---------------------------------------------------------------------------
// The Accounts tab: every inbox, its niche tag, and — once verified — the exact
// campaigns it can be swapped into.
//
// The tag you attach here is written to the app's `mailbox_tags` table, which
// is the source of truth the swapper reads (unioned with Instantly's tags when
// that endpoint resolves). Verify recomputes eligibility with the SAME rule the
// maintenance/cron swap path uses (accountsTag.eligibleCampaignsFor), so what
// this tab shows is exactly what a swap would honour — no second opinion.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Tag, Check, ShieldCheck, AlertTriangle } from "lucide-react";
import { Card, Badge, Spinner, StatCard } from "../ui/primitives";
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
  type ResolvedCampaign,
  type CampaignLite,
} from "../../lib/accountsTag";

export function AccountsTab({
  emails,
  campaigns,
  overrides,
  instantlyTagsByEmail,
  instantlyTagsByCampaign,
  allInstantlyTags,
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

  // Verified eligibility, keyed by email — populated on demand, never stale-hidden.
  const [verified, setVerified] = useState<Map<string, ResolvedCampaign[]>>(new Map());
  const [draft, setDraft] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);

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
      toast.push(
        tags.length === 0
          ? `${email} is untagged — eligible for no campaigns`
          : `${email} (${tags.join(", ")}) matches no campaign's tag`,
        "info",
      );
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Inboxes" value={coverage.total} tone="pink" icon={<Tag size={18} />} />
        <StatCard label="Tagged" value={coverage.tagged} tone="mint" sublabel="swap-eligible" />
        <StatCard label="Untagged" value={coverage.untagged} tone="sun" sublabel="can't be swapped" />
        <StatCard label="Campaigns w/ a tag" value={resolved.filter((c) => c.tags.length > 0).length} tone="sky" />
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink p-4">
          <div>
            <h3 className="text-base font-extrabold">Accounts &amp; swap eligibility</h3>
            <p className="text-xs text-muted">
              Tag an inbox, then Verify to see which campaigns it can be swapped into — the
              same tag rule the swapper enforces.
            </p>
          </div>
          <button className="btn-ghost btn-sm" onClick={verifyAll}>
            <ShieldCheck size={14} /> Verify all
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted">No connected inboxes yet.</p>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                  <th className="px-3 py-2">Inbox</th>
                  <th className="w-28 px-3 py-2">Current tag</th>
                  <th className="w-64 px-3 py-2">Tag / retag</th>
                  <th className="px-3 py-2">Eligible campaigns (verify)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const elig = verified.get(r.email.toLowerCase());
                  const pick = draft.get(r.email) ?? "";
                  return (
                    <tr key={r.email} className="border-b border-ink/10 align-top">
                      <td className="px-3 py-2 font-semibold">{r.email}</td>
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
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {elig === undefined ? (
                          <span className="text-muted">— not verified —</span>
                        ) : elig.length === 0 ? (
                          <span className="text-muted">
                            {r.tags.length === 0 ? "untagged — nothing" : "no campaign matches this tag"}
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {elig.map((c) => (
                              <span key={c.id} title={`tags: ${c.tags.join(", ")}`}>
                                <Badge tone="sky">{c.name}</Badge>
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

      {/* Live tag options for every row's datalist. */}
      <datalist id="acct-tag-options">
        {tagOptions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}
