// ---------------------------------------------------------------------------
// Preview live Instantly inbox settings, then push chosen changes in bulk.
//
// Reads existing accounts (never creates), scoped to the current batch's
// domains. You pick which fields to change and their values, preview the exact
// diff (a dry run that writes nothing), then apply — one PATCH per inbox, each
// result surfaced. Tags and the warmup filter tag are written back under the
// key the live account exposes them under; when the account doesn't expose one,
// the field is skipped with a reason rather than guessed.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Eye, Zap, ChevronDown, ChevronRight } from "lucide-react";
import { Card, Badge, Spinner, Details, Toggle } from "../ui/primitives";
import { Field, TextField } from "../ui/Field";
import { useToast } from "../ui/toast";
import { instantly, asItems } from "../../lib/instantly";
import {
  accountUpdatePayload,
  liveInboxRow,
  inboxesForDomains,
  hasAnyField,
  type UpdateFields,
  type LiveAccount,
} from "../../lib/inboxUpdate";
import { formatCreateError } from "../../lib/writeResult";

function numOrUndef(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

export function InboxBulkUpdate({
  domains,
  trackingPrefix,
}: {
  /** Lowercased domains of the current batch — scopes which inboxes show. */
  domains: string[];
  trackingPrefix: string;
}) {
  const toast = useToast();

  // Shares the ["inst","acct"] cache with the planner/insights pages.
  const acctQ = useQuery({
    queryKey: ["inst", "acct"],
    queryFn: () => instantly.accounts(),
    staleTime: 60_000,
  });

  const domainSet = useMemo(() => new Set(domains.map((d) => d.trim().toLowerCase())), [domains]);
  const accounts = useMemo(() => {
    const all = acctQ.data?.ok ? asItems<LiveAccount>(acctQ.data.data) : [];
    return inboxesForDomains(all, domainSet);
  }, [acctQ.data, domainSet]);

  // --- field toggles + values ------------------------------------------------
  const [setTracking, setSetTracking] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [setLast, setSetLast] = useState(false);
  const [dailyLimit, setDailyLimit] = useState("");
  const [wLimit, setWLimit] = useState("");
  const [wIncrement, setWIncrement] = useState("");
  const [wReply, setWReply] = useState("");
  const [filterTag, setFilterTag] = useState("");
  const [setFilterTag_, setSetFilterTag] = useState(false);
  const [tagsText, setTagsText] = useState("");
  const [setTags, setSetTags] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fields: UpdateFields = useMemo(() => {
    const f: UpdateFields = {};
    if (setTracking) f.trackingDomain = { enabled: true, prefix: trackingPrefix };
    if (firstName.trim() !== "") f.firstName = firstName;
    if (setLast) f.lastName = lastName;
    if (numOrUndef(dailyLimit) !== undefined) f.dailyLimit = numOrUndef(dailyLimit);
    const warmup: NonNullable<UpdateFields["warmup"]> = {};
    if (numOrUndef(wLimit) !== undefined) warmup.limit = numOrUndef(wLimit);
    if (numOrUndef(wIncrement) !== undefined) warmup.increment = numOrUndef(wIncrement);
    if (numOrUndef(wReply) !== undefined) warmup.replyRate = numOrUndef(wReply);
    if (Object.keys(warmup).length) f.warmup = warmup;
    if (setFilterTag_) f.warmupFilterTag = filterTag.trim();
    if (setTags) f.tags = tagsText.split(",").map((t) => t.trim()).filter(Boolean);
    return f;
  }, [
    setTracking, trackingPrefix, firstName, setLast, lastName, dailyLimit,
    wLimit, wIncrement, wReply, setFilterTag_, filterTag, setTags, tagsText,
  ]);

  const targets = useMemo(() => {
    // Default to every in-scope inbox until the operator narrows the selection.
    if (selected.size === 0) return accounts;
    return accounts.filter((a) => selected.has(String(a.email ?? "").toLowerCase()));
  }, [accounts, selected]);

  function toggleSel(email: string) {
    setSelected((s) => {
      const n = new Set(s);
      const k = email.toLowerCase();
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  }

  async function run(dryRun: boolean) {
    if (!hasAnyField(fields)) {
      toast.push("Turn on at least one field to change", "error");
      return;
    }
    if (targets.length === 0) {
      toast.push("No inboxes selected", "error");
      return;
    }
    if (!dryRun && !window.confirm(`Push these settings to ${targets.length} inbox(es)?`)) return;

    setBusy(true);
    const out: string[] = [];
    for (const acct of targets) {
      const email = String(acct.email ?? "");
      const { patch, skipped } = accountUpdatePayload(email, fields, acct);
      for (const s of skipped) out.push(`  · skipped ${s.field} on ${email}: ${s.reason}`);
      if (Object.keys(patch).length === 0) {
        out.push(`${email}: nothing to send`);
        setResults([...out]);
        continue;
      }
      const res = await instantly.updateAccountFields(email, patch, dryRun);
      if (res.ok) {
        out.push(
          dryRun
            ? `${email} → ${JSON.stringify(res.payload ?? patch)}`
            : `updated ${email}`,
        );
      } else {
        out.push(`FAILED ${formatCreateError(email, res)}`);
      }
      setResults([...out]);
      if (res.writesDisabled) {
        out.push("Stopped: writes are disabled (INSTANTLY_WRITE_ENABLED).");
        setResults([...out]);
        break;
      }
    }
    setBusy(false);
    if (!dryRun) void acctQ.refetch();
  }

  if (domains.length === 0) {
    return (
      <Card className="p-4 text-sm text-muted">
        Add domains to this batch to preview and update their inboxes.
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-extrabold">Live inboxes ({accounts.length})</h3>
          <p className="text-xs text-muted">
            Current Instantly settings for this batch's domains. Update existing inboxes —
            this never creates one.
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={() => void acctQ.refetch()} disabled={acctQ.isFetching}>
          {acctQ.isFetching ? <Spinner /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>

      {acctQ.isLoading ? (
        <div className="mt-3"><Spinner label="Loading inboxes…" /></div>
      ) : accounts.length === 0 ? (
        <p className="mt-3 text-xs text-muted">
          No connected Instantly inboxes on this batch's domains yet.
        </p>
      ) : (
        <div className="mt-3 max-h-72 overflow-auto rounded-lg border-2 border-ink">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="border-b-2 border-ink bg-canvas uppercase">
                <th className="w-8 px-2 py-2"></th>
                <th className="px-2 py-2">Inbox</th>
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Daily</th>
                <th className="px-2 py-2">Warmup L/I/R</th>
                <th className="px-2 py-2">Tracking</th>
                <th className="px-2 py-2">Filter tag</th>
                <th className="px-2 py-2">Tags</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const row = liveInboxRow(a);
                const key = row.email.toLowerCase();
                const isOpen = expanded === key;
                return (
                  <tr key={key} className="border-b border-ink/10 align-top">
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-ink"
                        checked={selected.size === 0 || selected.has(key)}
                        onChange={() => toggleSel(row.email)}
                        title="Include this inbox in the update"
                      />
                    </td>
                    <td className="px-2 py-2 font-semibold">
                      <button
                        className="flex items-center gap-1 text-left"
                        onClick={() => setExpanded(isOpen ? null : key)}
                      >
                        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        {row.email}
                      </button>
                      {isOpen ? (
                        <pre className="mt-1 max-w-[40ch] overflow-x-auto whitespace-pre-wrap rounded border border-ink/30 bg-white p-1 text-[10px]">
                          {JSON.stringify(a, null, 1)}
                        </pre>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">{[row.firstName, row.lastName].filter(Boolean).join(" ") || "—"}</td>
                    <td className="px-2 py-2">{row.dailyLimit ?? "—"}</td>
                    <td className="px-2 py-2">
                      {[row.warmupLimit, row.warmupIncrement, row.warmupReplyRate].map((v) => v ?? "—").join(" / ")}
                    </td>
                    <td className="px-2 py-2">{row.trackingDomain ?? <span className="text-muted">none</span>}</td>
                    <td className="px-2 py-2">{row.warmupFilterTag ?? "—"}</td>
                    <td className="px-2 py-2">{row.tags.length ? row.tags.join(", ") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* --- the changes to push ------------------------------------------- */}
      <div className="mt-4 rounded-xl border-2 border-ink bg-canvas p-3">
        <p className="text-sm font-bold">Bulk update — only ticked fields are sent</p>
        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex items-center gap-2 text-xs">
            <Toggle checked={setTracking} onChange={setSetTracking} />
            Tracking domain → <code>{trackingPrefix}.&lt;each domain&gt;</code>
          </label>

          <Field label="First name (blank = leave alone)">
            <TextField value={firstName} onChange={setFirstName} placeholder="Tanuj" />
          </Field>

          <label className="flex items-center gap-2 text-xs">
            <Toggle checked={setLast} onChange={setSetLast} />
            Set last name
            <input
              className="input h-8 w-32 text-xs"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="S."
              disabled={!setLast}
            />
          </label>

          <Field label="Daily sending limit (blank = leave alone)">
            <TextField value={dailyLimit} onChange={setDailyLimit} placeholder="15" />
          </Field>

          <div className="flex items-end gap-2">
            <Field label="Warmup limit"><TextField value={wLimit} onChange={setWLimit} placeholder="15" /></Field>
            <Field label="Increment"><TextField value={wIncrement} onChange={setWIncrement} placeholder="2" /></Field>
            <Field label="Reply %"><TextField value={wReply} onChange={setWReply} placeholder="50" /></Field>
          </div>

          <label className="flex items-center gap-2 text-xs">
            <Toggle checked={setFilterTag_} onChange={setSetFilterTag} />
            Warmup filter tag
            <input
              className="input h-8 w-40 text-xs"
              value={filterTag}
              onChange={(e) => setFilterTag(e.target.value)}
              placeholder="life-is-simple"
              disabled={!setFilterTag_}
            />
          </label>

          <label className="flex items-center gap-2 text-xs">
            <Toggle checked={setTags} onChange={setSetTags} />
            Tags (comma-sep)
            <input
              className="input h-8 w-40 text-xs"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="AEO, US"
              disabled={!setTags}
            />
          </label>
        </div>

        {/* These two may need the live-JSON key; say so honestly. */}
        {(setTags || setFilterTag_) ? (
          <Details summary="About tags & filter tag">
            <p className="text-[11px] text-muted">
              These are written back under the exact field name your live inbox uses (open a
              row above to see its JSON). If an inbox doesn't expose that field, it's skipped
              with a reason in the results below rather than sent as a guess.
            </p>
          </Details>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">
            {selected.size === 0 ? `all ${accounts.length}` : `${targets.length}`} inbox(es) targeted
          </span>
          <button className="btn-ghost btn-sm ml-auto" disabled={busy} onClick={() => void run(true)}>
            <Eye size={14} /> Preview changes
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => void run(false)}>
            {busy ? <Spinner /> : <Zap size={14} />} Apply
          </button>
        </div>
      </div>

      {results.length > 0 ? (
        <pre
          className={
            "mt-3 max-h-56 overflow-auto rounded-lg border-2 border-ink p-2 text-[11px] " +
            (results.some((l) => l.startsWith("FAILED")) ? "bg-danger/10" : "bg-canvas")
          }
        >
          {results.join("\n")}
        </pre>
      ) : null}
    </Card>
  );
}
