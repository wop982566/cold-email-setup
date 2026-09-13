// ---------------------------------------------------------------------------
// The addresses behind a campaign's health score, worst first.
//
// The campaign badge answers "how healthy is this campaign"; this answers the
// only follow-up question that matters — "which inbox is dragging it down".
// Both read from the same computeMaintenance() result, so the two can never
// disagree about an address.
// ---------------------------------------------------------------------------
import { Badge } from "../ui/primitives";
import type { MailboxHealth, Verdict } from "../../lib/mailboxHealth";
import type { HealthScore } from "../../lib/campaignPlan";
import type { PlacementMap } from "../../lib/placement";
import { fmtNumber } from "../../lib/format";

const VERDICT_TONE: Record<Verdict, "danger" | "sun" | "sky" | "mint" | "lavender"> = {
  replace: "danger",
  attention: "sun",
  watch: "sky",
  ok: "mint",
  ramping: "lavender",
};

const VERDICT_LABEL: Record<Verdict, string> = {
  replace: "replace",
  attention: "attention",
  watch: "watch",
  ok: "healthy",
  ramping: "warming",
};

// Worst first — the whole point is that the problem address is the top row.
const VERDICT_RANK: Record<Verdict, number> = {
  replace: 0,
  attention: 1,
  watch: 2,
  ramping: 3,
  ok: 4,
};

function scoreTone(score: number | null) {
  if (score === null) return "white" as const;
  if (score >= 85) return "mint" as const;
  if (score >= 70) return "sky" as const;
  if (score >= 50) return "sun" as const;
  return "danger" as const;
}

export function CampaignMailboxTable({
  emails,
  health,
  healthByEmail,
  placement,
}: {
  emails: string[];
  health: HealthScore;
  healthByEmail: Map<string, MailboxHealth>;
  placement: PlacementMap | null;
}) {
  const rows = emails
    .map((email) => ({ email, h: healthByEmail.get(email) ?? null }))
    .sort((a, b) => {
      const ra = a.h ? VERDICT_RANK[a.h.verdict] : 2.5;
      const rb = b.h ? VERDICT_RANK[b.h.verdict] : 2.5;
      if (ra !== rb) return ra - rb;
      const sa = a.h?.score ?? 101; // unknown scores sink below real ones
      const sb = b.h?.score ?? 101;
      if (sa !== sb) return sa - sb;
      return a.email.localeCompare(b.email);
    });

  // Composition of the badge, in the same words the maintenance tab uses.
  const counts = rows.reduce(
    (acc, r) => {
      const v = r.h?.verdict;
      if (v === "replace") acc.replace++;
      else if (v === "ramping") acc.warming++;
      else if (v === "ok") acc.healthy++;
      else if (v) acc.attention++;
      else acc.unknown++;
      return acc;
    },
    { healthy: 0, warming: 0, attention: 0, replace: 0, unknown: 0 },
  );

  const summary = [
    counts.healthy ? `${counts.healthy} healthy` : "",
    counts.warming ? `${counts.warming} warming` : "",
    counts.attention ? `${counts.attention} need attention` : "",
    counts.replace ? `${counts.replace} to replace` : "",
    counts.unknown ? `${counts.unknown} not in the plan` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  if (rows.length === 0) {
    return <p className="text-xs text-muted">No mailboxes attached to this campaign.</p>;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <p className="text-xs font-bold uppercase text-muted">
          Mailboxes sending this campaign ({rows.length})
        </p>
        <p className="text-[11px] text-muted">{summary}</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left text-xs">
          <thead>
            <tr className="uppercase text-muted">
              <th className="py-1.5 pr-3">Address</th>
              <th className="w-16 py-1.5 pr-3">Score</th>
              <th className="w-20 py-1.5 pr-3">State</th>
              <th className="w-20 py-1.5 pr-3">Inbox</th>
              <th className="w-16 py-1.5 pr-3">Age</th>
              <th className="w-16 py-1.5 pr-3">Limit</th>
              <th className="w-20 py-1.5 pr-3">Shared</th>
              <th className="py-1.5">Issues</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ email, h }) => {
              const place = placement?.get(email) ?? null;
              return (
                <tr key={email} className="border-t border-ink/10">
                  <td className="py-1.5 pr-3 font-semibold">{email}</td>
                  <td className="py-1.5 pr-3">
                    {h?.score == null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <Badge tone={scoreTone(h.score)}>{h.score}</Badge>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {h ? (
                      <Badge tone={VERDICT_TONE[h.verdict]}>{VERDICT_LABEL[h.verdict]}</Badge>
                    ) : (
                      <span className="text-muted" title="Not in the planner's mailbox set">
                        —
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {place?.inboxRate == null ? (
                      <span className="text-muted" title="No warmup placement data reported">
                        not checked
                      </span>
                    ) : (
                      <span
                        className={place.inboxRate < 80 ? "font-bold text-danger" : ""}
                        title={`${fmtNumber(place.inbox)} inbox / ${fmtNumber(place.spam)} spam`}
                      >
                        {Math.round(place.inboxRate)}%
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    {h?.ageDays == null ? <span className="text-muted">—</span> : `${h.ageDays}d`}
                  </td>
                  <td className="py-1.5 pr-3">{h ? fmtNumber(h.box.dailyLimit) : "—"}</td>
                  <td className="py-1.5 pr-3">
                    {h && h.box.shareCount > 1 ? (
                      <Badge tone="sun">{h.box.shareCount} campaigns</Badge>
                    ) : (
                      <span className="text-muted">just this</span>
                    )}
                  </td>
                  <td className="py-1.5">
                    {!h || h.issues.length === 0 ? (
                      <span className="text-muted">none</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {h.issues.map((i) => (
                          <Badge
                            key={i.code}
                            tone={i.severity === "critical" ? "danger" : i.severity === "warn" ? "sun" : "sky"}
                          >
                            {i.label}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {health.placementChecked < rows.length ? (
        <p className="mt-2 text-[11px] text-muted">
          Placement measured for {health.placementChecked} of {rows.length} — the rest have no
          warmup data yet, so they're scored on warmup score alone.
        </p>
      ) : null}
    </div>
  );
}
