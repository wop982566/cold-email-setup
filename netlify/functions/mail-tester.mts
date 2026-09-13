// ---------------------------------------------------------------------------
// Scheduled Inbox Tester worker. Every few minutes it drains the two queues:
// placement tests (send to the seed panel, then read them back once the wait
// has elapsed) and custom blasts (send a chunk of the fleet per tick). All the
// real work — and all the defensive error handling — lives in _mailWorker.ts.
//
// Like the auto-swap cron, a scheduled function is NOT reachable over HTTP; the
// UI's buttons go to mail-tester-run.mts instead. Scheduled functions only run
// on the PRODUCTION deploy.
// ---------------------------------------------------------------------------
import { drainQueues } from "./_mailWorker.js";

export default async () => {
  try {
    const r = await drainQueues();
    return new Response(JSON.stringify({ ok: true, ...r }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "worker failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = { schedule: "*/5 * * * *" };
