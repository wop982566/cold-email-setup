// ---------------------------------------------------------------------------
// Lead categorisation + relevance scoring. Runs entirely client-side so it
// scales to thousands of rows instantly. AI (optional) produces the category
// rubric; these functions apply it to every lead. Without AI, categories are
// derived from facets + your campaign keywords.
// ---------------------------------------------------------------------------
import { Lead } from "./types";

export type CatAction = "keep" | "review" | "discard";
export type Relevance = "relevant" | "review" | "unrelated";

export interface LeadCategory {
  key: string;
  label: string;
  description: string;
  signals: { industries?: string[]; keywords?: string[]; titles?: string[]; seniorities?: string[] };
  action: CatAction;
}

export interface Verdict {
  category: string;
  relevance: Relevance;
  score: number;
  reason: string;
}

type LeadLike = Omit<Lead, "id"> | Lead;

export function leadText(l: LeadLike): string {
  const c = (l.custom ?? {}) as Record<string, unknown>;
  const get = (k: string) => (c[k] != null ? String(c[k]) : "");
  return [
    l.company,
    l.title,
    l.industry,
    get("Headline"),
    get("Keywords"),
    get("keywords"),
    get("Company Short Description"),
    get("Company SEO Description"),
    get("Department"),
    get("Seniority"),
  ]
    .filter(Boolean)
    .join("  •  ")
    .toLowerCase();
}

function topCounts(values: string[], limit = 12): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const v of values) {
    const k = (v ?? "").trim();
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function employeeBucket(raw: string): string {
  const n = Number(String(raw).replace(/[^0-9]/g, ""));
  if (!n) return "Unknown";
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  if (n <= 1000) return "201-1k";
  return "1k+";
}

export interface Facets {
  industries: { label: string; count: number }[];
  seniorities: { label: string; count: number }[];
  departments: { label: string; count: number }[];
  sizes: { label: string; count: number }[];
  countries: { label: string; count: number }[];
  keywords: { label: string; count: number }[];
}

export function facets(leads: LeadLike[]): Facets {
  const cval = (l: LeadLike, k: string) => String((l.custom as Record<string, unknown>)?.[k] ?? "");
  const kw: string[] = [];
  for (const l of leads) {
    const raw = cval(l, "Keywords") || cval(l, "keywords");
    if (raw) {
      for (const part of raw.split(",")) {
        const t = part.trim().toLowerCase();
        if (t && t.length <= 30) kw.push(t);
      }
    }
  }
  return {
    industries: topCounts(leads.map((l) => l.industry)),
    seniorities: topCounts(leads.map((l) => cval(l, "Seniority"))),
    departments: topCounts(leads.map((l) => cval(l, "Department"))),
    sizes: topCounts(leads.map((l) => employeeBucket(l.employees)), 6),
    countries: topCounts(leads.map((l) => cval(l, "Country") || l.location), 8),
    keywords: topCounts(kw, 30),
  };
}

function catHits(text: string, l: LeadLike, cat: LeadCategory): number {
  let h = 0;
  const ind = (l.industry ?? "").toLowerCase();
  const title = (l.title ?? "").toLowerCase();
  const sen = String((l.custom as Record<string, unknown>)?.["Seniority"] ?? "").toLowerCase();
  for (const k of cat.signals.keywords ?? []) if (k && text.includes(k.toLowerCase())) h++;
  for (const i of cat.signals.industries ?? []) {
    const il = i.toLowerCase();
    if (il && (ind === il || ind.includes(il) || text.includes(il))) h += 2;
  }
  for (const t of cat.signals.titles ?? []) if (t && title.includes(t.toLowerCase())) h++;
  for (const s of cat.signals.seniorities ?? []) if (s && sen.includes(s.toLowerCase())) h++;
  return h;
}

// Assign each lead a category + relevance. `keywords` is the campaign relevance
// net (a lead matching none of them, and not in a "keep" category, is flagged).
export function applyVerdicts(
  leads: LeadLike[],
  categories: LeadCategory[],
  keywords: string[],
): Verdict[] {
  const kws = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  return leads.map((l) => {
    const text = leadText(l);
    let best: LeadCategory | null = null;
    let bestHits = 0;
    for (const cat of categories) {
      const h = catHits(text, l, cat);
      if (h > bestHits) {
        best = cat;
        bestHits = h;
      }
    }
    const kwMatch = kws.length === 0 ? null : kws.some((k) => text.includes(k));

    let relevance: Relevance;
    if (best?.action === "discard") relevance = "unrelated";
    else if (best?.action === "keep") relevance = "relevant";
    else if (kwMatch === true) relevance = "relevant";
    else if (kwMatch === false) relevance = "unrelated";
    else relevance = "review";

    const category: string = best ? best.label : l.industry || "Uncategorized";
    let score: number;
    if (relevance === "relevant") score = Math.min(100, 60 + bestHits * 10 + (kwMatch ? 10 : 0));
    else if (relevance === "review") score = 45 + Math.min(15, bestHits * 5);
    else score = Math.max(5, 30 - bestHits * 5);

    const bits: string[] = [];
    if (best) bits.push(`category "${best.label}"`);
    if (kwMatch === true) bits.push("matched campaign keywords");
    if (kwMatch === false) bits.push("no campaign keyword match");
    return { category, relevance, score, reason: bits.join("; ") || "no strong signal" };
  });
}

// Fallback rubric when AI is off: top industries become keep-categories.
export function buildCategoriesFromFacets(f: Facets): LeadCategory[] {
  return f.industries.slice(0, 8).map((i) => ({
    key: i.label.toLowerCase().replace(/\s+/g, "-"),
    label: i.label,
    description: `Leads in the ${i.label} industry`,
    signals: { industries: [i.label] },
    action: "keep" as CatAction,
  }));
}

export function summarize(verdicts: Verdict[]) {
  let relevant = 0;
  let review = 0;
  let unrelated = 0;
  for (const v of verdicts) {
    if (v.relevance === "relevant") relevant++;
    else if (v.relevance === "review") review++;
    else unrelated++;
  }
  return { relevant, review, unrelated, total: verdicts.length };
}
