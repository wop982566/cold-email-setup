// Client for the Instantly proxy function. All calls go through
// /.netlify/functions/instantly so the API key stays server-side.
const APP_TOKEN = import.meta.env.VITE_APP_TOKEN as string | undefined;

function headers(extra?: Record<string, string>): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (APP_TOKEN) h["x-app-token"] = APP_TOKEN;
  return h;
}

export interface InstantlyResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  configured?: boolean;
}

async function call<T>(resource: string, params: Record<string, string> = {}): Promise<InstantlyResult<T>> {
  try {
    const qs = new URLSearchParams({ resource, ...params });
    const res = await fetch(`/.netlify/functions/instantly?${qs}`, { headers: headers() });
    const body = (await res.json()) as InstantlyResult<T>;
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}`, configured: body.configured };
    return body;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error (functions only run on Netlify)" };
  }
}

export type DateRange = "7d" | "30d" | "90d" | "all";

export function rangeParams(range: DateRange): Record<string, string> {
  if (range === "all") return {};
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start_date: fmt(start), end_date: fmt(end) };
}

// Instantly list endpoints return { items: [...] }; analytics may return an
// array or an object — normalise to an array where appropriate.
export function asItems<T = Record<string, unknown>>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && Array.isArray((data as { items?: T[] }).items)) {
    return (data as { items: T[] }).items;
  }
  return [];
}

export const instantly = {
  accounts: () => call("accounts", { limit: "100" }),
  campaigns: () => call("campaigns", { limit: "100" }),
  analyticsOverview: (range: DateRange) => call("analytics-overview", rangeParams(range)),
  campaignAnalytics: (range: DateRange) => call("analytics-campaigns", rangeParams(range)),
  warmup: async (emails: string[]): Promise<InstantlyResult> => {
    try {
      const res = await fetch("/.netlify/functions/instantly?resource=warmup", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ emails }),
      });
      const body = (await res.json()) as InstantlyResult;
      if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
      return body;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Network error" };
    }
  },
};

// Pull a numeric stat from a record trying several known Instantly field names.
export function pick(obj: Record<string, unknown>, keys: string[], fallback = 0): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  }
  return fallback;
}
