// ---------------------------------------------------------------------------
// The Inbox Tester engine: send test emails over SMTP, read where they landed
// over IMAP, verify connections, and run custom blasts.
//
// Everything here is network-facing and cannot be unit-tested offline, so it is
// written to fail SAFE: every SMTP/IMAP call is wrapped in its own try/catch
// with a hard timeout, one bad account never aborts a batch, and the real error
// is captured onto the row so the UI can show it. The scoring / classification
// it relies on lives in the pure, tested `inboxPlacement` module.
//
// Two entrypoints wrap this: `mail-tester.mts` (scheduled, drains the queues)
// and `mail-tester-run.mts` (HTTP, the UI's verify / test-now / blast buttons).
// ---------------------------------------------------------------------------
import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SeedInbox,
  type SendInbox,
  type MailProfile,
  type SetupBatch,
  type InboxTest,
  type InboxTestResult,
  type SendBlast,
  type SeedFolder,
} from "../../src/lib/types.js";
import { resolveSmtp, batchCoverage, type ResolvedSmtp } from "../../src/lib/sendConnect.js";
import { scoreTest, folderFromGmail, folderFromOutlook, parseAuthResults } from "../../src/lib/inboxPlacement.js";

const STORE = "cec-data";
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
function uid(): string {
  return "id_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function newToken(): string {
  return "INBX" + Math.random().toString(36).slice(2, 10).toUpperCase();
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Update one row of a table in place (read-modify-write). Keeps the blast/test
 * status machine honest under the scheduled worker + HTTP trigger both writing.
 */
async function patchRow(table: string, id: string, patch: Record<string, unknown>): Promise<void> {
  const rows = await readTable(table);
  const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
  await writeTable(table, next);
}

// --- SMTP send + verify ----------------------------------------------------

function transporterFor(smtp: ResolvedSmtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

async function sendOne(smtp: ResolvedSmtp, to: string, subject: string, text: string): Promise<void> {
  const t = transporterFor(smtp);
  try {
    await withTimeout(
      t.sendMail({
        from: smtp.fromName ? `"${smtp.fromName}" <${smtp.from}>` : smtp.from,
        to,
        subject,
        text,
      }),
      25_000,
      "smtp send",
    );
  } finally {
    t.close();
  }
}

async function verifySmtp(smtp: ResolvedSmtp): Promise<{ ok: boolean; error?: string }> {
  const t = transporterFor(smtp);
  try {
    await withTimeout(t.verify(), 20_000, "smtp verify");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "SMTP verify failed" };
  } finally {
    t.close();
  }
}

// --- IMAP read + verify ----------------------------------------------------

function imapClient(seed: SeedInbox): ImapFlow {
  const client = new ImapFlow({
    host: seed.imap_host,
    port: seed.imap_port || 993,
    secure: seed.imap_secure ?? true,
    auth: { user: (seed.imap_user || "").trim() || seed.email, pass: seed.imap_password },
    logger: false,
    emitLogs: false,
    // Don't let a background socket error throw out of band.
  });
  client.on("error", () => {});
  return client;
}

async function verifyImap(seed: SeedInbox): Promise<{ ok: boolean; error?: string }> {
  const client = imapClient(seed);
  try {
    await withTimeout(client.connect(), 20_000, "imap connect");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "IMAP connect failed" };
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}

function isGmail(provider: string): boolean {
  return provider === "gmail" || provider === "gworkspace";
}

async function findMailbox(client: ImapFlow, special: string, names: string[]): Promise<string | null> {
  try {
    const boxes = await withTimeout(client.list(), 15_000, "imap list");
    const bySpecial = boxes.find((b) => b.specialUse === special);
    if (bySpecial) return bySpecial.path;
    const lower = names.map((n) => n.toLowerCase());
    const byName = boxes.find((b) => lower.includes(b.path.toLowerCase()) || lower.includes((b.name ?? "").toLowerCase()));
    return byName?.path ?? null;
  } catch {
    return null;
  }
}

/** Search one mailbox for the token; return its auth headers when found. */
async function searchMailbox(
  client: ImapFlow,
  mailbox: string,
  token: string,
): Promise<{ found: boolean; auth?: { spf?: string; dkim?: string; dmarc?: string }; labels?: string[] }> {
  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
  try {
    lock = await withTimeout(client.getMailboxLock(mailbox), 15_000, "imap open");
    const uids = (await withTimeout(client.search({ subject: token }, { uid: true }), 15_000, "imap search")) || [];
    if (!Array.isArray(uids) || uids.length === 0) return { found: false };
    const last = uids[uids.length - 1];
    let auth: { spf?: string; dkim?: string; dmarc?: string } | undefined;
    let labels: string[] | undefined;
    const msg = await withTimeout(
      client.fetchOne(
        String(last),
        { labels: true, headers: ["authentication-results", "received-spf"] },
        { uid: true },
      ),
      15_000,
      "imap fetch",
    );
    if (msg && typeof msg === "object") {
      const m = msg as { labels?: Set<string>; headers?: Buffer };
      if (m.labels) labels = [...m.labels];
      if (m.headers) auth = parseAuthResults(m.headers.toString());
    }
    return { found: true, auth, labels };
  } catch {
    return { found: false };
  } finally {
    try {
      lock?.release();
    } catch {
      /* ignore */
    }
  }
}

/** Where did a token-tagged message land in this seed? */
async function readSeedPlacement(
  seed: SeedInbox,
  token: string,
): Promise<{ folder: SeedFolder; auth?: { spf?: string; dkim?: string; dmarc?: string } }> {
  const client = imapClient(seed);
  try {
    await withTimeout(client.connect(), 20_000, "imap connect");

    if (isGmail(seed.provider)) {
      // All Mail carries every copy — inbox, spam, and category labels — so one
      // search + the Gmail labels tells us primary vs tab vs spam.
      const allMail =
        (await findMailbox(client, "\\All", ["[Gmail]/All Mail", "[Google Mail]/All Mail"])) ?? "[Gmail]/All Mail";
      const hit = await searchMailbox(client, allMail, token);
      if (!hit.found) return { folder: "missing" };
      return { folder: folderFromGmail(hit.labels ?? []), auth: hit.auth };
    }

    // Everyone else: INBOX first (primary), then the junk folder (spam).
    const inbox = await searchMailbox(client, "INBOX", token);
    if (inbox.found) return { folder: folderFromOutlook("INBOX"), auth: inbox.auth };
    const junk = await findMailbox(client, "\\Junk", ["Junk", "Junk Email", "Spam", "Bulk Mail"]);
    if (junk) {
      const j = await searchMailbox(client, junk, token);
      if (j.found) return { folder: "spam", auth: j.auth };
    }
    return { folder: "missing" };
  } catch {
    return { folder: "missing" };
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}

// --- Sender credential resolution ------------------------------------------

export function resolveSender(
  email: string,
  sendInboxes: SendInbox[],
  profiles: MailProfile[],
  batches: SetupBatch[],
): { ok: true; smtp: ResolvedSmtp; from_name?: string } | { ok: false; reason: string } {
  const key = email.trim().toLowerCase();
  const row = sendInboxes.find((s) => (s.email ?? "").trim().toLowerCase() === key);
  if (row) {
    const r = resolveSmtp(row, profiles);
    return r.ok ? { ok: true, smtp: r.smtp, from_name: row.from_name } : { ok: false, reason: r.reason };
  }
  const profileId = batchCoverage(batches).get(key);
  if (profileId) {
    const probe: SendInbox = { id: "", email, source: "instantly", profile_id: profileId, connected: "unknown" };
    const r = resolveSmtp(probe, profiles);
    if (r.ok) return { ok: true, smtp: r.smtp };
  }
  return { ok: false, reason: "no SMTP credentials on file for this inbox — connect it first" };
}

function fillTemplate(tpl: string, token: string): string {
  return String(tpl ?? "").replace(/\{token\}/g, token);
}

// --- Queue draining (scheduled) --------------------------------------------

async function processTests(settings: AppSettings): Promise<number> {
  const tests = await readTable<InboxTest>("inbox_tests");
  const seeds = (await readTable<SeedInbox>("seed_inboxes")).filter((s) => s.active && s.connected !== "failed");
  const sendInboxes = await readTable<SendInbox>("send_inboxes");
  const profiles = await readTable<MailProfile>("mail_profiles");
  const batches = await readTable<SetupBatch>("setup_batches");
  const now = Date.now();
  let worked = 0;

  for (const t of tests) {
    // --- send phase ---
    if (t.status === "queued") {
      const sender = resolveSender(t.mailbox, sendInboxes, profiles, batches);
      if (!sender.ok) {
        await patchRow("inbox_tests", t.id, { status: "failed", error: sender.reason });
        worked++;
        continue;
      }
      const panel = seeds.length ? seeds : [];
      if (panel.length === 0) {
        await patchRow("inbox_tests", t.id, { status: "failed", error: "No active seed inboxes to test against." });
        worked++;
        continue;
      }
      const subject = fillTemplate(settings.seed_test_subject || "Quick question {token}", t.token);
      const body = fillTemplate(settings.seed_test_body || "ref {token}", t.token);
      let sent = 0;
      const failures: string[] = [];
      for (const seed of panel) {
        try {
          await sendOne(sender.smtp, seed.email, subject, body);
          sent++;
        } catch (e) {
          failures.push(`${seed.email}: ${e instanceof Error ? e.message : "send failed"}`);
        }
      }
      if (sent === 0) {
        await patchRow("inbox_tests", t.id, {
          status: "failed",
          error: `Couldn't send to any seed. ${failures.slice(0, 3).join("; ")}`,
        });
      } else {
        const wait = Math.max(1, settings.seed_test_wait_minutes || 6);
        await patchRow("inbox_tests", t.id, {
          status: "reading",
          read_after: new Date(now + wait * 60_000).toISOString(),
          seeds: panel.map((s) => ({ email: s.email, provider: s.provider })),
        });
      }
      worked++;
      continue;
    }

    // --- read phase ---
    if (t.status === "reading" && Date.parse(t.read_after) <= now) {
      const panel = (t.seeds ?? []).map((ps) => seeds.find((s) => s.email === ps.email)).filter(Boolean) as SeedInbox[];
      const results: InboxTestResult[] = [];
      for (const ps of t.seeds ?? []) {
        const seed = panel.find((s) => s.email === ps.email);
        if (!seed) {
          results.push({ seed: ps.email, provider: ps.provider, folder: "missing" });
          continue;
        }
        const r = await readSeedPlacement(seed, t.token);
        results.push({ seed: ps.email, provider: ps.provider, folder: r.folder, auth: r.auth });
      }
      const summary = scoreTest(results);
      await patchRow("inbox_tests", t.id, { status: "done", results, summary });
      worked++;
    }
  }
  return worked;
}

async function processBlasts(settings: AppSettings): Promise<number> {
  const blasts = await readTable<SendBlast>("send_blasts");
  const sendInboxes = await readTable<SendInbox>("send_inboxes");
  const profiles = await readTable<MailProfile>("mail_profiles");
  const batches = await readTable<SetupBatch>("setup_batches");
  const perRun = Math.max(1, settings.blast_max_per_run || 25);
  let worked = 0;

  for (const b of blasts) {
    if (b.status !== "queued" && b.status !== "sending") continue;
    const done = new Set((b.results ?? []).map((r) => r.email));
    const pending = (b.from_emails ?? []).filter((e) => !done.has(e)).slice(0, perRun);
    if (pending.length === 0) {
      if (b.status !== "done") await patchRow("send_blasts", b.id, { status: "done" });
      continue;
    }
    const results = [...(b.results ?? [])];
    for (const email of pending) {
      const sender = resolveSender(email, sendInboxes, profiles, batches);
      if (!sender.ok) {
        results.push({ email, outcome: "skipped", error: sender.reason });
        continue;
      }
      try {
        // One message per sender, addressed to every target (comma-joined To).
        await sendOne(sender.smtp, (b.targets ?? []).join(", "), b.subject, b.body);
        results.push({ email, outcome: "sent" });
      } catch (e) {
        results.push({ email, outcome: "failed", error: e instanceof Error ? e.message : "send failed" });
      }
    }
    const finished = results.length >= (b.from_emails ?? []).length;
    await patchRow("send_blasts", b.id, { status: finished ? "done" : "sending", results });
    worked++;
  }
  return worked;
}

export async function drainQueues(): Promise<{ tests: number; blasts: number }> {
  const settings = await readSettings();
  // Tests first (they're time-sensitive on read_after); then blasts.
  const tests = await processTests(settings).catch(() => 0);
  const blasts = await processBlasts(settings).catch(() => 0);
  return { tests, blasts };
}

// --- HTTP actions (the UI's buttons) ---------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function tokenOk(req: Request): boolean {
  const required = process.env.APP_FUNCTION_TOKEN;
  if (!required) return true;
  return req.headers.get("x-app-token") === required;
}

export async function handleAction(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (!tokenOk(req)) return json({ ok: false, error: "unauthorized" }, 401);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const settings = await readSettings();

  // Verify SMTP for sending inboxes and/or IMAP for seeds; write the outcome
  // back onto each row so the UI turns green/red with the real reason.
  if (action === "verify") {
    const seedIds = Array.isArray(body.seedIds) ? (body.seedIds as string[]) : [];
    const sendIds = Array.isArray(body.sendIds) ? (body.sendIds as string[]) : [];
    const profiles = await readTable<MailProfile>("mail_profiles");
    const results: { id: string; kind: "seed" | "send"; ok: boolean; error?: string }[] = [];

    if (seedIds.length) {
      const seeds = await readTable<SeedInbox>("seed_inboxes");
      for (const id of seedIds.slice(0, 25)) {
        const seed = seeds.find((s) => s.id === id);
        if (!seed) continue;
        const v = await verifyImap(seed);
        await patchRow("seed_inboxes", id, {
          connected: v.ok ? "ok" : "failed",
          last_error: v.error ?? "",
          verified_at: new Date().toISOString(),
        });
        results.push({ id, kind: "seed", ok: v.ok, error: v.error });
      }
    }
    if (sendIds.length) {
      const sends = await readTable<SendInbox>("send_inboxes");
      for (const id of sendIds.slice(0, 25)) {
        const row = sends.find((s) => s.id === id);
        if (!row) continue;
        const r = resolveSmtp(row, profiles);
        const v = r.ok ? await verifySmtp(r.smtp) : { ok: false, error: r.reason };
        await patchRow("send_inboxes", id, {
          connected: v.ok ? "ok" : "failed",
          last_error: v.error ?? "",
          verified_at: new Date().toISOString(),
        });
        results.push({ id, kind: "send", ok: v.ok, error: v.error });
      }
    }
    return json({ ok: true, results });
  }

  // Queue a placement test and immediately run the send phase so the user sees
  // it go to "reading"; the scheduled worker reads the seeds after the wait.
  if (action === "test-now") {
    const mailbox = String(body.mailbox ?? "").trim().toLowerCase();
    if (!mailbox) return json({ ok: false, error: "mailbox is required" }, 400);
    const row: InboxTest = {
      id: uid(),
      mailbox,
      token: newToken(),
      status: "queued",
      trigger: "manual",
      started_at: new Date().toISOString(),
      read_after: "",
      seeds: [],
      results: [],
      summary: null,
    };
    const tests = await readTable<InboxTest>("inbox_tests");
    await writeTable("inbox_tests", [...tests, row]);
    await drainQueues().catch(() => ({}));
    return json({ ok: true, id: row.id });
  }

  // Queue a custom blast and kick the first chunk now.
  if (action === "blast") {
    // Accept an array or a comma/space-separated string; keep only real addresses.
    const rawTargets = Array.isArray(body.targets)
      ? (body.targets as unknown[]).map((t) => String(t))
      : String(body.targets ?? body.target ?? "").split(/[,\s]+/);
    const targets = [...new Set(rawTargets.map((t) => t.trim().toLowerCase()).filter((t) => t.includes("@")))];
    const subject = String(body.subject ?? "").trim();
    const bodyText = String(body.body ?? "");
    const fromEmails = Array.isArray(body.fromEmails)
      ? [...new Set((body.fromEmails as string[]).map((e) => String(e).trim().toLowerCase()).filter(Boolean))]
      : [];
    if (targets.length === 0 || !subject || fromEmails.length === 0) {
      return json({ ok: false, error: "at least one recipient, a subject and one sending inbox are required" }, 400);
    }
    const row: SendBlast = {
      id: uid(),
      targets,
      subject,
      body: bodyText,
      from_emails: fromEmails,
      status: "queued",
      started_at: new Date().toISOString(),
      results: [],
    };
    const blasts = await readTable<SendBlast>("send_blasts");
    await writeTable("send_blasts", [...blasts, row]);
    await processBlasts(settings).catch(() => 0);
    return json({ ok: true, id: row.id });
  }

  return json({ ok: false, error: `unknown action "${action}"` }, 400);
}
