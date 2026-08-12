// ---------------------------------------------------------------------------
// Daily unattended mailbox swapping.
//
// Runs the SAME code the Maintenance tab runs — computePlan, computeMaintenance
// and the Instantly proxy handler are imported directly rather than
// reimplemented, so what the cron decides at 3am is what the UI would have
// shown you at noon. A second implementation would drift from the first within
// a month, and the drift would be invisible until it swapped the wrong mailbox.
//
// Calling the proxy handler in-process (rather than over HTTP) also means every
// write goes through the same verification, scrubbing and op whitelist that the
// browser does, and inherits the INSTANTLY_WRITE_ENABLED gate for free.
//
// Refuses to run unless AUTO_SWAP_ENABLED is true — the kill switch.
// ---------------------------------------------------------------------------
import { getStore } from "@netlify/blobs";
import instantlyHandler from "./instantly.mts";
import { notify } from "./_notify.js";
import { computePlan } from "../../src/lib/campaignPlan.js";
import { computeMaintenance } from "../../src/lib/mailboxHealth.js";
import { computeCapacity } from "../../src/lib/capacity.js";
import { planAutoSwaps, recordScores, type ScoreHistory } from "../../src/lib/autoSwap.js";
import { DEFAULT_SETTINGS, type AppSettings, type Domain } from "../../src/lib/types.js";

const STORE = "cec-data";
/** Where the daily score readings and the run log live. */
const HISTORY_KEY = "auto_swap_history";
const RUNS_TABLE = "auto_swap_runs";
/** Run log entries kept. A month of daily runs is plenty to audit from. */
const KEEP_RUNS = 30;

type Row = { id: string; [k: string]: unknown };

function store() {
  return getStore(STORE);
}

async function readTable(table: string): Promise<Row[]> {
  const data = (await store().get(table, { type: "json" })) as Row[] | null;
  return Array.isArray(data) ? data : [];
}

async function writeTable(table: string, rows: Row[]): Promise<void> {
  await store().setJSON(table, rows);
}

