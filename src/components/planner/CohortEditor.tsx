// ---------------------------------------------------------------------------
// Manual cohort editor for the Rotation tab.
//
// A filterable account picker used both to fix an auto-picked partner cohort and
// to edit a managed campaign's cohorts. Every account carries a status computed
// by the parent (RotationPanel): `available` (idle, same-niche, unused —
// selectable), `used` (attached to another campaign or locked in another
// rotation cohort — blocked with the exact message the user asked for), or
// `wrong` (different niche — blocked, strict same-niche). Accounts already in the
// cohort stay removable even if they'd now be blocked, so a bad auto-pick can be
// taken out.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { Search, Check, AlertTriangle, Ban } from "lucide-react";
import { Badge, Spinner } from "../ui/primitives";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/toast";

export type CandidateStatus = "available" | "used" | "wrong";
export interface CandidateRow {
  email: string;
  dailyLimit: number;
  status: CandidateStatus;
  /** Why it's blocked (used-by / wrong-niche), for the tooltip + inline note. */
  label?: string;
}

const USED_MESSAGE = "This account has been used. Please select another account.";

export function CohortEditor({
  open,
  onClose,
  title,
  subtitle,
  warning,
  rows,
  initialSelected,
  saveLabel,
  saving,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Shown as a banner (e.g. the active-cohort "this pushes live" warning). */
  warning?: string;
  rows: CandidateRow[];
  initialSelected: string[];
  saveLabel: string;
  saving: boolean;
  onSave: (emails: string[]) => void;
}) {
  const toast = useToast();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) {
      setSel(new Set(initialSelected.map((e) => e.trim().toLowerCase())));
      setQuery("");
    }
  }, [open, initialSelected]);

  const statusByEmail = useMemo(() => {
    const m = new Map<string, CandidateRow>();
    for (const r of rows) m.set(r.email.trim().toLowerCase(), r);
    return m;
  }, [rows]);

  function toggle(email: string) {
    const e = email.trim().toLowerCase();
    const row = statusByEmail.get(e);
    if (sel.has(e)) {
      // Always allow removal — this is how a bad auto-pick gets taken out.
      setSel((s) => {
        const n = new Set(s);
        n.delete(e);
        return n;
      });
      return;
    }
    // Adding: only an available account may be selected.
    if (!row || row.status === "used") {
      toast.push(USED_MESSAGE, "error");
      return;
    }
    if (row.status === "wrong") {
      toast.push(row.label ?? "That account is a different niche — pick a same-niche account.", "error");
      return;
    }
    setSel((s) => new Set(s).add(e));
  }

  // Order: selected first, then available, then used, then wrong. Filterable.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = (email: string, status: CandidateStatus): number => {
      if (sel.has(email)) return 0;
      if (status === "available") return 1;
      if (status === "used") return 2;
      return 3;
    };
    return rows
      .filter((r) => !q || r.email.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => {
        const ea = a.email.toLowerCase();
        const eb = b.email.toLowerCase();
        const ra = rank(ea, a.status);
        const rb = rank(eb, b.status);
        return ra - rb || ea.localeCompare(eb);
      });
  }, [rows, query, sel]);

  const availableCount = rows.filter((r) => r.status === "available").length;
  const selectedList = [...sel];

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
      title={title}
      size="lg"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              if (sel.size === 0) {
                toast.push("A cohort needs at least one account.", "error");
                return;
              }
              onSave(selectedList);
            }}
            disabled={saving || sel.size === 0}
          >
            {saving ? <Spinner /> : <Check size={14} />} {saveLabel} ({sel.size})
          </button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        {subtitle ? <p className="text-xs text-muted">{subtitle}</p> : null}
        {warning ? (
          <p className="flex items-start gap-1.5 rounded-lg border-2 border-ink bg-sun/30 p-2 text-[11px]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{warning}</span>
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input
              className="input w-full pl-7"
              placeholder="Filter accounts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className="btn-ghost btn-sm"
            onClick={() => setSel(new Set(rows.filter((r) => r.status === "available").map((r) => r.email.toLowerCase())))}
            title="Select every available (same-niche, unused) account"
          >
            Select all available ({availableCount})
          </button>
          <button className="btn-ghost btn-sm" onClick={() => setSel(new Set())}>
            Clear
          </button>
        </div>

        <div className="max-h-80 overflow-auto rounded-lg border-2 border-ink">
          {shown.length === 0 ? (
            <p className="p-3 text-xs text-muted">No accounts match.</p>
          ) : (
            shown.map((r) => {
              const e = r.email.toLowerCase();
              const checked = sel.has(e);
              const blocked = !checked && r.status !== "available";
              return (
                <label
                  key={r.email}
                  className={
                    "flex items-center gap-2 border-b border-ink/10 px-3 py-1.5 last:border-0 " +
                    (checked ? "bg-mint/10" : blocked ? "opacity-60" : "hover:bg-canvas")
                  }
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-ink"
                    checked={checked}
                    onChange={() => toggle(r.email)}
                  />
                  <span className="font-mono text-xs">{r.email}</span>
                  <span className="text-[11px] text-muted">{r.dailyLimit}/d</span>
                  <span className="ml-auto flex items-center gap-1">
                    {r.status === "available" ? (
                      <Badge tone="mint">available</Badge>
                    ) : r.status === "used" ? (
                      <span title={r.label || USED_MESSAGE}>
                        <Badge tone="danger">
                          <Ban size={10} className="mr-0.5 inline" /> {r.label ?? "used"}
                        </Badge>
                      </span>
                    ) : (
                      <span title={r.label || "different niche"}>
                        <Badge tone="white">{r.label ?? "wrong niche"}</Badge>
                      </span>
                    )}
                  </span>
                </label>
              );
            })
          )}
        </div>
        <p className="text-[11px] text-muted">
          Only <b>available</b> (same-niche, not used anywhere else) accounts can be added. Accounts already in
          this cohort can always be removed.
        </p>
      </div>
    </Modal>
  );
}
