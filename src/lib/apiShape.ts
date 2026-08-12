// ---------------------------------------------------------------------------
// Reading Instantly's response shapes, without depending on the browser.
//
// These two helpers used to live in `instantly.ts` alongside the fetch client.
// That client reads `import.meta.env` at module load — a Vite construct that is
// undefined under Node — so every server-side importer of the planner modules
// inherited a crash on import, because campaignPlan.ts needs `asItems`/`pick`
// and nothing else from that file.
//
// Pure, dependency-free, safe to import from a Netlify function.
// ---------------------------------------------------------------------------

/**
 * Instantly returns either a bare array or `{ items: [...] }` depending on the
 * endpoint and the API revision. Callers shouldn't have to care.
 */
export function asItems<T = Record<string, unknown>>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && Array.isArray((data as { items?: T[] }).items)) {
    return (data as { items: T[] }).items;
  }
  return [];
}

/**
 * First numeric value among `keys`, coercing numeric strings.
 *
 * Field names move between API revisions, so callers pass every name a value
 * has been known by and take whichever answers.
 */
export function pick(obj: Record<string, unknown>, keys: string[], fallback = 0): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  }
  return fallback;
}
