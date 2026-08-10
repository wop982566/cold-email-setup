import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Card, Badge } from "../ui/primitives";
import { Lead } from "../../lib/types";
import { instantly, asItems, InstantlyLead } from "../../lib/instantly";
import { cn } from "../../lib/utils";

interface Match {
  lead: Lead;
  remote: InstantlyLead;
}

/**
 * Cross-checks the given leads against every lead/contact already in the
 * connected Instantly workspace and lets the operator mark the overlaps as
 * "used" (so they won't be re-sent to). Read-only against Instantly.
 */
export function InstantlyDupeModal({
  leads,
  scopeLabel,
  onClose,
  onMarkUsed,
}: {
  leads: Lead[];
  scopeLabel: string;
  onClose: () => void;
  onMarkUsed: (ids: string[], campaignId?: string) => Promise<void>;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [remote, setRemote] = useState<InstantlyLead[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [campaignNames, setCampaignNames] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  // "contacted" = only count a match when Instantly has actually emailed the
  // lead; "any" = count any contact present in the workspace.
  const [mode, setMode] = useState<"contacted" | "any">("contacted");

  async function load() {
    setLoading(true);
    setError(null);
    const [res, camp] = await Promise.all([instantly.workspaceLeads(), instantly.campaigns()]);
    setLoading(false);
    if (!res.ok || !res.data) {
      setConfigured(res.configured !== false);
      setError(res.error ?? "Could not reach Instantly.");
      return;
    }
    setRemote(res.data.items);
    setTruncated(res.data.truncated);
    if (camp.ok) {
      const map: Record<string, string> = {};
      for (const c of asItems<{ id?: string; name?: string }>(camp.data)) {
        if (c.id) map[c.id] = c.name ?? c.id;
      }
      setCampaignNames(map);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Emails present in Instantly at all (used for the "any" count + context).
  const presentCount = useMemo(() => {
    if (remote.length === 0) return 0;
    const byEmail = new Set(remote.map((r) => r.email));
    let n = 0;
    for (const l of leads) if (byEmail.has(l.email.trim().toLowerCase())) n++;
    return n;
  }, [remote, leads]);

  const matches = useMemo<Match[]>(() => {
    if (remote.length === 0) return [];
    const byEmail = new Map(remote.map((r) => [r.email, r]));
    const out: Match[] = [];
    for (const l of leads) {
      const e = l.email.trim().toLowerCase();
      const r = e ? byEmail.get(e) : undefined;
      if (!r) continue;
      if (mode === "contacted" && !r.contacted) continue;
      out.push({ lead: l, remote: r });
    }
    return out;
  }, [remote, leads, mode]);

  // Default: pre-select every duplicate that isn't already marked used.
  useEffect(() => {
    setPicked(new Set(matches.filter((m) => m.lead.status !== "used").map((m) => m.lead.id)));
  }, [matches]);

  const alreadyUsed = matches.filter((m) => m.lead.status === "used").length;

  function toggle(id: string) {
    setPicked((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function mark() {
    setWorking(true);
    try {
      await onMarkUsed(Array.from(picked));
      onClose();
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Cross-check with Instantly"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
          <button
            className="btn-dark"
            onClick={mark}
            disabled={working || picked.size === 0}
            title="Set these leads to status 'used' so they won't be emailed again"
          >
            <CheckCircle2 size={16} /> Mark {picked.size} as used
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Comparing <span className="font-bold text-ink">{leads.length}</span> leads in {scopeLabel} against the
          contacts in your Instantly workspace. Mark the overlaps <span className="font-bold">used</span> here to keep
          them out of future sends.
        </p>

        {/* What counts as a duplicate */}
        <div className="rounded-xl border-2 border-ink bg-canvas p-2">
          <p className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-muted">Count as a duplicate when…</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            <label
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-lg border-2 p-2 text-sm",
                mode === "contacted" ? "border-ink bg-sun" : "border-transparent hover:bg-white",
              )}
            >
              <input
                type="radio"
                className="mt-0.5"
                checked={mode === "contacted"}
                onChange={() => setMode("contacted")}
              />
              <span>
                <span className="font-bold">Instantly already emailed them</span>
                <span className="block text-xs text-muted">Contacted / opened / replied / sequence done.</span>
              </span>
            </label>
            <label
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-lg border-2 p-2 text-sm",
                mode === "any" ? "border-ink bg-sun" : "border-transparent hover:bg-white",
              )}
            >
              <input type="radio" className="mt-0.5" checked={mode === "any"} onChange={() => setMode("any")} />
              <span>
                <span className="font-bold">Present in the workspace at all</span>
                <span className="block text-xs text-muted">Imported into Instantly, even if not yet sent.</span>
              </span>
            </label>
          </div>
        </div>

        {loading ? (
          <Card className="flex items-center gap-2 p-6 text-sm">
            <RefreshCw size={16} className="animate-spin" /> Loading Instantly contacts… (large workspaces can take a few
            seconds)
          </Card>
        ) : error ? (
          <Card className="space-y-2 border-coral bg-coral/10 p-4 text-sm">
            <p className="flex items-center gap-2 font-bold">
              <AlertTriangle size={16} /> {configured ? "Instantly error" : "Instantly not connected"}
            </p>
            <p>{error}</p>
            {!configured ? (
              <p className="text-muted">
                Add <code>INSTANTLY_API_KEY</code> (a v2 key with read scopes for leads) in your Netlify environment
                variables, redeploy, then try again.
              </p>
            ) : null}
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={matches.length ? "coral" : "mint"}>
                {matches.length} duplicate{matches.length === 1 ? "" : "s"} ({mode === "contacted" ? "emailed" : "in workspace"})
              </Badge>
              {mode === "contacted" && presentCount > matches.length ? (
                <Badge tone="white">
                  +{presentCount - matches.length} present but not yet emailed (ignored)
                </Badge>
              ) : null}
              <Badge tone="white">{remote.length.toLocaleString()} Instantly contacts scanned</Badge>
              {alreadyUsed > 0 ? <Badge tone="lavender">{alreadyUsed} already marked used</Badge> : null}
              {truncated ? (
                <Badge tone="sun">
                  Partial scan — workspace is very large. Refine by campaign or run again for the rest.
                </Badge>
              ) : null}
            </div>

            {matches.length === 0 ? (
              <Card className="flex items-center gap-2 border-mint bg-mint/10 p-6 text-sm font-bold">
                <ShieldCheck size={18} />
                {mode === "contacted"
                  ? presentCount > 0
                    ? `No overlaps — these leads exist in Instantly but none have been emailed yet (${presentCount} present).`
                    : "No overlaps — Instantly hasn't emailed any of these leads."
                  : "No overlaps — none of these leads are in Instantly yet."}
              </Card>
            ) : (
              <Card className="overflow-hidden p-0">
                <div className="flex items-center justify-between border-b-2 border-ink bg-canvas px-3 py-2 text-xs font-bold">
                  <button
                    className="underline"
                    onClick={() =>
                      setPicked((s) =>
                        s.size === matches.length ? new Set() : new Set(matches.map((m) => m.lead.id)),
                      )
                    }
                  >
                    {picked.size === matches.length ? "Deselect all" : "Select all"}
                  </button>
                  <span className="text-muted">{picked.size} selected</span>
                </div>
                <div className="max-h-80 overflow-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <tbody>
                      {matches.map(({ lead, remote }) => (
                        <tr key={lead.id} className="border-b border-ink/10">
                          <td className="w-9 px-2 py-2">
                            <input type="checkbox" checked={picked.has(lead.id)} onChange={() => toggle(lead.id)} />
                          </td>
                          <td className="px-2 py-2">
                            <p className="truncate font-bold">{lead.email}</p>
                            <p className="truncate text-xs text-muted">
                              {[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "—"}
                              {lead.company ? ` · ${lead.company}` : ""}
                            </p>
                          </td>
                          <td className="px-2 py-2 text-xs">
                            <div className="flex flex-wrap items-center gap-1">
                              {remote.campaign ? (
                                <span className="chip">{campaignNames[remote.campaign] ?? "In a campaign"}</span>
                              ) : (
                                <span className="text-muted">In workspace</span>
                              )}
                              {remote.contacted ? (
                                <Badge tone="mint">emailed</Badge>
                              ) : (
                                <Badge tone="white">not emailed</Badge>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            <span
                              className={cn(
                                "badge",
                                lead.status === "used" ? "bg-ink text-white" : "bg-white",
                              )}
                            >
                              {lead.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
