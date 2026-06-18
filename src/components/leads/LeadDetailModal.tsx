import { Modal } from "../ui/Modal";
import { Badge } from "../ui/primitives";
import { Lead } from "../../lib/types";

const STANDARD: { key: keyof Lead; label: string }[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "company", label: "Company" },
  { key: "title", label: "Title" },
  { key: "industry", label: "Industry" },
  { key: "employees", label: "Employees" },
  { key: "location", label: "Location" },
  { key: "website", label: "Website" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "phone", label: "Phone" },
  { key: "category", label: "Category" },
];

function Row({ label, value }: { label: string; value: string }) {
  const isLink = /^https?:\/\//i.test(value);
  return (
    <div className="min-w-0 border-b border-ink/10 py-1.5">
      <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</p>
      {isLink ? (
        <a href={value} target="_blank" rel="noreferrer" className="block break-words text-sm font-semibold text-violet underline">
          {value}
        </a>
      ) : (
        <p className="break-words text-sm font-semibold">{value || "—"}</p>
      )}
    </div>
  );
}

// Reusable field renderer — used by the modal AND the inline expanded row.
export function LeadFields({ lead }: { lead: Lead }) {
  const customEntries = Object.entries(lead.custom ?? {}).filter(([, v]) => v != null && String(v).trim() !== "");
  const enr = (lead.enrichment ?? {}) as { summary?: string; reason?: string };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {lead.relevance ? (
          <Badge tone={lead.relevance === "relevant" ? "mint" : lead.relevance === "unrelated" ? "coral" : "sun"}>
            {lead.relevance}
          </Badge>
        ) : null}
        <Badge tone="lavender">Score {lead.score}</Badge>
        <Badge tone="white">{lead.status}</Badge>
        {lead.discarded ? <Badge tone="coral">discarded</Badge> : null}
        {lead.enriched ? <Badge tone="sky">AI enriched</Badge> : null}
      </div>

      {enr.reason ? (
        <div className="rounded-xl border-2 border-ink bg-sky/30 p-3 text-sm">
          <span className="font-bold">Why this fit: </span>
          {enr.reason}
        </div>
      ) : null}
      {enr.summary ? (
        <div className="rounded-xl border-2 border-ink bg-pink/20 p-3 text-sm">
          <span className="font-bold">AI summary: </span>
          {enr.summary}
        </div>
      ) : null}

      {lead.tags?.length ? (
        <div className="flex flex-wrap gap-1">
          {lead.tags.map((t) => (
            <span key={t} className="chip">{t}</span>
          ))}
        </div>
      ) : null}

      <div>
        <p className="mb-1 text-sm font-extrabold">Core fields</p>
        <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
          {STANDARD.map((f) => (
            <Row key={String(f.key)} label={f.label} value={String(lead[f.key] ?? "")} />
          ))}
        </div>
      </div>

      {customEntries.length ? (
        <div>
          <p className="mb-1 text-sm font-extrabold">All imported columns ({customEntries.length})</p>
          <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            {customEntries.map(([k, v]) => (
              <Row key={k} label={k} value={String(v)} />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">No extra columns were imported for this lead.</p>
      )}
    </div>
  );
}

export function LeadDetailModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} size="lg" title={lead.email || "Lead details"}>
      <LeadFields lead={lead} />
    </Modal>
  );
}
