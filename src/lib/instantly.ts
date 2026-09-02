// Client for the Instantly proxy function. All calls go through
// /.netlify/functions/instantly so the API key stays server-side.
//
// asItems/pick are re-exported from apiShape.ts, which is browser-free so
// server code can use them without dragging import.meta.env in.
export { asItems, pick } from "./apiShape";
const APP_TOKEN = import.meta.env.VITE_APP_TOKEN as string | undefined;

function headers(extra?: Record<string, string>): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (APP_TOKEN) h["x-app-token"] = APP_TOKEN;
  return h;
}

export interface InstantlyResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  configured?: boolean;
}

async function call<T>(resource: string, params: Record<string, string> = {}): Promise<InstantlyResult<T>> {
  try {
    const qs = new URLSearchParams({ resource, ...params });
    const res = await fetch(`/.netlify/functions/instantly?${qs}`, { headers: headers() });
    const body = (await res.json()) as InstantlyResult<T>;
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}`, configured: body.configured };
    return body;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error (functions only run on Netlify)" };
  }
}

export type DateRange = "7d" | "30d" | "90d" | "all";

// A UTC start/end window N days back from today. Instantly's date params are
// plain YYYY-MM-DD; keeping this in one place means every caller (and the
// day-bucket maths in sendingHealth) agrees on where a day boundary falls.
export function daysParams(days: number): Record<string, string> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start_date: fmt(start), end_date: fmt(end) };
}

export function rangeParams(range: DateRange): Record<string, string> {
  if (range === "all") return {};
  return daysParams(range === "7d" ? 7 : range === "30d" ? 30 : 90);
}

// Instantly list endpoints return { items: [...] }; analytics may return an
// array or an object — normalise to an array where appropriate.

export interface InstantlyLead {
  email: string;
  campaign?: string;
  status?: number;
  /** True when Instantly has actually sent ≥1 email to this contact. */
  contacted?: boolean;
}
export interface InstantlyLeadsData {
  items: InstantlyLead[];
  count: number;
  truncated: boolean;
}

// --- Writes ----------------------------------------------------------------
// Every write goes through one POST endpoint with a fixed op whitelist, and is
// gated server-side on INSTANTLY_WRITE_ENABLED. `dryRun` returns the exact
// payload that would be sent without sending it — which is how the UI shows
// you the change before it happens.

export interface WriteAttempt {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface WriteResult<T = unknown> extends InstantlyResult<T> {
  /** Set when the env flag is off, so the UI can explain rather than just fail. */
  writesDisabled?: boolean;
  dryRun?: boolean;
  email?: string;
  campaignId?: string;
  before?: string[];
  after?: string[];
  verified?: string[] | null;
  verifyStatus?: number;
  /** Every HTTP call made, for diagnosis when a write doesn't land. */
  attempts?: WriteAttempt[];
  /**
   * true  = confirmed applied
   * false = confirmed NOT applied
   * null  = could not confirm — NEVER treat this as success.
   */
  applied?: boolean | null;
  current?: string[];
  payload?: unknown;
  /** The scrubbed payload the server actually sent — for diagnosing a rejection. */
  sent?: unknown;
  // capabilities probe
  writesEnabled?: boolean;
  hint?: string | null;
}

export interface NewAccount {
  email: string;
  first_name?: string;
  last_name?: string;
  provider_code?: number;
  smtp_username?: string;
  smtp_password: string;
  smtp_host: string;
  smtp_port?: number;
  imap_username?: string;
  imap_password: string;
  imap_host: string;
  imap_port?: number;
  daily_limit?: number;
  warmup_limit?: number;
  warmup_increment?: number;
  warmup_reply_rate?: number;
  tracking_domain_name?: string;
}

async function write<T = unknown>(body: Record<string, unknown>): Promise<WriteResult<T>> {
  try {
    const res = await fetch("/.netlify/functions/instantly?resource=write", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as WriteResult<T>;
    if (!res.ok) return { ...data, ok: false, error: data.error ?? `HTTP ${res.status}` };
    return data;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
}

// --- The daily swapper, asked to prove it works ----------------------------
// Both paths hit the scheduled function directly. dryRun computes a full
// decision and writes nothing; testEmail sends one email and reports what
// Resend actually said.
async function autoSwapCall(mode: "dryRun" | "testEmail"): Promise<Record<string, unknown>> {
  // Note the endpoint: auto-swap-test, NOT auto-swap. The latter is a scheduled
  // function and Netlify does not serve those over HTTP — its URL returns an
  // empty 404, which is what produced "Unexpected end of JSON input".
  const url = `/.netlify/functions/auto-swap-test?${mode}=1`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: headers() });
  } catch (e) {
    return {
      ok: false,
      unreachable: true,
      error: `Couldn't reach ${url}: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  // Read as text first. Calling res.json() on an empty or HTML body throws, and
  // the old catch turned that into a result object with every field missing —
  // which the UI then rendered as "RESEND_API_KEY is missing". Reporting a
  // cause we never observed is worse than reporting nothing.
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }

  if (body === null) {
    return {
      ok: false,
      unreachable: true,
      status: res.status,
      error:
        res.status === 404
          ? `The function isn't deployed at ${url} (HTTP 404). Redeploy, then try again.`
          : `${url} answered HTTP ${res.status} with ${
              text ? `a non-JSON body: ${text.slice(0, 200)}` : "an empty body"
            }`,
    };
  }

  if (!res.ok) return { ...body, ok: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
  return body;
}

