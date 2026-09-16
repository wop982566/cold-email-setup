// ---------------------------------------------------------------------------
// The periodic rotation-swap run, shared by both entry points.
//
// A rotation-managed campaign keeps two FIXED same-niche cohorts (A and B) and
// alternates the whole connected set every `interval_days`: while one cohort
// sends, its partner rests and re-warms (warmup is already on for every
// account), then they swap back — forever. This module is the engine; the pure
// decision logic lives in src/lib/rotationSwap.ts.
//
// Like the auto-swapper, a Netlify SCHEDULED function is not served over HTTP,
// so rotation-swap.mts carries the `@daily` schedule and rotation-swap-test.mts
// is an ordinary HTTP function, both calling runRotation() — one implementation.
// The 15-day cadence is per-campaign state checked daily, not a cron interval.
//
// Every read and write goes through the Instantly proxy handler IN-PROCESS, so
// the write whitelist, scrubbing, read-back verification and the
// INSTANTLY_WRITE_ENABLED gate are inherited, never copied.
//
// Two gates before any write: env ROTATION_SWAP_ENABLED (the production kill
// switch, mirroring AUTO_SWAP_ENABLED) AND settings.rotation_swap_enabled (the
// UI master switch, which also turns the health-based swapper off).
// ---------------------------------------------------------------------------
import { getStore } from "@netlify/blobs";
import instantlyHandler from "./instantly.mts";
import { notify } from "./_notify.js";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type RotationState,
  type RotationRun,
} from "../../src/lib/types.js";
import { planRotation, dueForRotation, pairSwaps, nextDueMs } from "../../src/lib/rotationSwap.js";

const STORE = "cec-data";
const STATE_TABLE = "rotation_state";
const RUNS_TABLE = "rotation_swap_runs";
const KEEP_RUNS = 30;

type Row = { id: string; [k: string]: unknown };

