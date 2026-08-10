// ---------------------------------------------------------------------------
// Mailboxes currently out of service, and whether they're getting better.
// ---------------------------------------------------------------------------
import { ArrowDownRight, ArrowRight, ArrowUpRight, Undo2, XCircle, Stethoscope } from "lucide-react";
import { Card, Badge } from "../ui/primitives";
import type { RecoveryView, Trend } from "../../lib/recovery";
import { fmtDateShort } from "../../lib/format";

const TREND_ICON: Record<Trend, typeof ArrowRight> = {
  improving: ArrowUpRight,
  declining: ArrowDownRight,
  flat: ArrowRight,
  unknown: ArrowRight,
};

const TREND_TONE: Record<Trend, "mint" | "danger" | "sky" | "white"> = {
  improving: "mint",
  declining: "danger",
  flat: "sky",
  unknown: "white",
};

/** Tiny inline sparkline. No chart library for eight numbers. */
function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 64;
  const h = 18;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

export function RecoveryPanel({
  views,
  minScore,
  onReturn,
  onRetire,
  busy,
}: {
  views: RecoveryView[];
  minScore: number;
  onReturn: (v: RecoveryView) => void;
  onRetire: (v: RecoveryView) => void;
  busy: string | null;
}) {
  const active = views.filter((v) => v.entry.status === "recovering");
  if (active.length === 0) return null;

  const eligible = active.filter((v) => v.eligible).length;

  return (
    <Card className="p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-base font-extrabold">
          <Stethoscope size={16} /> Recovering ({active.length})
        </h3>
        {eligible > 0 ? <Badge tone="mint">{eligible} ready to return</Badge> : null}
      </div>
      <p className="mb-3 text-xs text-muted">
        Pulled out of live campaigns to heal. They're kept out of the spare pool until you return
        them, which is usually the reason the planner says you have no spares.
      </p>

      <div className="space-y-2">
        {active.map((v) => {
          const e = v.entry;
          const TrendIcon = TREND_ICON[v.trend];
          const points = (e.history ?? [])
            .map((h) => h.score)
            .filter((s): s is number => s !== null);
          return (
            <div
              key={e.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-ink bg-canvas p-3 text-xs"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{e.email}</p>
                <p className="text-[11px] text-muted">
                  out {v.daysOut}d · since {fmtDateShort(e.swapped_out_at)} · replaced by{" "}
                  {e.replaced_by || "—"}
                  {e.campaign_names.length ? ` · from ${e.campaign_names.join(", ")}` : ""}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-muted">{v.scoreAtSwap ?? "—"}</span>
                <ArrowRight size={12} />
                <span className="font-bold">{v.scoreNow ?? "—"}</span>
                {v.delta !== null && v.delta !== 0 ? (
                  <Badge tone={v.delta > 0 ? "mint" : "danger"}>
                    {v.delta > 0 ? "+" : ""}
                    {v.delta}
                  </Badge>
                ) : null}
              </div>

              <span className="flex items-center gap-1 text-muted">
                <Spark points={points} />
                <Badge tone={TREND_TONE[v.trend]}>
                  <TrendIcon size={11} /> {v.trend}
                </Badge>
              </span>

              {v.stalled ? (
                <Badge tone="sun">no progress in {v.daysOut}d</Badge>
              ) : v.eligible ? (
                <Badge tone="mint">cleared {minScore} three times</Badge>
              ) : null}

              <div className="ml-auto flex shrink-0 gap-2">
                <button
                  className="btn-ghost btn-sm"
                  disabled={busy === e.id}
                  onClick={() => onReturn(v)}
                  title={
                    v.eligible
                      ? "Score has held above the bar — put it back in the spare pool"
                      : "Score hasn't cleared the bar yet. You can still return it."
                  }
                >
                  <Undo2 size={13} /> Return to service
                </button>
                <button
                  className="btn-ghost btn-sm"
                  disabled={busy === e.id}
                  onClick={() => onRetire(v)}
                  title="Stop offering this mailbox entirely"
                >
                  <XCircle size={13} /> Retire
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
