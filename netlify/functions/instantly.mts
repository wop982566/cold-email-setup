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
};

const ALLOWED_PARAMS = ["id", "campaign_id", "start_date", "end_date", "limit", "starting_after"];

function tokenOk(req: Request): boolean {
  const required = process.env.APP_FUNCTION_TOKEN;
  if (!required) return true;
  return req.headers.get("x-app-token") === required;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
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
      const out: { email: string; campaign?: string; status?: number }[] = [];
      const seen = new Set<string>();
      let startingAfter: string | undefined;
      let truncated = false;
      const started = Date.now();
      const MAX_PAGES = 400; // up to ~40k leads
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
          out.push({
            email,
            campaign: typeof it.campaign === "string" ? it.campaign : undefined,
            status: typeof it.status === "number" ? it.status : undefined,
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
    if ((resource === "accounts" || resource === "campaigns") && !qs.get("limit")) {
      qs.set("limit", "100");
    }

    const res = await fetch(`${BASE}${path}${qs.toString() ? `?${qs}` : ""}`, { headers: auth });
    const data = await res.json();
    if (!res.ok) return json({ ok: false, error: `Instantly ${res.status}`, data }, res.status);
    return json({ ok: true, data });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Network error" }, 502);
  }
};
