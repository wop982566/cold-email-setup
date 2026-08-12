// ---------------------------------------------------------------------------
// What the daily swapper did while you weren't looking.
//
// An automation that edits live campaigns and leaves no visible trace is one
// you can't trust and can't debug. Every run lands here, including the runs
// that did nothing and the runs that crashed — so silence in this panel always
// means "nothing to report", never "the cron died three weeks ago".
// ---------------------------------------------------------------------------
import { useState } from "react";
import { Bot, ArrowRight, AlertTriangle, Check, PlayCircle, Mail } from "lucide-react";
import { Card, Badge, Details, Spinner } from "../ui/primitives";
import type { AutoSwapRun } from "../../lib/types";
import { autoSwap } from "../../lib/instantly";
import { fmtDateShort } from "../../lib/format";

/**
 * Render a dry-run result as something readable.
 *
 * The point is to separate the ways "nothing happened" can happen — everything
 * healthy, Instantly returned nothing, or every candidate was skipped — because
 * they look identical from outside and need completely different fixes.
 */
function dryRunSummary(r: Record<string, unknown>): string {
  if (r.ok === false) return `Failed: ${String(r.error ?? "unknown error")}`;
  const reach = r.reachedInstantly as { mailboxes: number; campaigns: number; note: string };
  const health = r.healthSummary as { proposals: number; healthySpares: number; shortfall: number };
  const would = (r.wouldSwap ?? []) as { from: string; to: string; campaigns: string[] }[];
  const skip = (r.wouldSkip ?? []) as { email: string; reason: string }[];

  const out = [
    `Instantly: ${reach?.mailboxes ?? 0} mailboxes, ${reach?.campaigns ?? 0} campaigns${
      reach?.note && reach.note !== "ok" ? ` — ${reach.note}` : ""
    }`,
    `Writes enabled: ${r.writesEnabled ? "yes" : `NO — ${String(r.writesHint ?? "")}`}`,
    `Flagged: ${health?.proposals ?? 0} needing replacement, ${health?.healthySpares ?? 0} healthy spares`,
    "",
  ];
  if (would.length > 0) {
    out.push(`WOULD SWAP (${would.length}):`);
    for (const w of would) out.push(`  ${w.from} → ${w.to}  (${w.campaigns.join(", ")})`);
  } else {
    out.push("WOULD SWAP: nothing.");
  }
  if (skip.length > 0) {
    out.push("", "Skipped:");
    for (const s of skip) out.push(`  ${s.email}: ${s.reason}`);
  }
  if (Number(r.overCap ?? 0) > 0) out.push("", `${r.overCap} more were over the per-run cap.`);
  out.push("", "Nothing was written. This was a dry run.");
  return out.join("\n");
}

/** Newest first, and only the handful worth scrolling. */
export function AutoSwapLog({ runs, limit = 5 }: { runs: AutoSwapRun[]; limit?: number }) {
  const [testing, setTesting] = useState<"dryRun" | "testEmail" | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function runDry() {
    setTesting("dryRun");
    setResult(null);
    const r = await autoSwap.dryRun();
    setResult(dryRunSummary(r));
    setTesting(null);
  }

  async function sendTest() {
    setTesting("testEmail");
    setResult(null);
    const r = await autoSwap.testEmail();
    setResult(
      r.ok
        ? `Email sent — ${String(r.detail)}.\nCheck ${String(r.to)}; it may take a minute.`
        : `Email NOT sent.\n\n${String(r.detail ?? r.error)}\n\nKey configured: ${
            r.keyConfigured ? "yes" : "no — RESEND_API_KEY is missing"
          }\nFrom: ${String(r.from ?? "(not set)")}\nTo: ${String(r.to ?? "(not set)")}`,
    );
    setTesting(null);
  }

  const recent = [...runs]
    .sort((a, b) => (b.ran_at ?? "").localeCompare(a.ran_at ?? ""))
    .slice(0, limit);
  const lastChange = recent.find((r) => r.applied.length > 0 || r.failed.length > 0);

  return (
    <Card className="p-3 text-xs">
      <p className="flex items-center gap-2 text-sm font-extrabold">
        <Bot size={15} /> Automatic swaps
      </p>
      <p className="mt-0.5 text-[11px] text-muted">
        {lastChange
          ? `Last change ${fmtDateShort(lastChange.ran_at)}. Undo any of these from the archive below.`
          : runs.length > 0
            ? "Running daily. Nothing has needed swapping yet."
            : "Runs daily. It hasn't run yet — use the dry run below to see what it would do."}
      </p>

      {/* Without these the only way to find out whether any of this works is to
          wait for the cron and hope. The dry run writes nothing. */}
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn-ghost btn-sm" onClick={() => void runDry()} disabled={testing !== null}>
          {testing === "dryRun" ? <Spinner /> : <PlayCircle size={14} />} Test now (dry run)
        </button>
        <button className="btn-ghost btn-sm" onClick={() => void sendTest()} disabled={testing !== null}>
          {testing === "testEmail" ? <Spinner /> : <Mail size={14} />} Send test email
        </button>
      </div>

      {result ? (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border-2 border-ink bg-white p-2 text-[11px]">
          {result}
        </pre>
      ) : null}

      <div className="mt-2 space-y-1.5">
        {recent.map((run) => {
          const quiet = run.applied.length === 0 && run.failed.length === 0;
          return (
            <div key={run.id} className="rounded-lg border-2 border-ink bg-canvas p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{fmtDateShort(run.ran_at)}</span>
                {run.applied.length > 0 ? (
                  <Badge tone="mint">
                    {run.applied.length} swapped
                  </Badge>
                ) : null}
                {run.failed.length > 0 ? (
                  <Badge tone="danger">{run.failed.length} failed</Badge>
                ) : null}
                {quiet ? (
                  <span className="flex items-center gap-1 text-muted">
                    <Check size={12} /> nothing needed
                  </span>
                ) : null}
                {/* Being at the cap is not an error, but it does mean more was
                    wrong than the run was allowed to fix. */}
                {run.deferred > 0 ? (
                  <Badge tone="sun">{run.deferred} over the cap</Badge>
                ) : null}
              </div>

              {run.applied.map((a, i) => (
                <p key={i} className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="font-semibold">{a.from}</span>
                  <ArrowRight size={11} />
                  <span className="font-semibold">{a.to}</span>
                  <span className="text-muted">on {a.campaigns.join(", ")}</span>
                </p>
              ))}

              {run.failed.map((f, i) => (
                <p key={i} className="mt-1 flex items-start gap-1.5 text-danger">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  {f}
                </p>
              ))}

              {(run.skipped ?? []).length > 0 || (run.log ?? []).length > 0 ? (
                <Details summary="Full run detail">
                  {(run.skipped ?? []).length > 0 ? (
                    <ul className="mb-1 space-y-0.5 text-[11px] text-muted">
                      {run.skipped.map((s, i) => (
                        <li key={i}>
                          <b>{s.email}</b>: {s.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mb-1 text-[11px] text-muted">Email: {run.notification}</p>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border-2 border-ink bg-white p-2 text-[11px]">
                    {(run.log ?? []).join("\n")}
                  </pre>
                </Details>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
