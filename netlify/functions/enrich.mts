// Optional AI lead enrichment via OpenAI. Server-side so the API key is never
// exposed to the browser. If OPENAI_API_KEY is not set, it returns a clear
// error and the UI falls back to manual enrichment.

interface LeadInput {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  title?: string;
  website?: string;
  industry?: string;
  location?: string;
}

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
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!tokenOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(
      { ok: false, error: "AI is not configured. Add OPENAI_API_KEY in Netlify env vars to enable enrichment." },
      400,
    );
  }

  let payload: { leads: LeadInput[]; instructions: string; fields: string[] };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { leads, instructions, fields } = payload;
  if (!Array.isArray(leads) || leads.length === 0) {
    return json({ ok: false, error: "No leads provided" }, 400);
  }
  // Keep batches sane to control cost/latency.
  const batch = leads.slice(0, 50);

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const system =
    "You are a B2B lead-enrichment assistant for cold-email outreach. " +
    "For each lead, infer the requested fields from the data provided. " +
    "Only use the company, title, website and other given signals — do not invent contact details. " +
    "Return STRICT JSON: { \"results\": [ { \"id\": string, ...requestedFields } ] }. " +
    `Requested fields: ${(fields || []).join(", ") || "industry, score, summary"}. ` +
    "score must be an integer 0-100 representing cold-email fit. summary must be one short sentence.";

  const user = JSON.stringify({ instructions, leads: batch });

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return json({ ok: false, error: `OpenAI error ${res.status}: ${text.slice(0, 200)}` }, 502);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "{}";
    let parsed: { results?: unknown[] };
    try {
      parsed = JSON.parse(content) as { results?: unknown[] };
    } catch {
      return json({ ok: false, error: "Model returned non-JSON output" }, 502);
    }

    const results = Array.isArray(parsed.results) ? parsed.results : [];
    return json({ ok: true, results });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Network error" }, 502);
  }
};
