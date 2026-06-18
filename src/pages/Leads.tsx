import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  Plus,
  Search,
  Upload,
  Download,
  Trash2,
  Pencil,
  Users,
  FolderPlus,
  Folder,
  Layers,
  Sparkles,
  Tag,
  Copy,
  Filter,
  RotateCcw,
  Archive,
} from "lucide-react";
import { Card, Badge, EmptyState } from "../components/ui/primitives";
import { Modal, ConfirmDialog } from "../components/ui/Modal";
import { Field, TextField, NumberField, SelectField, TextArea } from "../components/ui/Field";
import { useToast } from "../components/ui/toast";
import {
  useCollection,
  useInsert,
  useInsertMany,
  useUpdate,
  useUpdateMany,
  useUpsertMany,
  useRemove,
  useRemoveMany,
} from "../lib/hooks";
import {
  Campaign,
  Lead,
  LeadList,
  LeadStatus,
  TABLES,
} from "../lib/types";
import { cn, download, uuid, uniqueBy } from "../lib/utils";
import { enrichLeads } from "../lib/functions";
import { ImportWizard, type ImportResult } from "../components/leads/ImportWizard";
import { leadToExportRow } from "../lib/leadImport";
import { dbMode } from "../lib/db";

const STATUS_OPTIONS: { value: LeadStatus; label: string; tone: string }[] = [
  { value: "new", label: "New", tone: "bg-white" },
  { value: "enriched", label: "Enriched", tone: "bg-lavender" },
  { value: "queued", label: "Queued", tone: "bg-sky" },
  { value: "used", label: "Used", tone: "bg-ink text-white" },
  { value: "replied", label: "Replied", tone: "bg-mint text-white" },
  { value: "bounced", label: "Bounced", tone: "bg-coral text-white" },
  { value: "unsubscribed", label: "Unsub", tone: "bg-sun" },
  { value: "invalid", label: "Invalid", tone: "bg-danger text-white" },
];

function statusTone(s: LeadStatus) {
  return STATUS_OPTIONS.find((o) => o.value === s)?.tone ?? "bg-white";
}

function relevanceTone(r: Lead["relevance"]) {
  return r === "relevant" ? "mint" : r === "unrelated" ? "coral" : r === "review" ? "sun" : "white";
}

// Turn a mutation failure into a useful message — notably catching the case
// where the Supabase project hasn't had migration 0004 applied yet.
function explainError(e: unknown): string {
  const anyE = e as { message?: string };
  const msg = anyE?.message ?? (typeof e === "string" ? e : "Something went wrong");
  if (/column/i.test(msg) && /(discarded|category|relevance)/i.test(msg)) {
    return "Your database is missing the new lead columns. Run migration 0004 in Supabase (SQL editor), then retry.";
  }
  return msg;
}

function blankLead(listId: string | null): Lead {
  return {
    id: uuid(),
    list_id: listId,
    email: "",
    first_name: "",
    last_name: "",
    company: "",
    title: "",
    website: "",
    linkedin: "",
    phone: "",
    location: "",
    industry: "",
    employees: "",
    status: "new",
    used_in_campaign_id: null,
    used_at: null,
    enriched: false,
    category: "",
    relevance: "",
    discarded: false,
    discarded_at: null,
    score: 50,
    tags: [],
    enrichment: {},
    custom: {},
  };
}

