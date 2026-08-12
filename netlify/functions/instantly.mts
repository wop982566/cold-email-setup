// Server-side proxy for the Instantly.ai API v2 — keeps INSTANTLY_API_KEY off
// the browser. Whitelists read endpoints so a leaked frontend can't do damage.
// Docs: https://developer.instantly.ai/api/v2/

const BASE = "https://api.instantly.ai/api/v2";

// resource key -> Instantly path (all GET, read-only)
const GET_RESOURCES: Record<string, string> = {
  accounts: "/accounts",
  campaigns: "/campaigns",
  "analytics-overview": "/campaigns/analytics/overview",
  "analytics-campaigns": "/campaigns/analytics",
  // Per-day send buckets — powers the sending-health metric. Deliberately kept
  // out of the auto-limit branch below: a `limit` on a date-range endpoint
  // would silently truncate the series.
  "analytics-daily": "/campaigns/analytics/daily",
};

// Per-mailbox send counts. Instantly has moved this around between API
// revisions and some workspaces don't expose it at all, so several documented
// paths are tried in order and the caller is told plainly when none answers —
// far better than inventing a per-inbox number by dividing campaign totals.
const ACCOUNT_ANALYTICS_PATHS = [
  "/accounts/analytics",
  "/analytics/accounts",
  "/accounts/campaign-mappings",
];

const ALLOWED_PARAMS = ["id", "campaign_id", "start_date", "end_date", "limit", "starting_after"];

// The only three mutations this function can perform. Deleting anything,
// pausing or starting a campaign, and everything to do with leads are absent
// on purpose — there is no code path to them.
const WRITE_OPS = ["create-account", "update-account", "set-campaign-emails"] as const;
type WriteOp = (typeof WRITE_OPS)[number];

function tokenOk(req: Request): boolean {
  const required = process.env.APP_FUNCTION_TOKEN;
  if (!required) return true;
  return req.headers.get("x-app-token") === required;
}

