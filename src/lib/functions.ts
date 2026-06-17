// ---------------------------------------------------------------------------
// Thin client for the Netlify Functions. These only work once deployed to
// Netlify (or via `netlify dev`). Each call degrades gracefully so the UI can
// fall back to manual entry, exactly as requested.
// ---------------------------------------------------------------------------

const APP_TOKEN = import.meta.env.VITE_APP_TOKEN as string | undefined;

function headers(): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (APP_TOKEN) h["x-app-token"] = APP_TOKEN;
  return h;
}

export interface ExpiryLookup {
  domain: string;
  ok: boolean;
  expiry: string | null; // ISO date
  registrar?: string | null;
  source?: string;
  error?: string;
}

export async function lookupDomainExpiry(domain: string): Promise<ExpiryLookup> {
  try {
    const res = await fetch(
      `/.netlify/functions/domain-expiry?domain=${encodeURIComponent(domain)}`,
      { headers: headers() },
    );
    if (!res.ok) {
      return { domain, ok: false, expiry: null, error: `HTTP ${res.status}` };
    }
    return (await res.json()) as ExpiryLookup;
  } catch (e) {
    return {
      domain,
      ok: false,
      expiry: null,
      error: e instanceof Error ? e.message : "Network error",
    };
  }
}

export interface EnrichRequest {
  leads: {
    id: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    company?: string;
    title?: string;
    website?: string;
    industry?: string;
    location?: string;
  }[];
  instructions: string; // what the user wants the AI to infer/return
  fields: string[]; // which fields to populate, e.g. ["industry","score","summary"]
}

export interface EnrichResult {
  ok: boolean;
  results?: { id: string; [key: string]: unknown }[];
  error?: string;
}

export async function enrichLeads(req: EnrichRequest): Promise<EnrichResult> {
  try {
    const res = await fetch("/.netlify/functions/enrich", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(req),
    });
    const data = (await res.json()) as EnrichResult;
    if (!res.ok) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return data;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
}
