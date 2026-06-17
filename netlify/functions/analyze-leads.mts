// Analyzes an imported lead list for a given campaign and returns an ICP report
// + a categorisation rubric (categories with match signals + keep/discard
// recommendation). The app then applies the rubric to ALL leads client-side,
// so this one call stays cheap regardless of list size.
// Server-side only — uses OPENAI_API_KEY.

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

const SYSTEM = `You are a B2B cold-email targeting analyst. Given a campaign goal and a SAMPLE of scraped leads (plus aggregate facets), you help the operator weed out leads that don't fit before they spend sending capacity.

Return STRICT JSON only, matching:
{
  "icp_summary": string,                 // 2-3 sentences: who these leads are and the ideal target for THIS campaign
  "insights": string[],                  // 3-6 punchy, useful observations a cold marketer should know before targeting
  "relevance_keywords": string[],        // lowercase terms in a company's description/keywords/title that signal a GOOD fit for this campaign
  "categories": [                        // 4-7 buckets that cover the list
    {
      "key": string,                     // short slug
      "label": string,                   // human label, e.g. "Marketing agencies"
      "description": string,             // one line
      "action": "keep" | "review" | "discard",   // recommended default for this campaign
      "signals": {                       // how to detect membership from lead fields
        "industries": string[],
        "keywords": string[],
        "titles": string[],
        "seniorities": string[]
      }
    }
  ]
}

Rules:
- Base categories and signals on what's actually in the sample (industries, keywords, titles, seniorities).
- Mark groups that clearly don't fit the campaign as "discard"; borderline as "review"; strong fits as "keep".
- Keep signal terms lowercase and specific. Do not invent contact data. JSON only, no prose.`;

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!tokenOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(
      { ok: false, error: "AI is not configured. Add OPENAI_API_KEY in Netlify env vars to enable AI lead analysis." },
      400,
    );
  }

  let payload: {
    campaign?: string;
    sample?: Record<string, unknown>[];
    facets?: unknown;
  };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const sample = (payload.sample ?? []).slice(0, 60);
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const user = JSON.stringify({
    campaign: payload.campaign ?? "(not specified)",
    facets: payload.facets ?? {},
    sample,
  });

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return json({ ok: false, error: `OpenAI error ${res.status}: ${text.slice(0, 200)}` }, 502);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "Model returned non-JSON output" }, 502);
    }
    return json({ ok: true, report: parsed });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Network error" }, 502);
  }
};