function writesEnabled(): boolean {
  return String(process.env.INSTANTLY_WRITE_ENABLED ?? "").toLowerCase() === "true";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Strip anything password-shaped before a payload is echoed back to the
 * browser or into an error. Instantly's validation errors quote the offending
 * request, so without this a rejected create would put SMTP credentials in a
 * toast and in the browser's network log.
 */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /pass|secret|token|credential/i.test(k) ? "***" : scrub(v);
    }
    return out;
  }
  return value;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function int(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function normEmail(v: unknown): string {
  return str(v).toLowerCase();
}

/** The mailbox list attached to a campaign, normalised. */
function emailListOf(campaign: unknown): string[] {
  const list = (campaign as { email_list?: unknown })?.email_list;
  if (!Array.isArray(list)) return [];
  return list.map((e) => normEmail(e)).filter(Boolean);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export default async (req: Request): Promise<Response> => {
  if (!tokenOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  const key = process.env.INSTANTLY_API_KEY;
  if (!key) {
    return json(
      {
        ok: false,
        configured: false,
        error:
          "Instantly is not connected. Add INSTANTLY_API_KEY in Netlify env vars (a v2 key with read scopes).",
      },
      400,
    );
  }

  const url = new URL(req.url);
  const resource = url.searchParams.get("resource") || "";
  const auth = { Authorization: `Bearer ${key}`, Accept: "application/json" };

  try {
    // Pull every lead/contact in the workspace (optionally one campaign) and
    // return a COMPACT projection — email + campaign + status only — for
    // duplicate-checking against the tool's leads. Paginates the v2
    // POST /leads/list endpoint within a time budget so the function returns
    // promptly even on large workspaces (flags `truncated` if it stops early).
    if (resource === "leads") {
      const campaignId = url.searchParams.get("campaign_id") || undefined;
      const out: { email: string; campaign?: string; status?: number; contacted: boolean }[] = [];
      const seen = new Set<string>();
      let startingAfter: string | undefined;
      let truncated = false;
      const started = Date.now();
      const MAX_PAGES = 400; // up to ~40k leads
      const num = (v: unknown) => (typeof v === "number" ? v : 0);
      for (let i = 0; i < MAX_PAGES; i++) {
        const body: Record<string, unknown> = { limit: 100 };
        if (startingAfter) body.starting_after = startingAfter;
        if (campaignId) body.campaign = campaignId;
        const res = await fetch(`${BASE}/leads/list`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) return json({ ok: false, error: `Instantly ${res.status}`, data }, res.status);
        const items: Array<Record<string, unknown>> = Array.isArray(data?.items) ? data.items : [];
        for (const it of items) {
          const email = String(it.email ?? "").trim().toLowerCase();
          if (!email || seen.has(email)) continue;
          seen.add(email);
          // "Contacted" = Instantly has actually sent at least one email to
          // this lead. The cleanest signal is a last-contact timestamp; we
          // also treat any open/reply/click or a completed sequence as proof
          // of contact, since those can't happen without a send.
          const lastContact =
            it.timestamp_last_contact ?? it.timestamp_last_touch ?? it.last_contacted ?? null;
          const contacted =
            Boolean(lastContact) ||
            num(it.email_reply_count) > 0 ||
            num(it.email_open_count) > 0 ||
            num(it.email_click_count) > 0 ||
            it.status === 3; // 3 = Completed sequence
          out.push({
            email,
            campaign: typeof it.campaign === "string" ? it.campaign : undefined,
            status: typeof it.status === "number" ? it.status : undefined,
            contacted,
          });
        }
        startingAfter = typeof data?.next_starting_after === "string" ? data.next_starting_after : undefined;
        if (!startingAfter || items.length === 0) break;
        if (Date.now() - started > 8000) {
          truncated = true;
          break;
        }
        if (i === MAX_PAGES - 1) truncated = true;
      }
      return json({ ok: true, data: { items: out, count: out.length, truncated } });
    }

    // Per-mailbox sends, if this workspace reports them. Tries each known path
    // and returns `supported: false` rather than an error when none does, so
    // the UI can say "Instantly doesn't report this" instead of looking broken.
    if (resource === "account-analytics") {
      const qs = new URLSearchParams();
      for (const p of ["start_date", "end_date"]) {
        const v = url.searchParams.get(p);
        if (v) qs.set(p, v);
      }
      const attempts: { path: string; status: number }[] = [];
      for (const path of ACCOUNT_ANALYTICS_PATHS) {
        try {
          const res = await fetch(`${BASE}${path}${qs.toString() ? `?${qs}` : ""}`, { headers: auth });
          attempts.push({ path, status: res.status });
          if (!res.ok) continue;
          const data = await res.json();
          const empty =
            data == null ||
            (Array.isArray(data) && data.length === 0) ||
            (Array.isArray(data?.items) && data.items.length === 0);
          if (empty) continue;
          return json({ ok: true, supported: true, path, data });
        } catch {
          attempts.push({ path, status: 0 });
        }
      }
      return json({
        ok: true,
        supported: false,
        attempts,
        data: null,
      });
    }

    // Single campaign, by path id. Used as a fallback when the /campaigns list
    // payload omits email_list (the campaign -> mailbox linkage).
    if (resource === "campaign-detail") {
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "Missing id" }, 400);
      const res = await fetch(`${BASE}/campaigns/${encodeURIComponent(id)}`, { headers: auth });
      const data = await res.json();
      if (!res.ok) return json({ ok: false, error: `Instantly ${res.status}`, data }, res.status);
      return json({ ok: true, data });
    }

    // Accounts and campaigns paginate at 100/page. The planner counts mailboxes
    // per campaign, so a silent truncation would tell the operator to buy
    // inboxes they already own — page through the whole list instead.
    if (resource === "accounts" || resource === "campaigns") {
      const path = GET_RESOURCES[resource];
      const out: unknown[] = [];
      let startingAfter: string | undefined;
      let truncated = false;
      const started = Date.now();
      const MAX_PAGES = 50; // 5k records
      for (let i = 0; i < MAX_PAGES; i++) {
        const qs = new URLSearchParams({ limit: "100" });
        if (startingAfter) qs.set("starting_after", startingAfter);
        const res = await fetch(`${BASE}${path}?${qs}`, { headers: auth });
        const data = await res.json();
        if (!res.ok) return json({ ok: false, error: `Instantly ${res.status}`, data }, res.status);
        const items: unknown[] = Array.isArray(data) ? data : (data?.items ?? []);
        out.push(...items);
        startingAfter =
          typeof data?.next_starting_after === "string" ? data.next_starting_after : undefined;
        if (!startingAfter || items.length === 0) break;
        if (Date.now() - started > 8000 || i === MAX_PAGES - 1) {
          truncated = true;
          break;
        }
      }
      return json({ ok: true, data: { items: out, count: out.length, truncated } });
    }

    // ---------------------------------------------------------------------
    // Writes. Gated twice: the env flag, and a fixed op whitelist.
    // ---------------------------------------------------------------------
    if (resource === "write") {
      if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400);
      }

      const op = str(body.op) as WriteOp;
      if (!WRITE_OPS.includes(op)) {
        return json({ ok: false, error: `Unknown or forbidden write op: ${op || "(none)"}` }, 400);
      }

      const dryRun = body.dryRun === true;

      if (!writesEnabled() && !dryRun) {
        return json(
          {
            ok: false,
            writesDisabled: true,
            error:
              "Writes to Instantly are turned off. Set INSTANTLY_WRITE_ENABLED=true in Netlify env vars to enable them.",
          },
          403,
        );
      }

      const post = (path: string, payload: unknown, method = "POST") =>
        fetch(`${BASE}${path}`, {
          method,
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

      // --- create a mailbox ------------------------------------------------
      if (op === "create-account") {
        const a = (body.account ?? {}) as Record<string, unknown>;
        const email = normEmail(a.email);
        if (!email.includes("@")) return json({ ok: false, error: "A valid email is required" }, 400);

        // Built field by field rather than spread, so nothing unexpected from
        // the browser reaches Instantly.
        const payload: Record<string, unknown> = {
          email,
          first_name: str(a.first_name),
          last_name: str(a.last_name),
          provider_code: int(a.provider_code, 2),
          smtp_username: str(a.smtp_username) || email,
          smtp_password: str(a.smtp_password),
          smtp_host: str(a.smtp_host),
          smtp_port: int(a.smtp_port, 587),
          imap_username: str(a.imap_username) || email,
          imap_password: str(a.imap_password),
          imap_host: str(a.imap_host),
          imap_port: int(a.imap_port, 993),
          daily_limit: int(a.daily_limit, 30),
          warmup: {
            limit: int(a.warmup_limit, 20),
            increment: int(a.warmup_increment, 1),
            reply_rate: int(a.warmup_reply_rate, 30),
          },
        };
        const tracking = str(a.tracking_domain_name);
        if (tracking) payload.tracking_domain_name = tracking;

        const missing = ["smtp_password", "smtp_host", "imap_password", "imap_host"].filter(
          (k) => !payload[k],
        );
        if (missing.length) {
          return json({ ok: false, error: `Missing required field(s): ${missing.join(", ")}` }, 400);
        }

        if (dryRun) return json({ ok: true, dryRun: true, email, payload: scrub(payload) });

        const res = await post("/accounts", payload);
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          return json(
            { ok: false, email, error: `Instantly ${res.status}`, data: scrub(data), sent: scrub(payload) },
            res.status,
          );
        }
        return json({ ok: true, email, data: scrub(data) });
      }

      // --- warmup / limit settings on an existing mailbox ------------------
      if (op === "update-account") {
        const email = normEmail(body.email);
        if (!email) return json({ ok: false, error: "email is required" }, 400);

        // Deliberately narrow: this op cannot rewrite credentials or identity.
        const patch: Record<string, unknown> = {};
        if (body.daily_limit != null) patch.daily_limit = int(body.daily_limit, 30);
        const w = (body.warmup ?? null) as Record<string, unknown> | null;
        if (w) {
          patch.warmup = {
            limit: int(w.limit, 20),
            increment: int(w.increment, 1),
            reply_rate: int(w.reply_rate, 30),
          };
        }
        if (Object.keys(patch).length === 0) {
          return json({ ok: false, error: "Nothing to update" }, 400);
        }

        if (dryRun) return json({ ok: true, dryRun: true, email, payload: patch });

        const res = await post(`/accounts/${encodeURIComponent(email)}`, patch, "PATCH");
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          return json({ ok: false, email, error: `Instantly ${res.status}`, data: scrub(data) }, res.status);
        }
        return json({ ok: true, email, data: scrub(data) });
      }

      // --- swap a mailbox on a live campaign -------------------------------
      // Read-modify-write with verification at both ends. A campaign that
      // changed underneath us aborts rather than being overwritten blind —
      // this is the one op that touches something actively sending.
      if (op === "set-campaign-emails") {
        const campaignId = str(body.campaignId);
        const remove = normEmail(body.remove);
        const add = normEmail(body.add);
        if (!campaignId) return json({ ok: false, error: "campaignId is required" }, 400);
        if (!remove || !add) return json({ ok: false, error: "remove and add are required" }, 400);
        if (remove === add) return json({ ok: false, error: "remove and add are the same address" }, 400);

        const readRes = await fetch(`${BASE}/campaigns/${encodeURIComponent(campaignId)}`, { headers: auth });
        const campaign = await readRes.json().catch(() => null);
        if (!readRes.ok) {
          return json(
            { ok: false, campaignId, error: `Instantly ${readRes.status} reading campaign`, data: scrub(campaign) },
            readRes.status,
          );
        }

        const current = emailListOf(campaign);
        if (current.length === 0) {
          return json(
            { ok: false, campaignId, error: "Campaign returned no email_list — refusing to write one from scratch." },
            409,
          );
        }
        if (!current.includes(remove)) {
          return json(
            { ok: false, campaignId, error: `${remove} is not attached to this campaign any more.`, current },
            409,
          );
        }
        if (current.includes(add)) {
          return json(
            { ok: false, campaignId, error: `${add} is already attached to this campaign.`, current },
            409,
          );
        }
        // Optimistic concurrency: the UI sends what it believed the list was.
        const expected = Array.isArray(body.expectedList)
          ? (body.expectedList as unknown[]).map(normEmail).filter(Boolean)
          : null;
        if (expected && !sameSet(expected, current)) {
          return json(
            {
              ok: false,
              campaignId,
              error: "This campaign's mailbox list changed since the page loaded. Refresh and try again.",
              current,
              expected,
            },
            409,
          );
        }

        const next = current.map((e) => (e === remove ? add : e));

        if (dryRun) return json({ ok: true, dryRun: true, campaignId, before: current, after: next });

        const res = await post(`/campaigns/${encodeURIComponent(campaignId)}`, { email_list: next }, "PATCH");
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          return json(
            { ok: false, campaignId, error: `Instantly ${res.status}`, data: scrub(data), before: current, attempted: next },
            res.status,
          );
        }

        // Confirm from the server rather than trusting the write's response.
        const verifyRes = await fetch(`${BASE}/campaigns/${encodeURIComponent(campaignId)}`, { headers: auth });
        const verified = verifyRes.ok ? emailListOf(await verifyRes.json().catch(() => null)) : null;
        const applied = verified ? verified.includes(add) && !verified.includes(remove) : null;

        return json({
          ok: true,
          campaignId,
          before: current,
          after: next,
          verified,
          // null means the confirming read failed, not that the write failed.
          applied,
        });
      }
    }

    // Warmup analytics is a POST with a body of emails (1-100).
    if (resource === "warmup") {
      let emails: string[] = [];
      try {
        const body = (await req.json()) as { emails?: string[] };
        emails = (body.emails ?? []).slice(0, 100);
      } catch {
        /* no body */
      }
      if (emails.length === 0) return json({ ok: true, data: { items: [] } });
      const res = await fetch(`${BASE}/accounts/warmup-analytics`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      const data = await res.json();
      if (!res.ok) return json({ ok: false, error: `Instantly ${res.status}`, data }, res.status);
      return json({ ok: true, data });
    }

    const path = GET_RESOURCES[resource];
    if (!path) return json({ ok: false, error: `Unknown resource: ${resource}` }, 400);

    const qs = new URLSearchParams();
    for (const p of ALLOWED_PARAMS) {
      const v = url.searchParams.get(p);
      if (v) qs.set(p, v);
    }

    const res = await fetch(`${BASE}${path}${qs.toString() ? `?${qs}` : ""}`, { headers: auth });
    const data = await res.json();
    if (!res.ok) return json({ ok: false, error: `Instantly ${res.status}`, data }, res.status);
    return json({ ok: true, data });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Network error" }, 502);
  }
};
