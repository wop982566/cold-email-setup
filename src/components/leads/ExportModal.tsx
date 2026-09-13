import { useMemo, useState } from "react";
import Papa from "papaparse";
import { Download, Search, Filter, X } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Card, Badge } from "../ui/primitives";
import { Lead } from "../../lib/types";
import { download, cn } from "../../lib/utils";

interface Column {
  id: string; // "std:email" | "cus:Company City"
  label: string;
  source: "std" | "cus";
}

const STD_COLUMNS: { key: keyof Lead; label: string }[] = [
  { key: "first_name", label: "first_name" },
  { key: "last_name", label: "last_name" },
  { key: "email", label: "email" },
  { key: "company", label: "company" },
  { key: "title", label: "title" },
  { key: "website", label: "website" },
  { key: "linkedin", label: "linkedin" },
  { key: "phone", label: "phone" },
  { key: "industry", label: "industry" },
  { key: "location", label: "location" },
  { key: "employees", label: "employees" },
  { key: "category", label: "category" },
  { key: "relevance", label: "relevance" },
  { key: "score", label: "score" },
  { key: "status", label: "status" },
  { key: "tags", label: "tags" },
];

function valueOf(lead: Lead, col: Column): string {
  if (col.source === "std") {
    const k = col.label as keyof Lead;
    if (k === "tags") return lead.tags.join("|");
    const v = lead[k];
    return v == null ? "" : String(v);
  }
  const v = (lead.custom ?? {})[col.label];
  return v == null ? "" : String(v);
}

const BLANK = "(blank)";

export function ExportModal({ leads, onClose }: { leads: Lead[]; onClose: () => void }) {
  // Build column list: standard + union of custom keys present.
  const columns = useMemo<Column[]>(() => {
    const custom = new Set<string>();
    for (const l of leads) for (const k of Object.keys(l.custom ?? {})) custom.add(k);
    return [
      ...STD_COLUMNS.map((c) => ({ id: `std:${c.label}`, label: c.label, source: "std" as const })),
      ...Array.from(custom)
        .sort()
        .map((k) => ({ id: `cus:${k}`, label: k, source: "cus" as const })),
    ];
  }, [leads]);

  // Default: standard columns included, custom off.
  const [included, setIncluded] = useState<Set<string>>(
    () => new Set(columns.filter((c) => c.source === "std").map((c) => c.id)),
  );
  const [colSearch, setColSearch] = useState("");
  const [filterColId, setFilterColId] = useState<string>("");
  // colId -> set of values to EXCLUDE
  const [excludes, setExcludes] = useState<Map<string, Set<string>>>(new Map());

  const visibleCols = columns.filter((c) => c.label.toLowerCase().includes(colSearch.trim().toLowerCase()));

  const filterCol = columns.find((c) => c.id === filterColId) ?? null;
  const distinctValues = useMemo(() => {
    if (!filterCol) return [];
    const m = new Map<string, number>();
    for (const l of leads) {
      const v = valueOf(l, filterCol).trim() || BLANK;
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return Array.from(m.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100);
  }, [filterCol, leads]);

  const filteredLeads = useMemo(() => {
    if (excludes.size === 0) return leads;
    return leads.filter((l) => {
      for (const [colId, set] of excludes) {
        if (set.size === 0) continue;
        const col = columns.find((c) => c.id === colId);
        if (!col) continue;
        const v = valueOf(l, col).trim() || BLANK;
        if (set.has(v)) return false;
      }
      return true;
    });
  }, [leads, excludes, columns]);

  const includedCols = columns.filter((c) => included.has(c.id));

  function toggleCol(id: string) {
    setIncluded((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleExclude(colId: string, value: string) {
    setExcludes((m) => {
      const next = new Map(m);
      const set = new Set(next.get(colId) ?? []);
      set.has(value) ? set.delete(value) : set.add(value);
      if (set.size === 0) next.delete(colId);
      else next.set(colId, set);
      return next;
    });
  }

  function runExport() {
    const rows = filteredLeads.map((l) => {
      const obj: Record<string, string> = {};
      for (const c of includedCols) obj[c.label] = valueOf(l, c);
      return obj;
    });
    download(`leads-export-${new Date().toISOString().slice(0, 10)}.csv`, Papa.unparse(rows));
    onClose();
  }

  const activeFilters = Array.from(excludes.entries()).map(([colId, set]) => ({
    label: columns.find((c) => c.id === colId)?.label ?? colId,
    colId,
    count: set.size,
  }));

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Export leads"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={runExport} disabled={includedCols.length === 0 || filteredLeads.length === 0}>
            <Download size={16} /> Export {filteredLeads.length} × {includedCols.length} cols
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Columns */}
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-bold">Columns to export ({includedCols.length})</p>
            <div className="flex gap-1">
              <button className="btn-ghost btn-sm" onClick={() => setIncluded(new Set(columns.map((c) => c.id)))}>All</button>
              <button className="btn-ghost btn-sm" onClick={() => setIncluded(new Set())}>None</button>
            </div>
          </div>
          <div className="relative mb-2">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input className="input py-1.5 pl-8 text-sm" placeholder="Find a column…" value={colSearch} onChange={(e) => setColSearch(e.target.value)} />
          </div>
          <div className="max-h-72 space-y-1 overflow-auto">
            {visibleCols.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-canvas">
                <input type="checkbox" checked={included.has(c.id)} onChange={() => toggleCol(c.id)} />
                <span className="truncate">{c.label}</span>
                {c.source === "cus" ? <span className="ml-auto text-[10px] text-muted">imported</span> : null}
              </label>
            ))}
          </div>
        </Card>

        {/* Row value filters */}
        <Card className="p-3">
          <p className="mb-2 flex items-center gap-2 text-sm font-bold">
            <Filter size={14} /> Filter out rows by value
          </p>
          <select className="input mb-2 cursor-pointer py-1.5 text-sm" value={filterColId} onChange={(e) => setFilterColId(e.target.value)}>
            <option value="">Pick a column to filter by value…</option>
            {includedCols.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>

          {activeFilters.length ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {activeFilters.map((f) => (
                <button key={f.colId} className="chip bg-coral text-white" onClick={() => setExcludes((m) => { const n = new Map(m); n.delete(f.colId); return n; })}>
                  {f.label}: −{f.count} <X size={11} />
                </button>
              ))}
            </div>
          ) : null}

          {filterCol ? (
            <div className="max-h-56 space-y-1 overflow-auto rounded-lg border-2 border-ink/20 p-2">
              <p className="px-1 text-[11px] text-muted">Check values to EXCLUDE from the export.</p>
              {distinctValues.map((d) => {
                const excluded = excludes.get(filterCol.id)?.has(d.value) ?? false;
                return (
                  <label key={d.value} className={cn("flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-canvas", excluded && "bg-coral/10")}>
                    <input type="checkbox" checked={excluded} onChange={() => toggleExclude(filterCol.id, d.value)} />
                    <span className="truncate">{d.value}</span>
                    <span className="ml-auto text-xs text-muted">{d.count}</span>
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted">Pick a column above to see its values and exclude the ones you don't want.</p>
          )}

          <div className="mt-3 rounded-lg border-2 border-ink bg-canvas p-2 text-sm">
            <Badge tone="mint">{filteredLeads.length}</Badge> of {leads.length} rows will export
            {excludes.size > 0 ? " after filters" : ""}.
          </div>
        </Card>
      </div>
    </Modal>
  );
}
