// ---------------------------------------------------------------------------
// Asking the swapper questions, over HTTP.
//
// Deliberately has NO `config.schedule` export. That is the entire reason this
// file exists: Netlify does not serve scheduled functions over HTTP, so the
// dry-run and test-email paths could never be reached while they lived on
// auto-swap.mts. Adding a schedule here would silently break them again.
//
// Both modes are read-only with respect to campaigns: dryRun writes nothing at
// all, and testEmail sends one message without touching Instantly.
// ---------------------------------------------------------------------------
import { getStore } from "@netlify/blobs";
import { runAutoSwap } from "./_autoSwapRun.js";

const STORE = "cec-data";
const RUNS_TABLE = "auto_swap_runs";

/**
 * Has the SCHEDULED function ever actually run?
 *
 * The question behind "is auto-swapping working", and one the dry run can't
 * answer by itself — a dry run proves the logic works, not that Netlify is
 * firing the schedule. Read from the run log the cron writes.
 */
async function scheduleEvidence(): Promise<Record<string, unknown>> {
  try {
    const rows = ((await getStore(STORE).get(RUNS_TABLE, { type: "json" })) ?? []) as {
      ran_at?: string;
    }[];
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        hasEverRun: false,
        note:
          "The daily scheduled function has never recorded a run. If this persists past " +
          "24h, check that this branch is the PRODUCTION branch in Netlify — scheduled " +
          "functions only fire on production deploys, never branch deploys or previews.",
      };
    }
    const last = [...rows].sort((a, b) => (b.ran_at ?? "").localeCompare(a.ran_at ?? ""))[0];
    return { hasEverRun: true, runsRecorded: rows.length, lastRunAt: last?.ran_at ?? null };
  } catch (err) {
    return {
      hasEverRun: null,
      note: `Couldn't read the run log: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  // Default to a dry run: this endpoint exists to be asked questions, and the
  // safe answer is the right default if the query string is ever dropped.
  if (!url.searchParams.get("dryRun") && !url.searchParams.get("testEmail")) {
    url.searchParams.set("dryRun", "1");
  }

  const res = await runAutoSwap(new Request(url.toString(), { method: "POST", headers: req.headers }));

  // Fold in the schedule evidence, so one press answers both "does the logic
  // work" and "is the cron actually firing".
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, { status: res.status, headers: res.headers });
  }
  return new Response(
    JSON.stringify({ ...(body as Record<string, unknown>), schedule: await scheduleEvidence() }, null, 2),
    { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
};
