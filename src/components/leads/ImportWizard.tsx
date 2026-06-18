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
  ShieldCheck,
  RefreshCw,
  AlertTriangle,
  Database,
  ChevronDown,
  ChevronRight,
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
import { instantly, asItems, type InstantlyLead } from "../../lib/instantly";
import { cn } from "../../lib/utils";

type ParsedLead = Omit<Lead, "id">;
type Step = "upload" | "campaign" | "review";

// A row we removed during parsing, with the reason why — for full transparency.
type DupReason = "file" | "tool";
interface DupSample {
  email: string;
  company: string;
  reason: DupReason;
}

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

  // upload — `allLeads` is every unique, email-bearing row kept after removing
  // in-file and already-in-tool duplicates. The importable `leads` set is
  // derived from it (optionally minus Instantly matches) further down.
  const [fileName, setFileName] = useState("");
  const [totalRows, setTotalRows] = useState(0);
  const [allLeads, setAllLeads] = useState<ParsedLead[]>([]);
  const [report, setReport] = useState<ReturnType<typeof analyzeHeaders> | null>(null);
  const [dupInFile, setDupInFile] = useState(0);
  const [dupInTool, setDupInTool] = useState(0);
  const [dupSamples, setDupSamples] = useState<DupSample[]>([]);
  const [showDupDetail, setShowDupDetail] = useState(false);

  // Instantly cross-check (Step 1)
  const [instMode, setInstMode] = useState<"contacted" | "any">("contacted");
  const [instBusy, setInstBusy] = useState(false);
  const [instErr, setInstErr] = useState<string | null>(null);
  const [instConfigured, setInstConfigured] = useState(true);
  const [instChecked, setInstChecked] = useState(false);
  const [instMap, setInstMap] = useState<Map<string, InstantlyLead>>(new Map());
  const [instScanned, setInstScanned] = useState(0);
  const [instTruncated, setInstTruncated] = useState(false);
  const [excludeInst, setExcludeInst] = useState(true);
  const [showInstDetail, setShowInstDetail] = useState(false);
  const [instCampaigns, setInstCampaigns] = useState<Record<string, string>>({});

  // Which of our parsed leads already exist in Instantly (filtered by mode).
  const instMatches = useMemo(() => {
    if (instMap.size === 0) return [] as { lead: ParsedLead; remote: InstantlyLead }[];
    const out: { lead: ParsedLead; remote: InstantlyLead }[] = [];
    for (const l of allLeads) {
      const r = instMap.get(l.email.trim().toLowerCase());
      if (!r) continue;
      if (instMode === "contacted" && !r.contacted) continue;
      out.push({ lead: l, remote: r });
    }
    return out;
  }, [allLeads, instMap, instMode]);

  const instPresent = useMemo(() => {
    if (instMap.size === 0) return 0;
    let n = 0;
    for (const l of allLeads) if (instMap.has(l.email.trim().toLowerCase())) n++;
    return n;
  }, [allLeads, instMap]);
  const instEmailed = useMemo(() => {
    if (instMap.size === 0) return 0;
    let n = 0;
    for (const l of allLeads) {
      const r = instMap.get(l.email.trim().toLowerCase());
      if (r?.contacted) n++;
    }
    return n;
  }, [allLeads, instMap]);

  const instMatchEmails = useMemo(
    () => new Set(instMatches.map((m) => m.lead.email.trim().toLowerCase())),
    [instMatches],
  );

  // The set that actually flows into analysis + import.
  const leads = useMemo<ParsedLead[]>(
    () =>
      excludeInst && instChecked
        ? allLeads.filter((l) => !instMatchEmails.has(l.email.trim().toLowerCase()))
        : allLeads,
    [allLeads, excludeInst, instChecked, instMatchEmails],
  );

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
  // manual fit overrides (index -> relevance) so the operator can re-classify
  const [fitOverride, setFitOverride] = useState<Map<number, Relevance>>(new Map());
  const [relFilter, setRelFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const rubric = useMemo<Verdict[]>(
    () => (leads.length ? applyVerdicts(leads, categories, keywords) : []),
    [leads, categories, keywords],
  );
  const verdicts = useMemo<Verdict[]>(
    () =>
      rubric.map((v, i) => {
        const base = aiVerdicts.get(i) ?? v;
        const fo = fitOverride.get(i);
        return fo && fo !== base.relevance ? { ...base, relevance: fo } : base;
      }),
    [rubric, aiVerdicts, fitOverride],
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
    // Reset any prior Instantly cross-check when a new file is loaded.
    setInstChecked(false);
    setInstMap(new Map());
    setInstErr(null);
    setShowInstDetail(false);
    setShowDupDetail(false);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const headers = res.meta.fields ?? [];
        const rep = analyzeHeaders(headers);
        const fileSeen = new Set<string>(); // emails seen so far IN THIS FILE
        let inFile = 0;
        let inTool = 0;
        const samples: DupSample[] = [];
        const built: ParsedLead[] = [];
        for (const row of res.data) {
          const lead = buildLeadFromRow(row, null);
          const key = lead.email.trim().toLowerCase();
          if (!key) continue; // no email — not a duplicate, just unusable
          if (fileSeen.has(key)) {
            inFile++;
            if (samples.length < 200) samples.push({ email: key, company: lead.company, reason: "file" });
            continue;
          }
          fileSeen.add(key);
          if (existingEmails.has(key)) {
            inTool++;
            if (samples.length < 200) samples.push({ email: key, company: lead.company, reason: "tool" });
            continue;
          }
          built.push(lead);
        }
        setReport(rep);
        setTotalRows(res.data.length);
        setAllLeads(built);
        setDupInFile(inFile);
        setDupInTool(inTool);
        setDupSamples(samples);
        if (built.length === 0) toast.push("No new leads found (missing email or all duplicates)", "error");
      },
      error: () => toast.push("Failed to parse CSV", "error"),
    });
  }

  async function crossCheckInstantly() {
    setInstBusy(true);
    setInstErr(null);
    const [res, camp] = await Promise.all([instantly.workspaceLeads(), instantly.campaigns()]);
    setInstBusy(false);
    setInstChecked(true);
    if (!res.ok || !res.data) {
      setInstConfigured(res.configured !== false);
      setInstErr(res.error ?? "Could not reach Instantly.");
      setInstMap(new Map());
      return;
    }
    setInstConfigured(true);
    setInstMap(new Map(res.data.items.map((r) => [r.email, r])));
    setInstScanned(res.data.count);
    setInstTruncated(res.data.truncated);
    if (camp.ok) {
      const map: Record<string, string> = {};
      for (const c of asItems<{ id?: string; name?: string }>(camp.data)) if (c.id) map[c.id] = c.name ?? c.id;
      setInstCampaigns(map);
    }
    setShowInstDetail(true);
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

  function setFitShown(rel: Relevance) {
    setFitOverride((m) => {
      const next = new Map(m);
      for (const i of filteredIdx) next.set(i, rel);
      return next;
    });
  }

  async function runAnalysis() {
    setBusy(true);
    setAiVerdicts(new Map());
    setFitOverride(new Map());
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
      const enriched: ParsedLead = {
        ...l,
        category: v?.category ?? "",
        relevance: v?.relevance ?? "",
        score: v?.score ?? l.score,
        enrichment: { ...(l.enrichment as Record<string, unknown>), reason: v?.reason ?? "" },
      };
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
              {/* Headline stats */}
              <Card className="p-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Ready to import" value={leads.length} tone="mint" sub={`of ${totalRows} rows`} />
                  <button className="block h-full w-full text-left" onClick={() => setShowDupDetail((v) => !v)} title="See exactly which rows were removed and why">
                    <Stat
                      label="Duplicates removed"
                      value={dupInFile + dupInTool}
                      tone="sun"
                      sub={showDupDetail ? "hide details ▲" : "show details ▾"}
                    />
                  </button>
                  <Stat label="Mapped fields" value={report.mappedFields.length} tone="lavender" />
                  <Stat label="Extra columns kept" value={report.extraColumns.length} tone="sky" />
                </div>

                {!report.hasEmailColumn ? (
                  <p className="mt-3 rounded-lg border-2 border-ink bg-danger px-3 py-1.5 text-sm font-bold text-white">No email column detected — can't import without emails.</p>
                ) : null}

                {/* Where duplicates came from — full transparency */}
                <div className="mt-3 rounded-lg border-2 border-ink/20 bg-canvas p-3 text-sm">
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted">How duplicates were detected</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span className="flex items-center gap-1.5">
                      <Badge tone={dupInFile ? "sun" : "white"}>{dupInFile}</Badge> repeated within this CSV file
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Badge tone={dupInTool ? "sun" : "white"}>{dupInTool}</Badge> already saved in this tool
                    </span>
                    <span className="flex items-center gap-1.5 text-muted">
                      <ShieldCheck size={13} /> Instantly: {instChecked ? `${instMatches.length} matched` : "not checked yet — see below"}
                    </span>
                  </div>
                  {showDupDetail ? (
                    <div className="mt-2 max-h-44 overflow-auto rounded-lg border-2 border-ink/15">
                      {dupSamples.length === 0 ? (
                        <p className="p-2 text-xs text-muted">No duplicates were removed.</p>
                      ) : (
                        <table className="w-full text-left text-xs">
                          <tbody>
                            {dupSamples.map((d, i) => (
                              <tr key={i} className="border-b border-ink/10">
                                <td className="px-2 py-1 font-semibold">{d.email}</td>
                                <td className="truncate px-2 py-1 text-muted">{d.company || "—"}</td>
                                <td className="px-2 py-1 text-right">
                                  <Badge tone="white">{d.reason === "file" ? "in this file" : "in your tool"}</Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {dupInFile + dupInTool > dupSamples.length ? (
                        <p className="p-2 text-xs text-muted">…and {dupInFile + dupInTool - dupSamples.length} more.</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </Card>

              {/* Instantly cross-check */}
              <Card className="p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-bold">
                    <ShieldCheck size={16} /> Cross-check against Instantly
                  </p>
                  <button
                    className="btn-dark btn-sm"
                    onClick={crossCheckInstantly}
                    disabled={instBusy || allLeads.length === 0}
                  >
                    <RefreshCw size={14} className={instBusy ? "animate-spin" : ""} />
                    {instBusy ? "Scanning…" : instChecked ? "Re-scan" : "Scan Instantly"}
                  </button>
                </div>
                <p className="mb-2 text-xs text-muted">
                  Checks these {allLeads.length} new leads against every contact in your connected Instantly workspace —
                  so you can catch people Instantly is already emailing before you import them again.
                </p>

                {/* What counts as an Instantly duplicate */}
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-muted">Count as duplicate when:</span>
                  {(["contacted", "any"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setInstMode(m)}
                      className={cn(
                        "rounded-lg border-2 border-ink px-2 py-1 font-bold",
                        instMode === m ? "bg-sun" : "bg-paper hover:bg-canvas",
                      )}
                    >
                      {m === "contacted" ? "Instantly already emailed them" : "Present in workspace at all"}
                    </button>
                  ))}
                </div>

                {instBusy ? (
                  <div className="flex items-center gap-2 rounded-lg border-2 border-ink/20 p-3 text-sm">
                    <RefreshCw size={14} className="animate-spin" /> Loading Instantly contacts…
                  </div>
                ) : instErr ? (
                  <div className="space-y-1 rounded-lg border-2 border-coral bg-coral/10 p-3 text-sm">
                    <p className="flex items-center gap-2 font-bold">
                      <AlertTriangle size={14} /> {instConfigured ? "Instantly error" : "Instantly not connected"}
                    </p>
                    <p>{instErr}</p>
                    {!instConfigured ? (
                      <p className="text-muted">
                        Add <code>INSTANTLY_API_KEY</code> (a v2 key with read scope on leads) in Netlify, redeploy, then
                        re-scan. You can still import without this check.
                      </p>
                    ) : null}
                  </div>
                ) : instChecked ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={instMatches.length ? "coral" : "mint"}>
                        {instMatches.length} of your {allLeads.length} already in Instantly
                        {instMode === "contacted" ? " (emailed)" : ""}
                      </Badge>
                      {instMode === "contacted" && instPresent > instEmailed ? (
                        <Badge tone="white">{instPresent - instEmailed} present but not yet emailed (ignored)</Badge>
                      ) : null}
                      <Badge tone="lavender">{instScanned.toLocaleString()} contacts scanned</Badge>
                      {instTruncated ? <Badge tone="sun">partial scan — very large workspace</Badge> : null}
                      {instMatches.length ? (
                        <button className="ml-auto text-xs underline" onClick={() => setShowInstDetail((v) => !v)}>
                          {showInstDetail ? "hide" : "show"} matches
                        </button>
                      ) : null}
                    </div>

                    {instMatches.length ? (
                      <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg border-2 border-ink bg-sun/40 p-2 text-sm font-bold">
                        <input type="checkbox" checked={excludeInst} onChange={(e) => setExcludeInst(e.target.checked)} />
                        Exclude these {instMatches.length} from the import (recommended)
                      </label>
                    ) : (
                      <p className="mt-2 flex items-center gap-2 text-sm font-bold text-mint">
                        <CheckCircle2 size={15} /> None of these leads are
                        {instMode === "contacted" ? " being emailed by" : " in"} Instantly yet.
                      </p>
                    )}

                    {showInstDetail && instMatches.length ? (
                      <div className="mt-2 max-h-44 overflow-auto rounded-lg border-2 border-ink/15">
                        <table className="w-full text-left text-xs">
                          <tbody>
                            {instMatches.slice(0, 200).map((m, i) => (
                              <tr key={i} className="border-b border-ink/10">
                                <td className="px-2 py-1 font-semibold">{m.lead.email}</td>
                                <td className="truncate px-2 py-1 text-muted">{m.lead.company || "—"}</td>
                                <td className="px-2 py-1 text-muted">
                                  {m.remote.campaign ? instCampaigns[m.remote.campaign] ?? "in a campaign" : "in workspace"}
                                </td>
                                <td className="px-2 py-1 text-right">
                                  <Badge tone={m.remote.contacted ? "mint" : "white"}>
                                    {m.remote.contacted ? "emailed" : "not emailed"}
                                  </Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {instMatches.length > 200 ? (
                          <p className="p-2 text-xs text-muted">…and {instMatches.length - 200} more.</p>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg border-2 border-dashed border-ink/30 p-3 text-sm text-muted">
                    <Database size={15} /> Not scanned yet — click “Scan Instantly” to see overlaps before importing.
                  </div>
                )}
              </Card>

              {/* Quick import */}
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

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">
              {report ? `${leads.length} will import${excludeInst && instChecked && instMatches.length ? ` · ${instMatches.length} Instantly dupes excluded` : ""}` : ""}
            </span>
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn-primary" disabled={leads.length === 0 || !report?.hasEmailColumn} onClick={() => setStep("campaign")}>
                Analyze &amp; weed <ArrowRight size={16} />
              </button>
            </div>
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
              <select
                className="input w-32 cursor-pointer py-1.5 text-sm"
                defaultValue=""
                onChange={(e) => { if (e.target.value) setFitShown(e.target.value as Relevance); e.target.value = ""; }}
                title="Re-classify all shown leads"
              >
                <option value="">Set fit shown…</option>
                <option value="relevant">→ Relevant</option>
                <option value="review">→ Review</option>
                <option value="unrelated">→ Unrelated</option>
              </select>
              <button className="btn-ghost btn-sm" onClick={() => addRemove(filteredIdx, true)}>Keep shown</button>
              <button className="btn-ghost btn-sm" onClick={() => addRemove(filteredIdx, false)}>Discard shown</button>
            </div>
            <div className="max-h-72 overflow-auto">
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                    <th className="w-10 px-2 py-2"></th>
                    <th className="px-2 py-2" style={{ width: "22%" }}>Lead</th>
                    <th className="px-2 py-2" style={{ width: "14%" }}>Category</th>
                    <th className="px-2 py-2" style={{ width: "34%" }}>Why</th>
                    <th className="w-28 px-2 py-2">Fit</th>
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
                        <td className="truncate px-2 py-2 align-top" title={v?.category}>{v?.category}</td>
                        <td className="whitespace-normal break-words px-2 py-2 align-top text-xs text-muted">{v?.reason || "—"}</td>
                        <td className="px-2 py-2 align-top">
                          <select
                            value={v?.relevance ?? "review"}
                            onChange={(e) => setFitOverride((m) => new Map(m).set(i, e.target.value as Relevance))}
                            className={cn(
                              "cursor-pointer rounded-md border-2 border-ink px-1 py-0.5 text-xs font-bold",
                              v?.relevance === "relevant" ? "bg-mint text-white" : v?.relevance === "unrelated" ? "bg-coral text-white" : "bg-sun",
                            )}
                          >
                            <option value="relevant">Relevant</option>
                            <option value="review">Review</option>
                            <option value="unrelated">Unrelated</option>
                          </select>
                        </td>
                        <td className="px-2 py-2 text-right align-top font-bold">{v?.score}</td>
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

function Stat({ label, value, tone, sub }: { label: string; value: number; tone: string; sub?: string }) {
  const bg: Record<string, string> = { mint: "bg-mint text-white", sun: "bg-sun", lavender: "bg-lavender", sky: "bg-sky" };
  return (
    <div className={cn("h-full rounded-xl border-2 border-ink p-3", bg[tone])}>
      <p className="text-xs font-bold uppercase opacity-70">{label}</p>
      <p className="text-2xl font-extrabold">{value}</p>
      {sub ? <p className="text-[11px] font-bold opacity-70">{sub}</p> : null}
    </div>
  );
}
