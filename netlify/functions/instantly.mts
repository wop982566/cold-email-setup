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
