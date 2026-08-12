// ---------------------------------------------------------------------------
// Every swap ever applied, and a way to reverse one.
//
// The maintenance panel only ever showed mailboxes still healing, so the moment
// one was released or retired its record vanished. This is the permanent log,
// and the only place a swap can actually be undone — "Return to service" marks
// a mailbox as available for FUTURE swaps, it never puts it back.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { Archive, ArrowRight, Undo2, Eye, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { Card, Badge, Spinner } from "../ui/primitives";
import {
  archiveCounts,
  filterArchive,
  type ArchiveFilter,
  type ArchiveRow,
} from "../../lib/recovery";
import type { RecoveryStatus } from "../../lib/types";
import { fmtDateShort } from "../../lib/format";
import { cn } from "../../lib/utils";

const STATUS_TONE: Record<RecoveryStatus, "sun" | "sky" | "mint" | "white"> = {
  recovering: "sun",
  recovered: "sky",
  restored: "mint",
  retired: "white",
};

const STATUS_LABEL: Record<RecoveryStatus, string> = {
  recovering: "out, healing",
  recovered: "back in the pool",
  restored: "swapped back",
  retired: "retired",
};

const FILTERS: ArchiveFilter[] = ["all", "recovering", "recovered", "restored", "retired"];

/** Score at swap → score now, when there's anything to compare. */
function ScoreDelta({ then: at, now }: { then: number | null; now: number | null }) {
  if (at === null && now === null) return <span className="text-muted">no score</span>;
  const delta = at !== null && now !== null ? now - at : null;
  return (
    <span className="flex items-center gap-1">
      <span className="text-muted">{at ?? "—"}</span>
      <ArrowRight size={11} />
      <span className="font-bold">{now ?? "—"}</span>
      {delta !== null && delta !== 0 ? (
        <Badge tone={delta > 0 ? "mint" : "danger"}>
          {delta > 0 ? "+" : ""}
          {delta}
        </Badge>
      ) : null}
    </span>
  );
}

export function SwapArchive({
  rows,
  onUndo,
  onPreview,
  busy,
  preview,
}: {
  rows: ArchiveRow[];
  onUndo: (row: ArchiveRow) => void;
  onPreview: (row: ArchiveRow) => void;
  busy: string | null;
  preview: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<ArchiveFilter>("all");

  if (rows.length === 0) return null;

  const counts = archiveCounts(rows);
  const shown = filterArchive(rows, filter);

  return (
    <Card className="overflow-hidden p-0">
      <button
        className="flex w-full items-center justify-between p-4 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <h3 className="flex items-center gap-2 text-base font-extrabold">
            <Archive size={16} /> Swap archive ({rows.length})
          </h3>
          <p className="text-xs text-muted">
            Every mailbox you've swapped out, and what happened to it. Swap one back from
            here — this is the only place that actually reverses a swap in Instantly.
          </p>
        </div>
        {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
      </button>

      {open ? (
        <div className="border-t-2 border-ink/10 p-4">
          <div className="mb-3 flex flex-wrap gap-1.5">
            {FILTERS.filter((f) => f === "all" || counts[f] > 0).map((f) => (
              <button
                key={f}
                className={cn("chip", filter === f && "bg-ink text-white")}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : STATUS_LABEL[f as RecoveryStatus]} ({counts[f]})
              </button>
            ))}
          </div>

          <div className="space-y-2">
            {shown.map((row) => {
              const e = row.entry;
              const isBusy = busy === e.id;
              return (
                <div key={e.id} className="rounded-xl border-2 border-ink bg-canvas p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
                    <span className="font-bold">{e.email}</span>
                    <ArrowRight size={12} />
                    <span className="font-semibold">{e.replaced_by || "—"}</span>
                    <span className="text-muted">
                      {fmtDateShort(e.swapped_out_at)} · {row.daysSince}d ago
                    </span>
                    <ScoreDelta then={row.scoreAtSwap} now={row.scoreNow} />

                    <div className="ml-auto flex shrink-0 gap-2">
                      {row.canUndo ? (
                        <>
                          <button
                            className="btn-ghost btn-sm"
                            disabled={isBusy}
                            onClick={() => onPreview(row)}
                            title="Show exactly what would change, without changing it"
                          >
                            <Eye size={13} /> Preview
                          </button>
                          <button
                            className="btn-ghost btn-sm"
                            disabled={isBusy}
                            onClick={() => onUndo(row)}
                            title={`Remove ${e.replaced_by} and put ${e.email} back`}
                          >
                            {isBusy ? <Spinner /> : <Undo2 size={13} />} Swap back
                          </button>
                        </>
                      ) : (
                        <span className="text-muted">{row.undoBlockedReason}</span>
                      )}
                    </div>
                  </div>

                  <p className="mt-1 text-[11px] text-muted">
                    {e.campaign_names.length > 0
                      ? `From ${e.campaign_names.join(", ")}`
                      : `${e.campaign_ids.length} campaign${e.campaign_ids.length === 1 ? "" : "s"}`}
                    {e.reason ? ` · pulled for: ${e.reason}` : ""}
                    {/* Rows written before this feature existed have no
                        restored_* fields, so every read tolerates their absence. */}
                    {e.status === "restored" && e.restored_at
                      ? ` · swapped back ${fmtDateShort(e.restored_at)}${
                          (e.restored_campaigns ?? []).length < e.campaign_ids.length
                            ? ` (${(e.restored_campaigns ?? []).length} of ${e.campaign_ids.length} campaigns)`
                            : ""
                        }`
                      : ""}
                  </p>

                  {/* The reason it was pulled may still apply. Say so; don't block. */}
                  {row.canUndo && row.stillUnhealthy ? (
                    <p className="mt-1.5 flex items-start gap-1.5 rounded-lg border-2 border-ink bg-sun/30 p-2 text-[11px] font-semibold">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      Still at {row.scoreNow} — below the score it was pulled for. Swapping it
                      back puts the original problem back into a live campaign.
                    </p>
                  ) : null}

                  {preview.has(e.id) ? (
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border-2 border-ink bg-white p-2 text-[11px]">
                      {preview.get(e.id)}
                    </pre>
                  ) : null}
                </div>
              );
            })}
            {shown.length === 0 ? (
              <p className="text-xs text-muted">Nothing with that status.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
