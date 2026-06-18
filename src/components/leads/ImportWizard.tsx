import { useMemo, useState } from "react";
import Papa from "papaparse";
import {
  Upload,
  Sparkles,
  FileText,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  CircleDashed,
  Lightbulb,
  Search,
  Trash2,
  Check,
  Bot,
  Zap,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { Card, Badge, Spinner } from "../ui/primitives";
import { Field, TextField, TextArea, SelectField } from "../ui/Field";
import { useToast } from "../ui/toast";
import { Campaign, Lead } from "../../lib/types";
import { analyzeHeaders, buildLeadFromRow } from "../../lib/leadImport";
import {
  facets as computeFacets,
  applyVerdicts,
  buildCategoriesFromFacets,
  type Facets,
  type LeadCategory,
  type Verdict,
  type CatAction,
  type Relevance,
} from "../../lib/leadAnalysis";
import { analyzeLeads, classifyLeads, type AiProvider } from "../../lib/functions";
import { cn } from "../../lib/utils";

type ParsedLead = Omit<Lead, "id">;
type Step = "upload" | "campaign" | "review";

const STOPWORDS = new Set(
  "the and for with that this our your you who are from into want need looking based their they will would about cold email campaign leads lead target targeting companies company people".split(/\s+/),
);

function keywordsFromText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 4 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 15) break;
  }
  return out;
}

const RELEVANCE_META: Record<Relevance, { label: string; tone: string; icon: JSX.Element }> = {
  relevant: { label: "Relevant", tone: "mint", icon: <CheckCircle2 size={13} /> },
  review: { label: "Review", tone: "sun", icon: <CircleDashed size={13} /> },
  unrelated: { label: "Unrelated", tone: "coral", icon: <XCircle size={13} /> },
};

export interface ImportResult {
  listName: string;
  kept: ParsedLead[];
  discarded: ParsedLead[];
}