function store() {
  return getStore(STORE);
}
async function readTable<T = Row>(table: string): Promise<T[]> {
  const data = (await store().get(table, { type: "json" })) as T[] | null;
  return Array.isArray(data) ? data : [];
}
async function writeTable(table: string, rows: unknown[]): Promise<void> {
  await store().setJSON(table, rows);
}
async function readSettings(): Promise<AppSettings> {
  const s = (await store().get("app_settings", { type: "json" })) as Partial<AppSettings> | null;
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

/** Production kill switch for the rotation cron (mirrors AUTO_SWAP_ENABLED). */
function envEnabled(): boolean {
  return String(process.env.ROTATION_SWAP_ENABLED ?? "").toLowerCase() === "true";
}

/** Call the Instantly proxy in-process — same handler, auth, whitelist, verify. */
async function callInstantly(query: string, body?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.APP_FUNCTION_TOKEN) headers["x-app-token"] = process.env.APP_FUNCTION_TOKEN;
  const res = await instantlyHandler(
    new Request(`https://internal/.netlify/functions/instantly?${query}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Manual HTTP invocation is gated on the app token, same as every other function. */
function manualAllowed(req: Request | undefined): boolean {
  const required = process.env.APP_FUNCTION_TOKEN;
  if (!required) return true;
  return req?.headers.get("x-app-token") === required;
}

function emailListOf(c: unknown): string[] {
  const list = (c as { email_list?: unknown })?.email_list;
  return Array.isArray(list) ? list.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean) : [];
}
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

interface RotateOutcome {
  campaignId: string;
  campaign: string;
  direction: RotationRun["direction"];
  outcome: RotationRun["outcome"];
  swapped_in: string[];
  swapped_out: string[];
  failures: { email: string; reason: string }[];
  notification: string;
}

/**
 * Rotate one campaign to its inactive cohort. Confirmed-read-back only; a live
 * list that no longer matches the active cohort is left untouched (drift guard).
 * Always records a run row and sends one email — it's only ever called when a
 * rotation was attempted.
 */
async function rotateOne(state: RotationState, settings: AppSettings): Promise<RotateOutcome> {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  const ranAt = new Date().toISOString();
  const plan = planRotation(state);
  const campaignId = state.campaign_id;
  const campaign = state.campaign_name || campaignId;

  const record = async (
    outcome: RotationRun["outcome"],
    failures: { email: string; reason: string }[],
    swapped_in: string[],
    swapped_out: string[],
  ): Promise<RotateOutcome> => {
    // One email per rotation: campaign, every out→in pair, and any failure.
    const pairs = pairSwaps(swapped_out, swapped_in);
    const to = String(settings.auto_swap_notify_email ?? "").trim();
    const from = String(settings.auto_swap_from_email ?? "").trim();
    const subject =
      outcome === "applied"
        ? `Rotation: ${campaign} — ${swapped_in.length} in / ${swapped_out.length} out (${plan.direction})`
        : `Rotation: ${campaign} — ${outcome} (${plan.direction})`;
    const body = [
      `${plan.direction} rotation for ${campaign} — ${outcome}.`,
      "",
      ...pairs.map((p) =>
        p.out && p.in
          ? `SWAPPED  ${p.out} → ${p.in}`
          : p.out
            ? `RESTED   ${p.out} (no replacement — smaller partner cohort)`
            : `ADDED    ${p.in}`,
      ),
      ...(failures.length ? ["", ...failures.map((f) => `FAILED   ${f.email || campaign}: ${f.reason}`)] : []),
      "",
      `Run at ${ranAt}.`,
    ].join("\n");
    const emailed = await notify({ to, from, subject, body });
    log(`notification: ${emailed.detail}`);

    const runs = await readTable(RUNS_TABLE);
    runs.push({
      id: crypto.randomUUID(),
      ran_at: ranAt,
      campaign_id: campaignId,
      campaign_name: campaign,
      direction: plan.direction,
      pairs,
      swapped_in,
      swapped_out,
      outcome,
      failures,
      notification: emailed.detail,
      log: lines,
    } as RotationRun);
    await writeTable(RUNS_TABLE, runs.slice(-KEEP_RUNS));
    return { campaignId, campaign, direction: plan.direction, outcome, swapped_in, swapped_out, failures, notification: emailed.detail };
  };

  // Read the live list and guard against drift from the active cohort.
  const detail = await callInstantly(`resource=campaign-detail&id=${encodeURIComponent(campaignId)}`);
  if (detail.ok !== true) {
    log(`could not read campaign: ${String(detail.error ?? "unknown")}`);
    return record("failed", [{ email: "", reason: `couldn't read campaign: ${String(detail.error ?? "unknown")}` }], [], []);
  }
  const live = emailListOf(detail.data);
  if (!sameSet(live, plan.resting)) {
    log("live inbox list no longer matches the active cohort — skipped");
    return record(
      "skipped",
      [{ email: "", reason: "live inbox list no longer matches the active cohort — skipped to avoid clobbering a manual change. Edit the cohorts to re-sync." }],
      [],
      [],
    );
  }

  // Replace the whole set with the inactive cohort.
  const res = await callInstantly("resource=write", {
    op: "replace-campaign-emails",
    campaignId,
    email_list: plan.target,
    expectedList: live,
  });
  if (res.writesDisabled) {
    log("INSTANTLY_WRITE_ENABLED is not true — nothing was written");
    return record("failed", [{ email: "", reason: "INSTANTLY_WRITE_ENABLED is not true — nothing was written" }], [], []);
  }
  if (res.ok === true && res.applied === true) {
    // Flip the cohort and reschedule.
    const nowIso = new Date().toISOString();
    const interval = state.interval_days && state.interval_days > 0 ? state.interval_days : settings.rotation_interval_days;
    const nextDue = new Date(nextDueMs(Date.now(), interval)).toISOString();
    const states = await readTable<RotationState>(STATE_TABLE);
    const updated = states.map((s) =>
      s.id === state.id
        ? { ...s, active: state.active === "A" ? "B" : "A", last_rotated_at: nowIso, next_due_at: nextDue }
        : s,
    );
    await writeTable(STATE_TABLE, updated);
    log(`rotated ${plan.direction}: connected ${plan.target.length}, rested ${plan.resting.length}`);
    return record("applied", [], plan.target, plan.resting);
  }

  const reason = res.applied === null ? "sent but could not confirm the read-back" : String(res.error ?? "rejected");
  log(`rotation not confirmed: ${reason}`);
  return record(res.applied === null ? "unconfirmed" : "failed", [{ email: "", reason }], [], []);
}

export async function runRotation(req?: Request): Promise<Response> {
  const params = req ? new URL(req.url).searchParams : null;
  // No req at all = the scheduled cron. An HTTP hit with no recognised mode
  // defaults to dryRun (never writes) so a stray GET can't rotate live campaigns.
  const mode = !params
    ? "scheduled"
    : params.has("dryRun")
      ? "dryRun"
      : params.has("testEmail")
        ? "testEmail"
        : params.has("run")
          ? "rotateNow"
          : "dryRun";

  if (req && !manualAllowed(req)) return json({ ok: false, error: "unauthorized" }, 401);

  const settings = await readSettings();

  try {
    if (mode === "testEmail") {
      const to = String(settings.auto_swap_notify_email ?? "").trim();
      const from = String(settings.auto_swap_from_email ?? "").trim();
      const emailed = await notify({
        to,
        from,
        subject: "Cold email planner: rotation test email",
        body: "This is a test of the rotation-swap notifications. If you're reading this, Resend is configured and rotation summaries will reach you here.",
      });
      return json({ ok: emailed.sent, detail: emailed.detail, to, from });
    }

    if (mode === "dryRun") {
      const states = (await readTable<RotationState>(STATE_TABLE)).filter((s) => s.enabled);
      const now = Date.now();
      const caps = await callInstantly("resource=write", { op: "capabilities" });
      const preview = states.map((s) => {
        const plan = planRotation(s);
        return {
          campaignId: s.campaign_id,
          campaign: s.campaign_name,
          active: s.active,
          due: dueForRotation(s, now, settings.rotation_interval_days),
          next_due_at: s.next_due_at,
          direction: plan.direction,
          connect: plan.target,
          rest: plan.resting,
          pairs: pairSwaps(plan.resting, plan.target),
        };
      });
      return json({
        ok: true,
        mode: "dryRun",
        rotationModeOn: settings.rotation_swap_enabled,
        envEnabled: envEnabled(),
        writesEnabled: caps.writesEnabled === true,
        managedCampaigns: states.length,
        dueNow: preview.filter((p) => p.due).length,
        preview,
      });
    }

    if (mode === "rotateNow") {
      const campaignId = params?.get("campaignId") ?? "";
      const states = await readTable<RotationState>(STATE_TABLE);
      const targets = campaignId
        ? states.filter((s) => s.campaign_id === campaignId || s.id === campaignId)
        : states.filter((s) => s.enabled);
      if (targets.length === 0) {
        return json({ ok: false, error: campaignId ? "no rotation state for that campaign — enable rotation first" : "no rotation-enabled campaigns" }, 404);
      }
      const results: RotateOutcome[] = [];
      for (const s of targets) results.push(await rotateOne(s, settings));
      return json({ ok: true, mode: "rotateNow", forced: true, results });
    }

    // scheduled
    if (!envEnabled()) return new Response("disabled (ROTATION_SWAP_ENABLED is not true)", { status: 200 });
    if (!settings.rotation_swap_enabled) return new Response("disabled (rotation mode is off)", { status: 200 });

    const states = await readTable<RotationState>(STATE_TABLE);
    const now = Date.now();
    const due = states.filter((s) => s.enabled && dueForRotation(s, now, settings.rotation_interval_days));
    if (due.length === 0) return new Response("no rotations due", { status: 200 });

    const results: RotateOutcome[] = [];
    for (const s of due) results.push(await rotateOne(s, settings));
    const applied = results.filter((r) => r.outcome === "applied").length;
    return new Response(`${applied}/${results.length} campaign rotation(s) applied`, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[rotation-swap] run failed:", message);
    try {
      const runs = await readTable(RUNS_TABLE);
      runs.push({
        id: crypto.randomUUID(),
        ran_at: new Date().toISOString(),
        campaign_id: "",
        campaign_name: "",
        direction: "A→B",
        pairs: [],
        swapped_in: [],
        swapped_out: [],
        outcome: "failed",
        failures: [{ email: "", reason: `run crashed: ${message}` }],
        notification: "not attempted",
        log: [message],
      } as RotationRun);
      await writeTable(RUNS_TABLE, runs.slice(-KEEP_RUNS));
    } catch {
      /* store unreachable; the console line is all we get */
    }
    return json({ ok: false, error: message }, 500);
  }
}