export default function Leads() {
  const toast = useToast();
  const { data: lists = [] } = useCollection<LeadList>(TABLES.leadLists);
  const { data: leads = [] } = useCollection<Lead>(TABLES.leads);
  const { data: campaigns = [] } = useCollection<Campaign>(TABLES.campaigns);
  const insertLead = useInsert<Lead>(TABLES.leads);
  const insertManyLeads = useInsertMany<Lead>(TABLES.leads);
  const updateLead = useUpdate<Lead>(TABLES.leads);
  const updateManyLeads = useUpdateMany<Lead>(TABLES.leads);
  const upsertManyLeads = useUpsertMany<Lead>(TABLES.leads);
  const removeLead = useRemove(TABLES.leads);
  const removeManyLeads = useRemoveMany(TABLES.leads);
  const insertList = useInsert<LeadList>(TABLES.leadLists);
  const removeList = useRemove(TABLES.leadLists);

  const [activeListId, setActiveListId] = useState<string | null>(null); // null = all
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [industryFilter, setIndustryFilter] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [hideUsed, setHideUsed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Lead | null>(null);
  const [deleting, setDeleting] = useState<Lead | null>(null);
  const [showList, setShowList] = useState(false);
  const [showEnrich, setShowEnrich] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  // Reset paging + selection when the view changes.
  useEffect(() => {
    setPage(0);
  }, [search, statusFilter, industryFilter, minScore, hideUsed, activeListId, showDiscarded]);

  const descendantIds = useMemo(() => {
    if (showDiscarded || !activeListId) return null;
    const ids = new Set<string>([activeListId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const l of lists) {
        if (l.parent_id && ids.has(l.parent_id) && !ids.has(l.id)) {
          ids.add(l.id);
          changed = true;
        }
      }
    }
    return ids;
  }, [activeListId, lists, showDiscarded]);

  const industries = useMemo(
    () => Array.from(new Set(leads.map((l) => l.industry).filter(Boolean))).sort(),
    [leads],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((l) => {
      if (showDiscarded) {
        if (!l.discarded) return false;
      } else {
        if (l.discarded) return false;
        if (descendantIds && !(l.list_id && descendantIds.has(l.list_id))) return false;
      }
      if (statusFilter && l.status !== statusFilter) return false;
      if (industryFilter && l.industry !== industryFilter) return false;
      if (minScore > 0 && l.score < minScore) return false;
      if (hideUsed && l.status === "used") return false;
      if (q) {
        const hay = `${l.email} ${l.first_name} ${l.last_name} ${l.company} ${l.title} ${l.category} ${l.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [leads, descendantIds, statusFilter, industryFilter, minScore, hideUsed, search, showDiscarded]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageLeads = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const allChecked = filtered.length > 0 && filtered.every((l) => selected.has(l.id));
  const selectedLeads = filtered.filter((l) => selected.has(l.id));

  const activeCount = useMemo(() => leads.filter((l) => !l.discarded).length, [leads]);
  const discardedCount = useMemo(() => leads.filter((l) => l.discarded).length, [leads]);

  function toggleAll() {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(filtered.map((l) => l.id)));
  }
  function toggleOne(id: string) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  async function saveLead(l: Lead) {
    const exists = leads.some((x) => x.id === l.id);
    if (exists) {
      const { id, created_at, ...patch } = l;
      await updateLead.mutateAsync({ id, patch });
    } else {
      await insertLead.mutateAsync(l);
    }
    toast.push("Lead saved");
    setEditing(null);
  }

  async function bulkSetStatus(status: LeadStatus, campaignId?: string) {
    try {
      const ids = selectedLeads.map((l) => l.id);
      const patch: Partial<Lead> = { status };
      if (status === "used") {
        patch.used_at = new Date().toISOString();
        if (campaignId) patch.used_in_campaign_id = campaignId;
      }
      await updateManyLeads.mutateAsync({ ids, patch });
      toast.push(`Updated ${ids.length} leads`);
      setSelected(new Set());
    } catch (e) {
      toast.push(explainError(e), "error");
    }
  }

  async function bulkMove(listId: string) {
    try {
      const ids = selectedLeads.map((l) => l.id);
      await updateManyLeads.mutateAsync({ ids, patch: { list_id: listId } as Partial<Lead> });
      toast.push(`Moved ${ids.length} leads`);
      setSelected(new Set());
    } catch (e) {
      toast.push(explainError(e), "error");
    }
  }

  async function bulkTag(tag: string) {
    try {
      const rows = selectedLeads.map((l) => ({
        id: l.id,
        tags: l.tags.includes(tag) ? l.tags : [...l.tags, tag],
      }));
      await upsertManyLeads.mutateAsync(rows);
      toast.push(`Tagged ${rows.length} leads`);
    } catch (e) {
      toast.push(explainError(e), "error");
    }
  }

  async function discardSelected() {
    try {
      const ids = selectedLeads.map((l) => l.id);
      await updateManyLeads.mutateAsync({
        ids,
        patch: { discarded: true, discarded_at: new Date().toISOString() } as Partial<Lead>,
      });
      toast.push(`Moved ${ids.length} leads to Discarded`);
      setSelected(new Set());
    } catch (e) {
      toast.push(explainError(e), "error");
    }
  }

  async function restoreSelected() {
    try {
      const ids = selectedLeads.map((l) => l.id);
      await updateManyLeads.mutateAsync({ ids, patch: { discarded: false, discarded_at: null } as Partial<Lead> });
      toast.push(`Restored ${ids.length} leads`);
      setSelected(new Set());
    } catch (e) {
      toast.push(explainError(e), "error");
    }
  }

  async function deleteForeverSelected() {
    try {
      await removeManyLeads.mutateAsync(selectedLeads.map((l) => l.id));
      toast.push(`Permanently deleted ${selectedLeads.length} leads`);
      setSelected(new Set());
    } catch (e) {
      toast.push(explainError(e), "error");
    }
  }

  async function discardOne(l: Lead) {
    try {
      await updateLead.mutateAsync({
        id: l.id,
        patch: { discarded: true, discarded_at: new Date().toISOString() } as Partial<Lead>,
      });
      toast.push(`Discarded ${l.email}`);
    } catch (e) {
      toast.push(explainError(e), "error");
    }
  }

  async function restoreOne(l: Lead) {
    try {
      await updateLead.mutateAsync({ id: l.id, patch: { discarded: false, discarded_at: null } as Partial<Lead> });
      toast.push(`Restored ${l.email}`);
    } catch (e) {
      toast.push(explainError(e), "error");
    }
  }

  async function deleteOne(l: Lead) {
    try {
      await removeLead.mutateAsync(l.id);
      toast.push(`Permanently deleted ${l.email}`);
    } catch (e) {
      toast.push(explainError(e), "error");
    }
  }

  async function makeSublist() {
    if (selectedLeads.length === 0) return;
    const parent = activeListId ?? lists[0]?.id ?? null;
    const name = prompt("Name this sub-list:", "New sub-list");
    if (!name) return;
    const list = await insertList.mutateAsync({
      id: uuid(),
      name,
      parent_id: parent,
      description: `Created from ${selectedLeads.length} filtered leads`,
      color: "#90A8ED",
      source: "Filtered",
    });
    await bulkMove(list.id);
  }

  async function removeDuplicates() {
    const unique = uniqueBy(filtered, (l) => l.email.trim().toLowerCase());
    const dupeIds = filtered.filter((l) => !unique.includes(l)).map((l) => l.id);
    if (dupeIds.length === 0) {
      toast.push("No duplicate emails in this view", "info");
      return;
    }
    await removeManyLeads.mutateAsync(dupeIds);
    toast.push(`Removed ${dupeIds.length} duplicate leads`);
    setSelected(new Set());
  }

  function exportCsv() {
    const rows = filtered.map(leadToExportRow);
    if (rows.length === 0) {
      toast.push("Nothing to export in this view", "info");
      return;
    }
    download(`leads-${new Date().toISOString().slice(0, 10)}.csv`, Papa.unparse(rows));
  }

  async function handleImport({ listName, kept, discarded }: ImportResult) {
    const list = await insertList.mutateAsync({
      id: uuid(),
      name: listName,
      parent_id: null,
      description: `Imported — ${kept.length} kept, ${discarded.length} discarded`,
      color: "#FF90E8",
      source: "CSV import",
    });
    const all = [...kept, ...discarded].map((l) => ({ ...l, id: uuid(), list_id: list.id }));
    const CHUNK = 1000;
    try {
      for (let i = 0; i < all.length; i += CHUNK) {
        await insertManyLeads.mutateAsync(all.slice(i, i + CHUNK));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const quota = /quota|exceeded/i.test(msg) || (e as { name?: string })?.name === "QuotaExceededError";
      throw new Error(
        quota
          ? `Browser storage is full at this size. ${dbMode === "local" ? "Connect Supabase" : "Import a smaller batch"} for large lists.`
          : msg,
      );
    }
    toast.push(`Imported ${kept.length} to "${listName}" · ${discarded.length} discarded`);
    setShowImport(false);
    setShowDiscarded(false);
    setActiveListId(list.id);
  }

  const rootLists = lists.filter((l) => !l.parent_id);
  const childLists = (id: string) => lists.filter((l) => l.parent_id === id);
  const countFor = (listId: string | null) => {
    if (!listId) return activeCount;
    const ids = new Set<string>([listId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const l of lists) {
        if (l.parent_id && ids.has(l.parent_id) && !ids.has(l.id)) {
          ids.add(l.id);
          changed = true;
        }
      }
    }
    return leads.filter((l) => !l.discarded && l.list_id && ids.has(l.list_id)).length;
  };

  function selectList(id: string | null) {
    setShowDiscarded(false);
    setActiveListId(id);
    setSelected(new Set());
  }

  const existingEmails = useMemo(() => new Set(leads.map((l) => l.email.trim().toLowerCase())), [leads]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
      {/* Lists sidebar */}
      <Card className="h-fit p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-extrabold uppercase tracking-wide">
            <Layers size={16} /> Lists
          </h2>
          <button className="btn-ghost btn-sm" onClick={() => setShowList(true)}>
            <FolderPlus size={14} />
          </button>
        </div>
        <button
          className={cn(
            "mb-1 flex w-full items-center justify-between rounded-lg border-2 px-2 py-1.5 text-sm font-bold",
            !showDiscarded && activeListId === null ? "border-ink bg-sun" : "border-transparent hover:bg-canvas",
          )}
          onClick={() => selectList(null)}
        >
          <span className="flex items-center gap-2">
            <Users size={14} /> All leads
          </span>
          <span className="text-xs">{activeCount}</span>
        </button>
        {rootLists.map((l) => (
          <div key={l.id}>
            <ListButton
              list={l}
              active={!showDiscarded && activeListId === l.id}
              count={countFor(l.id)}
              onClick={() => selectList(l.id)}
              onDelete={() => removeList.mutate(l.id)}
            />
            <div className="ml-3 border-l-2 border-ink/15 pl-2">
              {childLists(l.id).map((c) => (
                <ListButton
                  key={c.id}
                  list={c}
                  active={!showDiscarded && activeListId === c.id}
                  count={countFor(c.id)}
                  onClick={() => selectList(c.id)}
                  onDelete={() => removeList.mutate(c.id)}
                  small
                />
              ))}
            </div>
          </div>
        ))}

        {/* Discarded folder */}
        <button
          className={cn(
            "mt-3 flex w-full items-center justify-between rounded-lg border-2 px-2 py-1.5 text-sm font-bold",
            showDiscarded ? "border-ink bg-coral text-white" : "border-transparent text-muted hover:bg-canvas",
          )}
          onClick={() => {
            setShowDiscarded(true);
            setSelected(new Set());
          }}
          title="Discarded leads are hidden everywhere else until you restore them"
        >
          <span className="flex items-center gap-2">
            <Trash2 size={14} /> Discarded
          </span>
          <span className="text-xs">{discardedCount}</span>
        </button>
      </Card>

      {/* Main */}
      <div className="space-y-3">
        <Card className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[180px] flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input className="input pl-9" placeholder="Search leads…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="input max-w-[140px] cursor-pointer" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All status</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select className="input max-w-[150px] cursor-pointer" value={industryFilter} onChange={(e) => setIndustryFilter(e.target.value)}>
            <option value="">All industries</option>
            {industries.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            <span className="text-xs font-bold text-muted">Min score</span>
            <input type="number" className="input w-16" value={minScore} min={0} max={100} onChange={(e) => setMinScore(Number(e.target.value))} />
          </div>
          <button className={hideUsed ? "btn-dark btn-sm" : "btn-ghost btn-sm"} onClick={() => setHideUsed((v) => !v)}>
            <Filter size={14} /> Hide used
          </button>
          <button className="btn-ghost btn-sm" onClick={removeDuplicates}>
            <Copy size={14} /> Dedupe
          </button>
          <button className="btn-ghost btn-sm" onClick={exportCsv}>
            <Download size={14} /> Export
          </button>
          <button className="btn-primary btn-sm" onClick={() => setShowImport(true)}>
            <Sparkles size={14} /> Import &amp; enrich
          </button>
          <button className="btn-ghost btn-sm" onClick={() => setEditing(blankLead(activeListId))}>
            <Plus size={14} /> Add lead
          </button>
        </Card>

        {/* Bulk action bar */}
        {selectedLeads.length > 0 ? (
          <Card className="flex flex-wrap items-center gap-2 bg-pink/30 p-3">
            <span className="text-sm font-bold">{selectedLeads.length} selected</span>
            {showDiscarded ? (
              <>
                <button className="btn-dark btn-sm" onClick={restoreSelected}>
                  <RotateCcw size={14} /> Restore
                </button>
                <button
                  className="btn-sm btn bg-danger text-white shadow-hard"
                  onClick={() => setConfirmBulkDelete(true)}
                >
                  <Trash2 size={14} /> Delete forever
                </button>
              </>
            ) : (
              <>
                <select
                  className="input max-w-[150px] cursor-pointer"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) bulkSetStatus(e.target.value as LeadStatus);
                    e.target.value = "";
                  }}
                >
                  <option value="">Set status…</option>
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  className="input max-w-[150px] cursor-pointer"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) bulkMove(e.target.value);
                    e.target.value = "";
                  }}
                >
                  <option value="">Move to list…</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    const t = prompt("Tag to add:");
                    if (t) bulkTag(t);
                  }}
                >
                  <Tag size={14} /> Tag
                </button>
                <button className="btn-ghost btn-sm" onClick={makeSublist}>
                  <FolderPlus size={14} /> Make sub-list
                </button>
                <button className="btn-sun btn-sm" onClick={() => setShowEnrich(true)}>
                  <Sparkles size={14} /> Enrich
                </button>
                <button className="btn-ghost btn-sm" onClick={discardSelected}>
                  <Archive size={14} /> Discard
                </button>
                <button
                  className="btn-sm btn bg-danger text-white shadow-hard"
                  onClick={() => setConfirmBulkDelete(true)}
                >
                  <Trash2 size={14} /> Delete forever
                </button>
              </>
            )}
          </Card>
        ) : null}

        <Card className="overflow-hidden p-0">
          {filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<Users size={32} />}
                title={showDiscarded ? "No discarded leads" : "No leads here"}
                description={
                  showDiscarded
                    ? "Leads you discard during import or review land here, hidden from everywhere else until you restore them."
                    : "Import a CSV of scraped leads (AI will analyze and help you weed out the wrong ones) or add one manually."
                }
                action={
                  showDiscarded ? undefined : (
                    <button className="btn-primary btn-sm" onClick={() => setShowImport(true)}>
                      <Sparkles size={14} /> Import &amp; enrich
                    </button>
                  )
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                    <th className="w-9 px-2 py-2">
                      <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                    </th>
                    <th className="px-2 py-2" style={{ width: "22%" }}>Lead</th>
                    <th className="px-2 py-2" style={{ width: "16%" }}>Company</th>
                    <th className="px-2 py-2" style={{ width: "16%" }}>Title</th>
                    <th className="px-2 py-2" style={{ width: "15%" }}>Category</th>
                    <th className="w-20 px-2 py-2">Fit</th>
                    <th className="w-14 px-2 py-2">Score</th>
                    <th className="w-24 px-2 py-2">Status</th>
                    <th className="w-20 px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageLeads.map((l) => (
                    <tr key={l.id} className={cn("border-b border-ink/10 hover:bg-canvas/60", selected.has(l.id) && "bg-pink/10")}>
                      <td className="px-2 py-2">
                        <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleOne(l.id)} />
                      </td>
                      <td className="px-2 py-2">
                        <p className="truncate font-bold" title={[l.first_name, l.last_name].filter(Boolean).join(" ")}>
                          {[l.first_name, l.last_name].filter(Boolean).join(" ") || "—"}
                        </p>
                        <p className="truncate text-xs text-muted" title={l.email}>{l.email}</p>
                      </td>
                      <td className="truncate px-2 py-2" title={l.company}>{l.company || "—"}</td>
                      <td className="truncate px-2 py-2" title={l.title}>{l.title || "—"}</td>
                      <td className="truncate px-2 py-2" title={l.category}>{l.category || l.industry || "—"}</td>
                      <td className="px-2 py-2">
                        {l.relevance ? (
                          <Badge tone={relevanceTone(l.relevance) as "mint"}>{l.relevance}</Badge>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 font-bold">{l.score}</td>
                      <td className="px-2 py-2">
                        <span className={cn("badge", statusTone(l.status))}>{l.status}</span>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          {showDiscarded ? (
                            <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-mint hover:text-white" onClick={() => restoreOne(l)} title="Restore">
                              <RotateCcw size={13} />
                            </button>
                          ) : (
                            <>
                              <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-canvas" onClick={() => setEditing(l)} title="Edit">
                                <Pencil size={13} />
                              </button>
                              <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-sun" onClick={() => discardOne(l)} title="Discard (move to Discarded)">
                                <Archive size={13} />
                              </button>
                            </>
                          )}
                          <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-danger hover:text-white" onClick={() => setDeleting(l)} title="Delete permanently">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            Showing {pageLeads.length} of {filtered.length}
            {showDiscarded ? " discarded" : ""} leads
            {selectedLeads.length > 0 ? ` · ${selectedLeads.length} selected` : ""}.
          </span>
          {pages > 1 ? (
            <div className="flex items-center gap-2">
              <button className="btn-ghost btn-sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
                Prev
              </button>
              <span>{safePage + 1}/{pages}</span>
              <button className="btn-ghost btn-sm" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>
                Next
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {editing ? (
        <LeadModal lead={editing} campaigns={campaigns} lists={lists} onClose={() => setEditing(null)} onSave={saveLead} />
      ) : null}

      {showList ? (
        <NewListModal lists={lists} onClose={() => setShowList(false)} onSave={async (l) => {
          await insertList.mutateAsync(l);
          toast.push("List created");
          setShowList(false);
        }} />
      ) : null}

      {showImport ? (
        <ImportWizard
          campaigns={campaigns}
          existingEmails={existingEmails}
          onClose={() => setShowImport(false)}
          onComplete={handleImport}
        />
      ) : null}

      {showEnrich ? (
        <EnrichModal
          leads={selectedLeads}
          onClose={() => setShowEnrich(false)}
          onApply={async (updates) => {
            for (const u of updates) {
              const { id, ...patch } = u;
              await updateLead.mutateAsync({ id, patch: { ...patch, enriched: true } as Partial<Lead> });
            }
            toast.push(`Enriched ${updates.length} leads`);
            setShowEnrich(false);
            setSelected(new Set());
          }}
        />
      ) : null}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteOne(deleting)}
        title="Delete lead permanently"
        message={`Permanently delete ${deleting?.email}? It's removed from the database and can be re-imported later (it won't be flagged as a duplicate).`}
        confirmLabel="Delete forever"
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        onConfirm={deleteForeverSelected}
        title="Delete leads permanently"
        message={`Permanently delete ${selectedLeads.length} lead(s)? They're removed from the database (not recoverable from Discarded) and can be re-imported later.`}
        confirmLabel="Delete forever"
      />
    </div>
  );
}

function ListButton({
  list,
  active,
  count,
  onClick,
  onDelete,
  small,
}: {
  list: LeadList;
  active: boolean;
  count: number;
  onClick: () => void;
  onDelete: () => void;
  small?: boolean;
}) {
  return (
    <div className="group flex items-center">
      <button
        className={cn(
          "mb-1 flex flex-1 items-center justify-between rounded-lg border-2 px-2 py-1.5 font-bold",
          small ? "text-xs" : "text-sm",
          active ? "border-ink bg-sun" : "border-transparent hover:bg-canvas",
        )}
        onClick={onClick}
      >
        <span className="flex items-center gap-2 truncate">
          <Folder size={small ? 12 : 14} style={{ color: list.color }} />
          <span className="truncate">{list.name}</span>
        </span>
        <span className="text-xs">{count}</span>
      </button>
      <button className="ml-1 hidden text-muted hover:text-danger group-hover:block" onClick={onDelete} title="Delete list">
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function NewListModal({
  lists,
  onClose,
  onSave,
}: {
  lists: LeadList[];
  onClose: () => void;
  onSave: (l: LeadList) => void;
}) {
  const [form, setForm] = useState<LeadList>({
    id: uuid(),
    name: "",
    parent_id: null,
    description: "",
    color: "#FF90E8",
    source: "",
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="New list"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(form)} disabled={!form.name}>
            Create
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <TextField value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        </Field>
        <Field label="Parent list (optional — makes a sub-list)">
          <select className="input cursor-pointer" value={form.parent_id ?? ""} onChange={(e) => setForm({ ...form, parent_id: e.target.value || null })}>
            <option value="">None (top-level)</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Source">
            <TextField value={form.source} onChange={(v) => setForm({ ...form, source: v })} placeholder="Apollo, scrape…" />
          </Field>
          <Field label="Color">
            <input type="color" className="input h-10 cursor-pointer p-1" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
          </Field>
        </div>
        <Field label="Description">
          <TextArea value={form.description} onChange={(v) => setForm({ ...form, description: v })} />
        </Field>
      </div>
    </Modal>
  );
}

function LeadModal({
  lead,
  campaigns,
  lists,
  onClose,
  onSave,
}: {
  lead: Lead;
  campaigns: Campaign[];
  lists: LeadList[];
  onClose: () => void;
  onSave: (l: Lead) => void;
}) {
  const [form, setForm] = useState<Lead>(lead);
  const set = <K extends keyof Lead>(k: K, v: Lead[K]) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={lead.email ? `Edit ${lead.email}` : "Add lead"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(form)} disabled={!form.email}>
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Email" className="sm:col-span-2">
          <TextField value={form.email} onChange={(v) => set("email", v)} />
        </Field>
        <Field label="First name">
          <TextField value={form.first_name} onChange={(v) => set("first_name", v)} />
        </Field>
        <Field label="Last name">
          <TextField value={form.last_name} onChange={(v) => set("last_name", v)} />
        </Field>
        <Field label="Company">
          <TextField value={form.company} onChange={(v) => set("company", v)} />
        </Field>
        <Field label="Title">
          <TextField value={form.title} onChange={(v) => set("title", v)} />
        </Field>
        <Field label="Website">
          <TextField value={form.website} onChange={(v) => set("website", v)} />
        </Field>
        <Field label="LinkedIn">
          <TextField value={form.linkedin} onChange={(v) => set("linkedin", v)} />
        </Field>
        <Field label="Industry">
          <TextField value={form.industry} onChange={(v) => set("industry", v)} />
        </Field>
        <Field label="Category">
          <TextField value={form.category} onChange={(v) => set("category", v)} />
        </Field>
        <Field label="Employees">
          <TextField value={form.employees} onChange={(v) => set("employees", v)} />
        </Field>
        <Field label="Location">
          <TextField value={form.location} onChange={(v) => set("location", v)} />
        </Field>
        <Field label="Phone">
          <TextField value={form.phone} onChange={(v) => set("phone", v)} />
        </Field>
        <Field label="Score (0-100)">
          <NumberField value={form.score} onChange={(v) => set("score", v ?? 0)} min={0} />
        </Field>
        <Field label="Status">
          <SelectField value={form.status} onChange={(v) => set("status", v as LeadStatus)} options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
        </Field>
        <Field label="List">
          <select className="input cursor-pointer" value={form.list_id ?? ""} onChange={(e) => set("list_id", e.target.value || null)}>
            <option value="">— None —</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Used in campaign">
          <select className="input cursor-pointer" value={form.used_in_campaign_id ?? ""} onChange={(e) => set("used_in_campaign_id", e.target.value || null)}>
            <option value="">— None —</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tags (comma separated)" className="sm:col-span-2">
          <TextField value={form.tags.join(", ")} onChange={(v) => set("tags", v.split(",").map((t) => t.trim()).filter(Boolean))} />
        </Field>
      </div>
    </Modal>
  );
}

function EnrichModal({
  leads,
  onClose,
  onApply,
}: {
  leads: Lead[];
  onClose: () => void;
  onApply: (updates: ({ id: string } & Partial<Lead>)[]) => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<"manual" | "ai">("manual");
  const [field, setField] = useState<keyof Lead>("industry");
  const [value, setValue] = useState("");
  const [instructions, setInstructions] = useState(
    "Infer the industry and a 1-line summary for each lead from their company and title. Give a 0-100 fit score for a cold-email agency offer.",
  );
  const [running, setRunning] = useState(false);

  const manualFields: { value: keyof Lead; label: string }[] = [
    { value: "industry", label: "Industry" },
    { value: "category", label: "Category" },
    { value: "title", label: "Title" },
    { value: "location", label: "Location" },
    { value: "employees", label: "Employees" },
    { value: "score", label: "Score" },
    { value: "status", label: "Status" },
  ];

  async function runAi() {
    setRunning(true);
    const res = await enrichLeads({
      leads: leads.map((l) => ({
        id: l.id,
        email: l.email,
        first_name: l.first_name,
        last_name: l.last_name,
        company: l.company,
        title: l.title,
        website: l.website,
        industry: l.industry,
        location: l.location,
      })),
      instructions,
      fields: ["industry", "score", "summary"],
    });
    setRunning(false);
    if (!res.ok || !res.results) {
      toast.push(res.error ?? "AI enrichment unavailable. Add OPENAI_API_KEY in Netlify, or enrich manually.", "error");
      return;
    }
    const updates = res.results.map((r) => {
      const patch: { id: string } & Partial<Lead> = { id: r.id };
      if (typeof r.industry === "string") patch.industry = r.industry;
      if (typeof r.score === "number") patch.score = r.score;
      if (r.summary != null) patch.enrichment = { summary: String(r.summary) };
      return patch;
    });
    onApply(updates);
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Enrich ${leads.length} leads`}
      footer={
        tab === "manual" ? (
          <>
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() =>
                onApply(
                  leads.map((l) => ({
                    id: l.id,
                    [field]: field === "score" ? Number(value) : value,
                  })),
                )
              }
            >
              Apply to all
            </button>
          </>
        ) : (
          <>
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-sun" onClick={runAi} disabled={running}>
              <Sparkles size={16} /> {running ? "Running…" : "Run AI enrichment"}
            </button>
          </>
        )
      }
    >
      <div className="mb-4 flex gap-2">
        <button className={tab === "manual" ? "btn-dark btn-sm" : "btn-ghost btn-sm"} onClick={() => setTab("manual")}>
          Manual (advanced filter fill)
        </button>
        <button className={tab === "ai" ? "btn-dark btn-sm" : "btn-ghost btn-sm"} onClick={() => setTab("ai")}>
          <Sparkles size={14} /> AI (ChatGPT)
        </button>
      </div>

      {tab === "manual" ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Set a field to the same value across all {leads.length} selected leads — handy for tagging an industry or
            bumping scores without AI.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Field">
              <SelectField value={String(field)} onChange={(v) => setField(v as keyof Lead)} options={manualFields.map((f) => ({ value: String(f.value), label: f.label }))} />
            </Field>
            <Field label="Value">
              <TextField value={value} onChange={setValue} />
            </Field>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Runs through the <code>/enrich</code> Netlify function using your OpenAI key. Returns industry, a fit score
            and a summary. If the key isn't set yet, you'll get a clear error and can use manual mode.
          </p>
          <Field label="Instructions to the model">
            <TextArea rows={5} value={instructions} onChange={setInstructions} />
          </Field>
          <div className="rounded-xl border-2 border-ink bg-lavender/40 p-3 text-xs">
            Tip: keep AI optional. The advanced filters + manual fill above let you enrich entirely on your own.
          </div>
        </div>
      )}
    </Modal>
  );
}
