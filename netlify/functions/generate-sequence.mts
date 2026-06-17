// AI cold-email sequence generator powered by the Anthropic Messages API.
// Server-side so the key is never exposed. If ANTHROPIC_API_KEY is not set it
// returns a clear, actionable error and the UI falls back to a template.
import Anthropic from "@anthropic-ai/sdk";

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

// Platform-specific merge-tag + spintax guidance fed to the model.
const PLATFORM_GUIDE: Record<string, string> = {
  instantly:
    'Instantly.ai: use {{firstName}}, {{lastName}}, {{companyName}}, {{title}}, {{website}}, {{industry}} merge tags. Fallbacks like {{firstName|there}}. Use spintax {Hi|Hey|Hello} for randomized variations to improve deliverability.',
  smartlead: "Smartlead: use {{first_name}}, {{company_name}}, {{title}} snake_case merge tags and spintax {Hi|Hey}.",
  apollo: "Apollo: use {{first_name}}, {{company}}, {{title}} merge tags. Avoid spintax.",
  lemlist: 'lemlist: use {{firstName}}, {{companyName}} with fallback {{firstName|"there"}} and {{spin:Hi|Hey}} syntax.',
  gmail: "Gmail mail-merge: use {FirstName}, {Company} simple merge fields. No spintax.",
  manual: "Generic: use {{firstName}}, {{companyName}} merge tags.",
};

const SYSTEM = `You are an expert B2B cold-email copywriter. You write sequences that sound like a sharp human peer, not a sales machine. Follow these rules strictly:

VOICE & STRUCTURE
- Write like a peer emailing a peer. Use contractions. No corporate filler.
- Every sentence must earn its place. Cold email is ruthlessly short.
- Personalization MUST connect to the prospect's problem — if removing the opener still leaves the email coherent, the personalization is fake. Lead with THEIR world, not yours.
- One ask per email. Prefer low-friction, interest-based CTAs ("Worth a look?") over "book a 30-min call".
- Calibrate length & tone to seniority: C-suite = 2-4 sentences, ultra-brief; mid-level = more specific value; technical = precise, no fluff.

SUBJECT LINES
- Short (2-4 words), lowercase, internal-looking — like a colleague's email. No emojis, no clickbait, no fake "Re:".
- Provide 2-3 variants per email.

FOLLOW-UPS
- Each follow-up adds a NEW angle (new proof, new pain point, a useful resource, a direct question). Never "just checking in".
- Increasing gaps between sends. The final email is a graceful breakup that closes the loop.

NEVER USE these AI/sales tells: "I hope this email finds you well", "I came across your profile", "My name is X and I work at Y", "leverage", "synergy", "best-in-class", "circle back", feature dumps, HTML, multiple links.

PLATFORM
- Use the target platform's exact merge-tag and spintax syntax (provided in the request). Use merge tags for personalization and, when spintax is requested, vary openers/greetings with spintax.

OUTPUT
- Return ONLY the JSON object matching the provided schema. Produce exactly the requested number of emails with the requested cadence (day offsets increasing). Fill angle and goal for each. Respect the requested length preference for word counts.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    emails: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          position: { type: "integer" },
          day: { type: "integer" },
          send_time: { type: "string" },
          subject: { type: "string" },
          subject_variants: { type: "array", items: { type: "string" } },
          body: { type: "string" },
          angle: { type: "string" },
          goal: { type: "string" },
          word_count: { type: "integer" },
        },
        required: ["position", "day", "subject", "subject_variants", "body", "angle", "goal"],
      },
    },
  },
  required: ["emails"],
};

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!tokenOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(
      {
        ok: false,
        error:
          "AI is not configured. Add ANTHROPIC_API_KEY in Netlify env vars to enable Claude sequence generation. You can still use the offline template generator.",
      },
      400,
    );
  }

  let payload: { brief: Record<string, unknown>; platform?: string };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { brief } = payload;
  const platform = payload.platform ?? "instantly";
  if (!brief) return json({ ok: false, error: "Missing brief" }, 400);

  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
  const client = new Anthropic();

  const platformGuide = PLATFORM_GUIDE[platform] ?? PLATFORM_GUIDE.instantly;
  const userPrompt = [
    `Target sending platform: ${platform}. ${platformGuide}`,
    "",
    "Write a cold-email sequence for this brief (JSON):",
    JSON.stringify(brief, null, 2),
    "",
    `Produce exactly ${(brief as { email_count?: number }).email_count ?? 7} emails. The last email must be a breakup. Return JSON only.`,
  ].join("\n");

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", name: "cold_email_sequence", schema: SCHEMA },
      },
      messages: [{ role: "user", content: userPrompt }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    if (response.stop_reason === "refusal") {
      return json({ ok: false, error: "The model declined this request. Adjust the brief and try again." }, 502);
    }

    const textBlock = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    if (!textBlock) return json({ ok: false, error: "Empty response from model" }, 502);

    let parsed: { emails?: unknown[] };
    try {
      parsed = JSON.parse(textBlock.text) as { emails?: unknown[] };
    } catch {
      return json({ ok: false, error: "Model returned non-JSON output" }, 502);
    }

    return json({ ok: true, emails: parsed.emails ?? [], model });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return json({ ok: false, error: `Anthropic API error: ${msg}` }, 502);
  }
};
