// Shared AI helper for the lead functions. Supports Claude (Anthropic) and
// OpenAI, both returning structured JSON. Imported by analyze-leads and
// classify-leads (filenames starting with "_" aren't exposed as endpoints).
import Anthropic from "@anthropic-ai/sdk";

export type Provider = "openai" | "claude";

export interface RunOpts {
  provider?: Provider;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface RunResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  provider?: Provider;
}

function resolveProvider(p?: Provider): Provider {
  if (p === "openai" || p === "claude") return p;
  return process.env.ANTHROPIC_API_KEY ? "claude" : "openai";
}

export async function runStructured(opts: RunOpts): Promise<RunResult> {
  const provider = resolveProvider(opts.provider);

  if (provider === "claude") {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: "Claude not configured — add ANTHROPIC_API_KEY in Netlify, or switch provider to OpenAI." };
    }
    try {
      const client = new Anthropic();
      const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await client.messages.create({
        model,
        max_tokens: opts.maxTokens ?? 4000,
        system: opts.system,
        output_config: { effort: "medium", format: { type: "json_schema", schema: opts.schema } },
        messages: [{ role: "user", content: opts.user }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      if (resp.stop_reason === "refusal") return { ok: false, error: "Claude declined this request." };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (resp.content || []).find((b: any) => b.type === "text")?.text;
      if (!text) return { ok: false, error: "Empty response from Claude." };
      return { ok: true, data: JSON.parse(text), provider };
    } catch (e) {
      return { ok: false, error: `Claude error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // OpenAI
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, error: "OpenAI not configured — add OPENAI_API_KEY in Netlify, or switch provider to Claude." };
  }
  try {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${opts.system}\nRespond with STRICT JSON only, matching the described shape.` },
          { role: "user", content: opts.user },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: `OpenAI error ${res.status}: ${t.slice(0, 200)}` };
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? "{}";
    return { ok: true, data: JSON.parse(text), provider };
  } catch (e) {
    return { ok: false, error: `OpenAI error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function tokenOk(req: Request): boolean {
  const required = process.env.APP_FUNCTION_TOKEN;
  if (!required) return true;
  return req.headers.get("x-app-token") === required;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