export const autoSwap = {
  /** Full pipeline, zero writes — what the cron would do right now. */
  dryRun: () => autoSwapCall("dryRun"),
  /** One email through Resend, with the raw result. */
  testEmail: () => autoSwapCall("testEmail"),
};

export const instantly = {
  accounts: () => call("accounts", { limit: "100" }),
  campaigns: () => call("campaigns", { limit: "100" }),
  // All leads/contacts in the workspace (compact: email/campaign/status) for
  // duplicate-checking. Optionally scope to one campaign.
  workspaceLeads: (campaignId?: string) =>
    call<InstantlyLeadsData>("leads", campaignId ? { campaign_id: campaignId } : {}),
  analyticsOverview: (range: DateRange) => call("analytics-overview", rangeParams(range)),
  campaignAnalytics: (range: DateRange) => call("analytics-campaigns", rangeParams(range)),
  // Per-day send buckets across the whole workspace. Left untyped like its
  // siblings — the payload may be a bare array or {items:[…]}, which asItems()
  // absorbs.
  analyticsDaily: (days = 30) => call("analytics-daily", daysParams(days)),
  // Per-mailbox sends. Resolves with `supported: false` when this workspace's
  // API doesn't report them — an answer, not a failure.
  accountAnalytics: (days = 30) =>
    call<unknown>("account-analytics", daysParams(days)) as Promise<
      InstantlyResult<unknown> & { supported?: boolean }
    >,
  // Single campaign — used only when the list payload omits email_list, which
  // is the campaign -> mailbox linkage the planner is built on.
  campaignDetail: (id: string) => call("campaign-detail", { id }),
  // Full settings for one inbox — used by the bulk-update preview to show and
  // discover the live field shape. Credentials are scrubbed server-side.
  accountDetail: (email: string) => call("account-detail", { email }),
  // Custom tags. Resolves with supported:false when none of the probed paths
  // exist in this workspace — an answer, not a failure.
  tags: () =>
    call<unknown>("tags") as Promise<
      InstantlyResult<unknown> & { supported?: boolean; path?: string; empty?: boolean; attempts?: unknown }
    >,
  warmup: async (emails: string[]): Promise<InstantlyResult> => {
    try {
      const res = await fetch("/.netlify/functions/instantly?resource=warmup", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ emails }),
      });
      const body = (await res.json()) as InstantlyResult;
      if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
      return body;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Network error" };
    }
  },

  // Are writes permitted? Touches nothing, so it's safe to call on page load.
  writeCapabilities: () => write({ op: "capabilities" }),

  createAccount: (account: NewAccount, dryRun = false) =>
    write({ op: "create-account", account, dryRun }),

  updateAccount: (
    payload: { email: string; daily_limit?: number; warmup?: { limit: number; increment: number; reply_rate: number } },
    dryRun = false,
  ) => write({ op: "update-account", ...payload, dryRun }),

  // Bulk update of an existing inbox's settings. `patch` is built client-side
  // from the enabled fields (inboxUpdate.accountUpdatePayload); the server
  // whitelists it, so no credential field can slip through.
  updateAccountFields: (email: string, patch: Record<string, unknown>, dryRun = false) =>
    write({ op: "update-account", email, patch, dryRun }),

  // `expectedList` is what the page believed the campaign held. The server
  // aborts if reality disagrees, so a stale tab can't clobber a live campaign.
  setCampaignEmails: (
    payload: { campaignId: string; remove: string; add: string; expectedList?: string[] },
    dryRun = false,
  ) => write({ op: "set-campaign-emails", ...payload, dryRun }),

  // Append inboxes to a campaign without removing any — autopopulate. `add` is a
  // list; the server skips ones already attached, verifies the read-back, and
  // `expectedList` aborts if the campaign changed since the page loaded.
  addCampaignEmails: (
    payload: { campaignId: string; add: string[]; expectedList?: string[] },
    dryRun = false,
  ) => write({ op: "add-campaign-emails", ...payload, dryRun }),
};

// --- Inbox tester ----------------------------------------------------------
// The buttons on the Inbox Tester page reach the mail-tester-run function
// (verify SMTP/IMAP, queue a placement test, kick a custom blast). Same
// x-app-token header as every other write.
async function mailTesterPost(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  try {
    const res = await fetch("/.netlify/functions/mail-tester-run", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error (functions only run on Netlify)" };
  }
}

export const mailTester = {
  verify: (payload: { seedIds?: string[]; sendIds?: string[] }) => mailTesterPost({ action: "verify", ...payload }),
  testNow: (mailbox: string) => mailTesterPost({ action: "test-now", mailbox }),
  blast: (payload: { target: string; subject: string; body: string; fromEmails: string[] }) =>
    mailTesterPost({ action: "blast", ...payload }),
};

// Pull a numeric stat from a record trying several known Instantly field names.
