// ---------------------------------------------------------------------------
// What the daily swapper did while you weren't looking.
//
// An automation that edits live campaigns and leaves no visible trace is one
// you can't trust and can't debug. Every run lands here, including the runs
// that did nothing and the runs that crashed — so silence in this panel always
// means "nothing to report", never "the cron died three weeks ago".
// ---------------------------------------------------------------------------
import { Bot, ArrowRight, AlertTriangle, Check } from "lucide-react";
import { Card, Badge, Details } from "../ui/primitives";
import type { AutoSwapRun } from "../../lib/types";
import { fmtDateShort } from "../../lib/format";

/** Newest first, and only the handful worth scrolling. */
export function AutoSwapLog({ runs, limit = 5 }: { runs: AutoSwapRun[]; limit?: number }) {
  if (runs.length === 0) return null;

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
          : "Running daily. Nothing has needed swapping yet."}
      </p>

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
