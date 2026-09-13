// Builds an ICP report + categorisation rubric from a campaign brief and a
// sample of leads. Provider-aware (Claude or OpenAI). The app applies the
// rubric to ALL leads client-side, so this call stays cheap at any scale.
import { runStructured, tokenOk, json, type Provider } from "./_ai.mts";

const SYSTEM = `You are a B2B cold-email targeting analyst. The operator describes the campaign they want to run; you decide which scraped leads fit and which to weed out, judging from each company's description, keywords, industry, and the contact's title/seniority.

Return STRICT JSON only:
{
  "icp_summary": string,                 // 2-3 sentences: who these leads are + the ideal target for THIS campaign
  "insights": string[],                  // 3-6 useful observations a cold marketer should know before targeting
  "relevance_keywords": string[],        // lowercase terms that, when present in a company's description/keywords/title, signal a GOOD fit
  "categories": [                        // 4-8 buckets that COVER the whole list (every lead should fit one)
    {
      "key": string,
      "label": string,                   // e.g. "Marketing & SEO agencies"
      "description": string,
      "action": "keep" | "review" | "discard",
      "signals": { "industries": string[], "keywords": string[], "titles": string[], "seniorities": string[] }
    }
  ]
}

Rules:
- Read the company descriptions in the sample. Group leads by what the company actually DOES, not just industry labels.
- Mark groups that clearly don't fit the campaign as "discard"; borderline as "review"; strong fits as "keep".
- signals must be concrete, lowercase terms that appear in the data so the app can match them across all leads. Put the strongest discriminating words in "keywords".
- Make categories mutually distinct and collectively exhaustive. JSON only.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    icp_summary: { type: "string" },
    insights: { type: "array", items: { type: "string" } },
    relevance_keywords: { type: "array", items: { type: "string" } },
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          action: { type: "string", enum: ["keep", "review", "discard"] },
          signals: {
            type: "object",
            additionalProperties: false,
            properties: {
              industries: { type: "array", items: { type: "string" } },
              keywords: { type: "array", items: { type: "string" } },
              titles: { type: "array", items: { type: "string" } },
              seniorities: { type: "array", items: { type: "string" } },
            },
            required: ["industries", "keywords", "titles", "seniorities"],
          },
        },
        required: ["key", "label", "description", "action", "signals"],
      },
    },
  },
  required: ["icp_summary", "insights", "relevance_keywords", "categories"],
};

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!tokenOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  let payload: { campaign?: string; sample?: unknown[]; facets?: unknown; provider?: Provider };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const user = JSON.stringify({
    campaign: payload.campaign ?? "(not specified)",
    facets: payload.facets ?? {},
    sample: (payload.sample ?? []).slice(0, 60),
  });

  const res = await runStructured({ provider: payload.provider, system: SYSTEM, user, schema: SCHEMA, maxTokens: 4000 });
  if (!res.ok) return json({ ok: false, error: res.error }, 502);
  return json({ ok: true, report: res.data, provider: res.provider });
};