async function readSettings(): Promise<AppSettings> {
  const s = (await store().get("app_settings", { type: "json" })) as Partial<AppSettings> | null;
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

function enabled(): boolean {
  return String(process.env.AUTO_SWAP_ENABLED ?? "").toLowerCase() === "true";
}

/**
 * Call the Instantly proxy in-process. Same handler the browser reaches, so
 * pagination, auth, the write whitelist and read-back verification are shared
 * rather than copied.
 */
async function callInstantly(query: string, body?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // The handler enforces this only when the env var is set; pass it so an
  // authenticated deployment doesn't lock its own cron out.
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

export default async (): Promise<Response> => {
  const startedAt = new Date().toISOString();
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(`[auto-swap] ${s}`);
  };

  if (!enabled()) {
    log("AUTO_SWAP_ENABLED is not true — nothing done");
    return new Response("disabled", { status: 200 });
  }

  try {
    const settings = await readSettings();
    const domains = (await readTable("domains")) as unknown as Domain[];
    const recovery = await readTable("mailbox_recovery");
    const costs = await readTable("costs");
    const capacitySources = await readTable("capacity");

    const [accountsData, campaignsData, analyticsData] = await Promise.all([
      callInstantly("resource=accounts"),
      callInstantly("resource=campaigns"),
      callInstantly("resource=analytics-campaigns"),
    ]);

    const cap = computeCapacity(domains, capacitySources as never, settings);
    const plan = computePlan({
      accountsData: accountsData.data ?? accountsData,
      campaignsData: campaignsData.data ?? campaignsData,
      analyticsData: analyticsData.data ?? analyticsData,
      cap,
      settings,
      costs: costs as never,
    });

    // Convalescing mailboxes are never proposed as replacements — same rule the
    // UI applies, sourced from the same table.
    const recovering = new Set(
      recovery
        .filter((r) => r.status === "recovering")
        .map((r) => String(r.email).trim().toLowerCase()),
    );

    const maintenance = computeMaintenance({ plan, domains, recovering, settings });

    // Roll today's readings into the stored history BEFORE deciding, so a
    // minBadDays > 1 policy can see today as part of the streak.
    const previous = ((await store().get(HISTORY_KEY, { type: "json" })) ?? {}) as Record<
      string,
      number[]
    >;
    const history: ScoreHistory = recordScores(
      new Map(Object.entries(previous)),
      maintenance.mailboxes.map((m) => ({ email: m.box.email, score: m.score })),
    );
    await store().setJSON(HISTORY_KEY, Object.fromEntries(history));

    const policy = {
      maxPerRun: Math.max(1, Number(settings.auto_swap_max_per_run ?? 2)),
      minBadDays: Math.max(1, Number(settings.auto_swap_min_bad_days ?? 1)),
      minScore: Number(settings.maintenance_min_warmup_score ?? 80),
    };
    const decision = planAutoSwaps(maintenance.proposals, history, policy);

    log(
      `${maintenance.proposals.length} proposal(s); acting on ${decision.act.length}, ` +
        `skipping ${decision.skip.length}, ${decision.deferred} over the cap of ${policy.maxPerRun}`,
    );
    for (const s of decision.skip) log(`skipped ${s.email}: ${s.reason}`);

    const applied: { from: string; to: string; campaigns: string[] }[] = [];
    const failed: string[] = [];

    for (const d of decision.act) {
      const confirmedCampaigns: string[] = [];
      const names: string[] = [];

      for (const c of d.proposal.campaigns) {
        const res = await callInstantly("resource=write", {
          op: "set-campaign-emails",
          campaignId: c.id,
          remove: d.from,
          add: d.to,
          expectedList: c.emailListNow,
        });
        // Only a verified read-back counts. `applied: null` means the confirming
        // read failed, and an unattended run must never record a swap it could
        // not prove happened.
        if (res.ok === true && res.applied === true) {
          confirmedCampaigns.push(c.id);
          names.push(c.name);
        } else {
          failed.push(
            `${d.from} → ${d.to} on ${c.name}: ${
              res.applied === null ? "sent but could not confirm" : String(res.error ?? "rejected")
            }`,
          );
        }
        if (res.writesDisabled) {
          log("INSTANTLY_WRITE_ENABLED is not true — stopping, nothing was written");
          break;
        }
      }

      if (confirmedCampaigns.length > 0) {
        applied.push({ from: d.from, to: d.to, campaigns: names });
        // Written in the same shape the UI writes, so the archive and the
        // manual swap-back work on these exactly as on a hand-made swap.
        const rows = await readTable("mailbox_recovery");
        rows.push({
          id: crypto.randomUUID(),
          email: d.from,
          swapped_out_at: new Date().toISOString(),
          score_at_swap: d.proposal.bad.score,
          inbox_rate_at_swap: d.proposal.bad.inboxRate,
          replaced_by: d.to,
          campaign_ids: confirmedCampaigns,
          campaign_names: names,
          status: "recovering",
          released_at: null,
          restored_at: null,
          restored_campaigns: [],
          reason: d.reason || "automatic swap",
          history: [],
          automatic: true,
        });
        await writeTable("mailbox_recovery", rows);
        log(`swapped ${d.from} → ${d.to} on ${names.join(", ")}`);
      }
    }

    for (const f of failed) log(`FAILED ${f}`);

    // --- Record and notify -------------------------------------------------
    const summary =
      applied.length === 0 && failed.length === 0
        ? "No swaps needed."
        : `${applied.length} swap(s) applied, ${failed.length} failure(s).`;

    let emailDetail = "not attempted";
    if (applied.length > 0 || failed.length > 0) {
      const to = String(settings.auto_swap_notify_email ?? "").trim();
      const from = String(settings.auto_swap_from_email ?? "").trim();
      const result = await notify({
        to,
        from,
        subject: `Cold email planner: ${summary}`,
        body: [
          summary,
          "",
          ...applied.map((a) => `SWAPPED  ${a.from} → ${a.to}  (${a.campaigns.join(", ")})`),
          ...failed.map((f) => `FAILED   ${f}`),
          "",
          "Skipped this run:",
          ...decision.skip.map((s) => `  ${s.email}: ${s.reason}`),
          "",
          `Run at ${startedAt}. Undo any of these from the Maintenance tab.`,
        ].join("\n"),
      });
      emailDetail = result.detail;
      log(`notification: ${result.detail}`);
    }

    const runs = await readTable(RUNS_TABLE);
    runs.push({
      id: crypto.randomUUID(),
      ran_at: startedAt,
      applied,
      failed,
      skipped: decision.skip,
      deferred: decision.deferred,
      notification: emailDetail,
      log: lines,
    });
    await writeTable(RUNS_TABLE, runs.slice(-KEEP_RUNS));

    return new Response(summary, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[auto-swap] run failed:", message);
    // A crashed run still gets recorded, so silence in the UI always means
    // "nothing to report" rather than "the cron died three weeks ago".
    try {
      const runs = await readTable(RUNS_TABLE);
      runs.push({
        id: crypto.randomUUID(),
        ran_at: startedAt,
        applied: [],
        failed: [`run crashed: ${message}`],
        skipped: [],
        deferred: 0,
        notification: "not attempted",
        log: lines,
      });
      await writeTable(RUNS_TABLE, runs.slice(-KEEP_RUNS));
    } catch {
      /* the store itself is unreachable; the console line above is all we get */
    }
    return new Response(`failed: ${message}`, { status: 500 });
  }
};

// Typed structurally rather than importing Config from @netlify/functions,
// which isn't a dependency here. Netlify reads this shape directly.
export const config = {
  // Daily. Deliverability metrics are daily-bucketed at source, so a tighter
  // schedule would re-read the same numbers and act on noise.
  schedule: "@daily",
};