export function ImportWizard({
  campaigns,
  existingEmails,
  onClose,
  onComplete,
}: {
  campaigns: Campaign[];
  existingEmails: Set<string>;
  onClose: () => void;
  onComplete: (r: ImportResult) => Promise<void>;
}) {
  const toast = useToast();
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);

  // upload
  const [fileName, setFileName] = useState("");
  const [leads, setLeads] = useState<ParsedLead[]>([]);
  const [report, setReport] = useState<ReturnType<typeof analyzeHeaders> | null>(null);
  const [dupes, setDupes] = useState(0);

  // campaign
  const [campaignText, setCampaignText] = useState("");
  const [listName, setListName] = useState(`Imported ${new Date().toISOString().slice(0, 10)}`);
  const [useAI, setUseAI] = useState(true);
  const [provider, setProvider] = useState<AiProvider>("claude");

  // analysis
  const [categories, setCategories] = useState<LeadCategory[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [icp, setIcp] = useState("");
  const [insights, setInsights] = useState<string[]>([]);
  const [aiVerdicts, setAiVerdicts] = useState<Map<number, Verdict>>(new Map());
  const [classifying, setClassifying] = useState<{ done: number; total: number } | null>(null);

  // selection — a single source of truth (indices to KEEP/import)
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [relFilter, setRelFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const rubric = useMemo<Verdict[]>(
    () => (leads.length ? applyVerdicts(leads, categories, keywords) : []),
    [leads, categories, keywords],
  );
  const verdicts = useMemo<Verdict[]>(
    () => rubric.map((v, i) => aiVerdicts.get(i) ?? v),
    [rubric, aiVerdicts],
  );

  const relCounts = useMemo(() => {
    const c = { relevant: 0, review: 0, unrelated: 0 } as Record<Relevance, number>;
    for (const v of verdicts) c[v.relevance]++;
    return c;
  }, [verdicts]);

  const relKept = useMemo(() => {
    const c = { relevant: 0, review: 0, unrelated: 0 } as Record<Relevance, number>;
    verdicts.forEach((v, i) => {
      if (keep.has(i)) c[v.relevance]++;
    });
    return c;
  }, [verdicts, keep]);

  const categoryRows = useMemo(() => {
    const m = new Map<string, { count: number; kept: number; companies: string[] }>();
    verdicts.forEach((v, i) => {
      const e = m.get(v.category) ?? { count: 0, kept: 0, companies: [] };
      e.count++;
      if (keep.has(i)) e.kept++;
      if (e.companies.length < 3 && leads[i]?.company) e.companies.push(leads[i].company);
      m.set(v.category, e);
    });
    return Array.from(m.entries())
      .map(([label, e]) => ({ label, ...e }))
      .sort((a, b) => b.count - a.count);
  }, [verdicts, leads, keep]);

  const filteredIdx = useMemo(() => {
    const q = search.trim().toLowerCase();
    const idx: number[] = [];
    for (let i = 0; i < leads.length; i++) {
      if (relFilter && verdicts[i]?.relevance !== relFilter) continue;
      if (q) {
        const l = leads[i];
        if (!`${l.company} ${l.email} ${l.title} ${verdicts[i]?.category}`.toLowerCase().includes(q)) continue;
      }
      idx.push(i);
    }
    return idx;
  }, [leads, verdicts, relFilter, search]);

  const pages = Math.max(1, Math.ceil(filteredIdx.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageIdx = filteredIdx.slice(safePage * pageSize, safePage * pageSize + pageSize);

  // ---- selection helpers (all write directly to `keep`) --------------------
  function indicesWhere(pred: (v: Verdict, i: number) => boolean) {
    const out: number[] = [];
    verdicts.forEach((v, i) => {
      if (pred(v, i)) out.push(i);
    });
    return out;
  }
  function setKeepTo(idxs: number[]) {
    setKeep(new Set(idxs));
  }
  function addRemove(idxs: number[], add: boolean) {
    setKeep((prev) => {
      const next = new Set(prev);
      for (const i of idxs) (add ? next.add(i) : next.delete(i));
      return next;
    });
  }
  function toggleRelevanceGroup(rel: Relevance) {
    const idxs = indicesWhere((v) => v.relevance === rel);
    const allIn = idxs.length > 0 && idxs.every((i) => keep.has(i));
    addRemove(idxs, !allIn);
  }
  function setCategoryKeep(label: string, keepIt: boolean) {
    addRemove(indicesWhere((v) => v.category === label), keepIt);
  }

  function handleFile(file: File) {
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const headers = res.meta.fields ?? [];
        const rep = analyzeHeaders(headers);
        const seen = new Set(existingEmails);
        let dup = 0;
        const built: ParsedLead[] = [];
        for (const row of res.data) {
          const lead = buildLeadFromRow(row, null);
          const key = lead.email.trim().toLowerCase();
          if (!key) continue;
          if (seen.has(key)) {
            dup++;
            continue;
          }
          seen.add(key);
          built.push(lead);
        }
        setReport(rep);
        setLeads(built);
        setDupes(dup);
        if (built.length === 0) toast.push("No new leads found (missing email or all duplicates)", "error");
      },
      error: () => toast.push("Failed to parse CSV", "error"),
    });
  }

  async function doComplete(kept: ParsedLead[], discarded: ParsedLead[]) {
    setBusy(true);
    try {
      await onComplete({ listName: listName.trim() || "Imported list", kept, discarded });
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Import failed", "error");
      setBusy(false);
    }
  }

  function quickImport() {
    if (leads.length === 0) return;
    doComplete(leads.map((l) => ({ ...l, discarded: false })), []);
  }

  async function runAnalysis() {
    setBusy(true);
    setAiVerdicts(new Map());
    const f = computeFacets(leads);
    let cats: LeadCategory[] = [];
    let kws = keywordsFromText(campaignText);
    let summary = "";
    let ins: string[] = [];

    if (useAI) {
      const sample = leads.slice(0, 50).map((l) => ({
        company: l.company,
        title: l.title,
        industry: l.industry,
        headline: String(l.custom?.["Headline"] ?? "").slice(0, 160),
        keywords: String(l.custom?.["Keywords"] ?? l.custom?.["keywords"] ?? "").slice(0, 220),
        description: String(l.custom?.["Company Short Description"] ?? l.custom?.["Company SEO Description"] ?? "").slice(0, 260),
        seniority: String(l.custom?.["Seniority"] ?? ""),
      }));
      const res = await analyzeLeads({ campaign: campaignText, sample, facets: f, provider });
      if (res.ok && res.report) {
        cats = (res.report.categories ?? []).map((c) => ({
          key: c.key,
          label: c.label,
          description: c.description,
          action: (c.action ?? "review") as CatAction,
          signals: c.signals ?? {},
        }));
        kws = Array.from(new Set([...(res.report.relevance_keywords ?? []), ...kws]));
        summary = res.report.icp_summary ?? "";
        ins = res.report.insights ?? [];
      } else {
        toast.push(res.error ?? "AI analysis unavailable — using rule-based categories.", "info");
      }
    }
    if (cats.length === 0) {
      cats = buildCategoriesFromFacets(f);
      if (!summary)
        summary = `${leads.length} leads across ${f.industries.length} industries. Top: ${f.industries.slice(0, 3).map((i) => i.label).join(", ")}.`;
      if (ins.length === 0)
        ins = [
          `Largest segment: ${f.industries[0]?.label ?? "—"} (${f.industries[0]?.count ?? 0} leads).`,
          `Seniority skews to ${f.seniorities[0]?.label ?? "—"}.`,
          `Most common size band: ${f.sizes[0]?.label ?? "—"}.`,
        ];
    }
    setCategories(cats);
    setKeywords(kws);
    setIcp(summary);
    setInsights(ins);
    // Default keep = everything the AI didn't flag as unrelated.
    const initial = applyVerdicts(leads, cats, kws);
    setKeep(new Set(initial.map((v, i) => (v.relevance !== "unrelated" ? i : -1)).filter((i) => i >= 0)));
    setBusy(false);
    setStep("review");
  }

  async function deepClassify() {
    const idxs = filteredIdx;
    if (idxs.length === 0) return;
    if (idxs.length > 400 && !confirm(`Deep-classify ${idxs.length} leads with AI? Tip: filter to the "Review" bucket first to save time/tokens.`)) {
      return;
    }
    setClassifying({ done: 0, total: idxs.length });
    const BATCH = 25;
    const next = new Map(aiVerdicts);
    for (let b = 0; b < idxs.length; b += BATCH) {
      const batch = idxs.slice(b, b + BATCH);
      const payloadLeads = batch.map((i) => {
        const l = leads[i];
        return {
          id: String(i),
          company: l.company,
          title: l.title,
          industry: l.industry,
          description: String(l.custom?.["Company Short Description"] ?? l.custom?.["Company SEO Description"] ?? "").slice(0, 300),
          keywords: String(l.custom?.["Keywords"] ?? l.custom?.["keywords"] ?? "").slice(0, 200),
        };
      });
      const res = await classifyLeads({ campaign: campaignText, leads: payloadLeads, provider });
      if (!res.ok) {
        toast.push(res.error ?? "AI classification failed", "error");
        break;
      }
      for (const r of res.results ?? []) {
        const i = Number(r.id);
        if (Number.isNaN(i)) continue;
        next.set(i, {
          category: r.category || "Uncategorized",
          relevance: r.relevance,
          score: Math.round(r.score) || (r.relevance === "relevant" ? 80 : r.relevance === "unrelated" ? 15 : 50),
          reason: r.reason || "",
        });
      }
      setAiVerdicts(new Map(next));
      setClassifying({ done: Math.min(b + BATCH, idxs.length), total: idxs.length });
    }
    setClassifying(null);
    toast.push('Re-classified. Use "Relevant only" to update your selection.', "success");
  }

  function finalize() {
    const kept: ParsedLead[] = [];
    const discarded: ParsedLead[] = [];
    leads.forEach((l, i) => {
      const v = verdicts[i];
      const enriched: ParsedLead = { ...l, category: v?.category ?? "", relevance: v?.relevance ?? "", score: v?.score ?? l.score };
      if (keep.has(i)) kept.push({ ...enriched, discarded: false });
      else discarded.push({ ...enriched, discarded: true, discarded_at: new Date().toISOString() });
    });
    doComplete(kept, discarded);
  }

  const ProviderPicker = (
    <div className="flex items-center gap-2">
      <span className="text-xs font-bold text-muted">AI model</span>
      <div className="flex rounded-xl border-2 border-ink">
        {(["claude", "openai"] as AiProvider[]).map((p) => (
          <button
            key={p}
            onClick={() => setProvider(p)}
            className={cn("px-3 py-1.5 text-xs font-bold first:rounded-l-lg last:rounded-r-lg", provider === p ? "bg-ink text-paper" : "bg-paper hover:bg-canvas")}
          >
            {p === "claude" ? "Claude" : "OpenAI"}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Modal open onClose={onClose} size="xl" title="Import & enrich leads">
      {/* Step indicator */}
      <div className="mb-4 flex items-center gap-2 text-xs font-bold">
        {(["upload", "campaign", "review"] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <span className={cn("flex h-6 w-6 items-center justify-center rounded-full border-2 border-ink", step === s ? "bg-pink" : "bg-white")}>{i + 1}</span>
            <span className={cn("uppercase", step === s ? "text-ink" : "text-muted")}>
              {s === "upload" ? "Upload" : s === "campaign" ? "Campaign" : "Report & weed"}
            </span>
            {i < 2 ? <ArrowRight size={12} className="text-muted" /> : null}
          </div>
        ))}
      </div>

      {step === "upload" ? (
        <div className="space-y-4">
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-ink/50 bg-canvas p-8 text-center hover:bg-white">
            <Upload size={28} />
            <p className="mt-2 font-bold">{fileName || "Choose a CSV of scraped leads"}</p>
            <p className="text-xs text-muted">Apollo / Instantly / any CSV — every column is preserved</p>
            <input type="file" accept=".csv" className="hidden" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
          </label>

          {report ? (
            <>
              <Card className="p-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Valid leads" value={leads.length} tone="mint" />
                  <Stat label="Duplicates skipped" value={dupes} tone="sun" />
                  <Stat label="Mapped fields" value={report.mappedFields.length} tone="lavender" />
                  <Stat label="Extra columns kept" value={report.extraColumns.length} tone="sky" />
                </div>
                {!report.hasEmailColumn ? (
                  <p className="mt-3 rounded-lg border-2 border-ink bg-danger px-3 py-1.5 text-sm font-bold text-white">No email column detected — can't import without emails.</p>
                ) : null}
              </Card>
              <Card className="flex flex-wrap items-center gap-2 bg-canvas p-3">
                <FileText size={16} />
                <span className="text-sm font-bold">Quick import — skip AI, just add them:</span>
                <input className="input w-48 py-1.5 text-sm" value={listName} onChange={(e) => setListName(e.target.value)} placeholder="List name" />
                <button className="btn-ghost btn-sm" disabled={leads.length === 0 || !report.hasEmailColumn || busy} onClick={quickImport}>
                  <Upload size={14} /> {busy ? "Importing…" : `Quick import ${leads.length}`}
                </button>
              </Card>
            </>
          ) : null}

          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={leads.length === 0 || !report?.hasEmailColumn} onClick={() => setStep("campaign")}>
              Analyze &amp; weed <ArrowRight size={16} />
            </button>
          </div>
        </div>
      ) : null}

      {step === "campaign" ? (
        <div className="space-y-4">
          <Field label="What campaign are you running?" hint="Describe your offer + ideal target. The AI reads each company's description to flag leads that don't fit.">
            <TextArea rows={4} value={campaignText} onChange={setCampaignText} placeholder="e.g. Backlink/guest-post outreach to SEO & marketing agencies (10-200 staff) in the US. Avoid big enterprises and non-marketing companies." />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Save imported leads as (list name)">
              <TextField value={listName} onChange={setListName} />
            </Field>
            <Field label="Prefill from a campaign (optional)">
              <SelectField value="" onChange={(id) => { const c = campaigns.find((x) => x.id === id); if (c) setCampaignText((t) => t || `${c.name}: ${c.description}`); }} options={[{ value: "", label: "—" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))]} />
            </Field>
          </div>
          <Card className="flex flex-wrap items-center justify-between gap-3 bg-lavender/40 p-3">
            <label className="flex items-center gap-2 text-sm font-bold">
              <input type="checkbox" checked={useAI} onChange={(e) => setUseAI(e.target.checked)} />
              <Bot size={16} /> Use AI to analyze &amp; categorize
            </label>
            {useAI ? ProviderPicker : null}
          </Card>
          <div className="flex justify-between gap-2">
            <button className="btn-ghost" onClick={() => setStep("upload")}><ArrowLeft size={16} /> Back</button>
            <button className="btn-primary" onClick={runAnalysis} disabled={busy}>
              {busy ? "Analyzing…" : useAI ? `Analyze with ${provider === "claude" ? "Claude" : "OpenAI"}` : "Build report"} <Sparkles size={16} />
            </button>
          </div>
          {busy ? <Spinner label="Analyzing leads…" /> : null}
        </div>
      ) : null}

      {step === "review" ? (
        <div className="space-y-4">
          {icp ? (
            <Card className="bg-pink/20 p-4">
              <p className="text-xs font-bold uppercase text-muted">ICP analysis</p>
              <p className="mt-1 text-sm font-semibold">{icp}</p>
            </Card>
          ) : null}

          {insights.length ? (
            <Card className="p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-bold"><Lightbulb size={15} /> What to know before targeting</p>
              <ul className="space-y-1 text-sm">
                {insights.map((s, i) => (<li key={i} className="flex gap-2"><span className="text-pink-dark">•</span>{s}</li>))}
              </ul>
            </Card>
          ) : null}

          {/* Quick presets — the simple path */}
          <Card className="p-3">
            <p className="mb-2 text-xs font-bold uppercase text-muted">Choose what to import</p>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary btn-sm" onClick={() => setKeepTo(indicesWhere((v) => v.relevance === "relevant"))}>
                Relevant only ({relCounts.relevant})
              </button>
              <button className="btn-ghost btn-sm" onClick={() => setKeepTo(indicesWhere((v) => v.relevance !== "unrelated"))}>
                Relevant + Review ({relCounts.relevant + relCounts.review})
              </button>
              <button className="btn-ghost btn-sm" onClick={() => setKeepTo(leads.map((_, i) => i))}>All ({leads.length})</button>
              <button className="btn-ghost btn-sm" onClick={() => setKeep(new Set())}>None</button>
            </div>
          </Card>

          {/* Relevance groups — click to add/remove the whole group */}
          <div className="grid grid-cols-3 gap-3">
            {(["relevant", "review", "unrelated"] as Relevance[]).map((r) => {
              const meta = RELEVANCE_META[r];
              const fullyKept = relCounts[r] > 0 && relKept[r] === relCounts[r];
              return (
                <button key={r} onClick={() => toggleRelevanceGroup(r)} className={cn("rounded-xl border-2 border-ink p-3 text-left transition-all", fullyKept ? "shadow-hard-sm" : "")}>
                  <div className="flex items-center justify-between">
                    <Badge tone={meta.tone as "mint"}>{meta.icon} {meta.label}</Badge>
                    {fullyKept ? <Check size={14} /> : null}
                  </div>
                  <p className="mt-2 text-2xl font-extrabold">{relCounts[r]}</p>
                  <p className="text-xs text-muted">{relKept[r]} of {relCounts[r]} kept · click to toggle</p>
                </button>
              );
            })}
          </div>

          {/* Deep AI classify */}
          <Card className="flex flex-wrap items-center justify-between gap-2 bg-sky/20 p-3">
            <div className="flex items-center gap-2 text-sm">
              <Zap size={16} />
              <span className="font-bold">Deep AI relevance check</span>
              <span className="text-muted">— reads each company's description and re-scores the filtered leads.</span>
            </div>
            <div className="flex items-center gap-2">
              {ProviderPicker}
              <button className="btn-sun btn-sm" onClick={deepClassify} disabled={!!classifying}>
                <Bot size={14} /> {classifying ? `Classifying ${classifying.done}/${classifying.total}…` : `Classify ${filteredIdx.length}`}
              </button>
            </div>
          </Card>

          {/* Categories — keep/discard a whole bucket */}
          <Card className="overflow-hidden p-0">
            <div className="border-b-2 border-ink p-3"><p className="text-sm font-bold">Categories — keep or discard a whole group</p></div>
            <div className="max-h-48 overflow-auto">
              <table className="w-full text-left text-sm">
                <tbody>
                  {categoryRows.map((c) => (
                    <tr key={c.label} className="border-b border-ink/10">
                      <td className="px-3 py-2">
                        <p className="font-bold">{c.label}</p>
                        <p className="truncate text-xs text-muted">{c.companies.join(", ")}</p>
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-muted">{c.kept}/{c.count} kept</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <button className="btn-ghost btn-sm" onClick={() => setCategoryKeep(c.label, true)}>Keep</button>
                          <button className="btn-ghost btn-sm" onClick={() => setCategoryKeep(c.label, false)}>Discard</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Lead table */}
          <Card className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center gap-2 border-b-2 border-ink p-3">
              <div className="relative min-w-[160px] flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input className="input py-1.5 pl-8 text-sm" placeholder="Search…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
              </div>
              <select className="input w-32 cursor-pointer py-1.5 text-sm" value={relFilter} onChange={(e) => { setRelFilter(e.target.value); setPage(0); }}>
                <option value="">All relevance</option>
                <option value="relevant">Relevant</option>
                <option value="review">Review</option>
                <option value="unrelated">Unrelated</option>
              </select>
              <button className="btn-ghost btn-sm" onClick={() => addRemove(filteredIdx, true)}>Keep shown</button>
              <button className="btn-ghost btn-sm" onClick={() => addRemove(filteredIdx, false)}>Discard shown</button>
            </div>
            <div className="max-h-72 overflow-auto">
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                    <th className="w-10 px-2 py-2"></th>
                    <th className="px-2 py-2" style={{ width: "26%" }}>Lead</th>
                    <th className="px-2 py-2" style={{ width: "18%" }}>Category</th>
                    <th className="px-2 py-2" style={{ width: "30%" }}>Why</th>
                    <th className="px-2 py-2">Fit</th>
                    <th className="w-12 px-2 py-2 text-right">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {pageIdx.map((i) => {
                    const l = leads[i];
                    const v = verdicts[i];
                    const kept = keep.has(i);
                    return (
                      <tr key={i} className={cn("border-b border-ink/10", !kept && "bg-coral/10")}>
                        <td className="px-2 py-2">
                          <input type="checkbox" checked={kept} onChange={(e) => addRemove([i], e.target.checked)} />
                        </td>
                        <td className="px-2 py-2">
                          <p className="truncate font-bold" title={l.company}>{l.company || l.email}</p>
                          <p className="truncate text-xs text-muted" title={l.title}>{l.title || l.email}</p>
                        </td>
                        <td className="truncate px-2 py-2" title={v?.category}>{v?.category}</td>
                        <td className="truncate px-2 py-2 text-xs text-muted" title={v?.reason}>{v?.reason || "—"}</td>
                        <td className="px-2 py-2"><Badge tone={RELEVANCE_META[v?.relevance ?? "review"].tone as "mint"}>{RELEVANCE_META[v?.relevance ?? "review"].label}</Badge></td>
                        <td className="px-2 py-2 text-right font-bold">{v?.score}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t-2 border-ink p-2 text-xs">
              <span className="text-muted">{filteredIdx.length} shown</span>
              <div className="flex items-center gap-2">
                <button className="btn-ghost btn-sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Prev</button>
                <span>{safePage + 1}/{pages}</span>
                <button className="btn-ghost btn-sm" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>Next</button>
              </div>
            </div>
          </Card>

          {/* Finalize */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-ink bg-canvas p-3">
            <div className="flex items-center gap-2">
              <FileText size={16} />
              <input className="input w-56 py-1.5 text-sm" value={listName} onChange={(e) => setListName(e.target.value)} />
            </div>
            <div className="flex items-center gap-3 text-sm font-bold">
              <span className="flex items-center gap-1 text-mint"><Check size={14} /> Import {keep.size}</span>
              <span className="flex items-center gap-1 text-coral"><Trash2 size={14} /> Discard {leads.length - keep.size}</span>
            </div>
          </div>

          <div className="flex justify-between gap-2">
            <button className="btn-ghost" onClick={() => setStep("campaign")}><ArrowLeft size={16} /> Back</button>
            <button className="btn-primary" onClick={finalize} disabled={busy || leads.length === 0}>
              {busy ? "Importing…" : `Import ${keep.size} → "${listName}"`}
            </button>
          </div>
          <p className="text-center text-xs text-muted">
            Discarded leads aren't deleted — they go to the Discarded folder where you can restore them anytime.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  const bg: Record<string, string> = { mint: "bg-mint text-white", sun: "bg-sun", lavender: "bg-lavender", sky: "bg-sky" };
  return (
    <div className={cn("rounded-xl border-2 border-ink p-3", bg[tone])}>
      <p className="text-xs font-bold uppercase opacity-70">{label}</p>
      <p className="text-2xl font-extrabold">{value}</p>
    </div>
  );
}
