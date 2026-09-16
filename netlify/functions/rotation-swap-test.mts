// ---------------------------------------------------------------------------
// Asking the rotation swapper questions, over HTTP.
//
// Deliberately has NO `config.schedule` export — Netlify does not serve
// scheduled functions over HTTP, so the dry-run / rotate-now / test-email paths
// live here rather than on rotation-swap.mts. Adding a schedule here would break
// them the way it did the auto-swapper's.
//
// dryRun writes nothing; testEmail sends one message without touching Instantly;
// rotateNow forces one campaign to rotate now (still write-gated + verified).
// ---------------------------------------------------------------------------
import { getStore } from "@netlify/blobs";
import { runRotation } from "./_rotationRun.js";

const STORE = "cec-data";
const RUNS_TABLE = "rotation_swap_runs";

/** Has the SCHEDULED rotation function ever actually run? */
async function scheduleEvidence(): Promise<Record<string, unknown>> {
  try {
    const rows = ((await getStore(STORE).get(RUNS_TABLE, { type: "json" })) ?? []) as { ran_at?: string }[];
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        hasEverRun: false,
        note:
          "The daily rotation function has never recorded a run. If this persists past 24h, check " +
          "that this branch is the PRODUCTION branch in Netlify — scheduled functions only fire on " +
          "production deploys, never branch deploys or previews.",
      };
    }
    const last = [...rows].sort((a, b) => (b.ran_at ?? "").localeCompare(a.ran_at ?? ""))[0];
    return { hasEverRun: true, runsRecorded: rows.length, lastRunAt: last?.ran_at ?? null };
  } catch (err) {
    return { hasEverRun: null, note: `Couldn't read the run log: ${err instanceof Error ? err.message : "unknown error"}` };
  }
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  // Default to a dry run when no mode is given — the safe answer if the query
  // string is ever dropped.
  if (!url.searchParams.get("dryRun") && !url.searchParams.get("testEmail") && !url.searchParams.get("run")) {
    url.searchParams.set("dryRun", "1");
  }

  const res = await runRotation(new Request(url.toString(), { method: "POST", headers: req.headers }));

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
