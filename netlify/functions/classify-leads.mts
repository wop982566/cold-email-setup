// Per-lead relevance classification. The operator describes the campaign; the
// model reads each lead's company description/keywords/title and decides
// relevant / review / unrelated with a reason. Provider-aware. The client
// sends leads in small batches and shows progress.
import { runStructured, tokenOk, json, type Provider } from "./_ai.mts";

const SYSTEM = `You are a B2B cold-email targeting analyst. The operator gives you a campaign description and a batch of leads (each with company, description, keywords, industry, title). For EACH lead, decide how well it fits THIS campaign by reading what the company actually does.

Return STRICT JSON only:
{
  "results": [
    {
      "id": string,                       // echo the lead's id exactly
      "relevance": "relevant" | "review" | "unrelated",
      "category": string,                 // short bucket label, e.g. "SEO agency"
      "reason": string,                   // one short clause, e.g. "runs an SEO agency — strong fit"
      "score": number                     // 0-100 fit score
    }
  ]
}

Rules:
- Base the decision on the company description/keywords, not just the industry label.
- "relevant" = clearly fits the campaign; "unrelated" = clearly does not; "review" = ambiguous/insufficient signal.
- Return one result per input lead, ids echoed exactly. JSON only.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          relevance: { type: "string", enum: ["relevant", "review", "unrelated"] },
          category: { type: "string" },
          reason: { type: "string" },
          score: { type: "number" },
        },
        required: ["id", "relevance", "category", "reason", "score"],
      },
    },
  },
  required: ["results"],
};

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!tokenOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  let payload: { campaign?: string; leads?: unknown[]; provider?: Provider };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const leads = (payload.leads ?? []).slice(0, 40); // client batches; hard cap for safety
  if (leads.length === 0) return json({ ok: true, results: [] });

  const user = JSON.stringify({ campaign: payload.campaign ?? "(not specified)", leads });
  const res = await runStructured({
    provider: payload.provider,
    system: SYSTEM,
    user,
    schema: SCHEMA,
    maxTokens: 4000,
  });
  if (!res.ok) return json({ ok: false, error: res.error }, 502);
  const data = res.data as { results?: unknown[] };
  return json({ ok: true, results: data.results ?? [], provider: res.provider });
};
