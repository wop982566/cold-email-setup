import { useMemo, useState } from "react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from "recharts";
import {
  Plus,
  Pencil,
  Trash2,
  DollarSign,
  CalendarClock,
  Receipt,
} from "lucide-react";
import { Card, StatCard, Badge, EmptyState } from "../components/ui/primitives";
import { Modal, ConfirmDialog } from "../components/ui/Modal";
import { Field, TextField, NumberField, SelectField, TextArea } from "../components/ui/Field";
import { ProviderLogo } from "../components/ui/badges";
import { useToast } from "../components/ui/toast";
import {
  useCollection,
  useInsert,
  useUpdate,
  useRemove,
  useSettings,
} from "../lib/hooks";
import {
  BillingCycle,
  CapacitySource,
  CostCategory,
  CostItem,
  Domain,
  TABLES,
} from "../lib/types";
import { computeCapacity } from "../lib/capacity";
import {
  monthlyCost,
  annualCost,
  totalMonthly,
  totalAnnual,
  byCategory,
} from "../lib/costs";
import { fmtMoney, fmtDate, daysUntil } from "../lib/format";
import { uuid } from "../lib/utils";

const CATEGORIES: CostCategory[] = [
  "Domains",
  "Email Infrastructure",
  "Sending",
  "Hosting",
  "Tools",
  "AI",
  "Other",
];
const CYCLES: { value: BillingCycle; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annual" },
  { value: "one-time", label: "One-time" },
  { value: "per-1000-emails", label: "Per 1,000 emails" },
];
const CATEGORY_COLORS: Record<string, string> = {
  Domains: "#FF90E8",
  "Email Infrastructure": "#90A8ED",
  Sending: "#FFC900",
  Hosting: "#23A094",
  Tools: "#FF7051",
  AI: "#10A37F",
  Other: "#B23386",
};

export default function Costs() {
  const toast = useToast();
  const { data: costs = [] } = useCollection<CostItem>(TABLES.costs);
  const { data: domains = [] } = useCollection<Domain>(TABLES.domains);
  const { data: capacitySources = [] } = useCollection<CapacitySource>(TABLES.capacity);
  const { data: settings } = useSettings();
  const insert = useInsert<CostItem>(TABLES.costs);
  const update = useUpdate<CostItem>(TABLES.costs);
  const remove = useRemove(TABLES.costs);

  const [editing, setEditing] = useState<CostItem | null>(null);
  const [deleting, setDeleting] = useState<CostItem | null>(null);

  const currency = settings?.currency ?? "USD";
  const cap = settings ? computeCapacity(domains, capacitySources, settings) : null;
  const opts = { monthlyEmails: cap?.effectiveMonthly };

  const monthly = totalMonthly(costs, opts);
  const annual = totalAnnual(costs, opts);
  const perDomain = domains.length > 0 ? annual / domains.length : 0;
  const costPer1k = cap && cap.effectiveMonthly > 0 ? (monthly / cap.effectiveMonthly) * 1000 : 0;

  const pieData = useMemo(
    () => byCategory(costs, opts).map((c) => ({ name: c.category, value: Math.round(c.monthly * 100) / 100 })),
    [costs, opts],
  );

  const renewals = useMemo(
    () =>
      costs
        .filter((c) => c.renews_on)
        .map((c) => ({ c, days: daysUntil(c.renews_on) }))
        .filter((x) => x.days !== null)
        .sort((a, b) => (a.days as number) - (b.days as number))
        .slice(0, 6),
    [costs],
  );

  async function save(item: CostItem) {
    const exists = costs.some((c) => c.id === item.id);
    if (exists) {
      const { id, created_at, ...patch } = item;
      await update.mutateAsync({ id, patch });
    } else {
      await insert.mutateAsync(item);
    }
    toast.push(`Saved ${item.name}`);
    setEditing(null);
  }

  function blank(): CostItem {
    return {
      id: uuid(),
      name: "",
      category: "Tools",
      provider: "",
      amount: 0,
      currency,
      billing_cycle: "monthly",
      quantity: 1,
      renews_on: null,
      notes: "",
      active: true,
    };
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Monthly spend" value={fmtMoney(monthly, currency)} tone="sun" icon={<DollarSign size={18} />} />
        <StatCard label="Annual spend" value={fmtMoney(annual, currency)} tone="pink" icon={<Receipt size={18} />} />
        <StatCard label="Cost / domain / yr" value={fmtMoney(perDomain, currency)} sublabel={`${domains.length} domains`} tone="lavender" />
        <StatCard label="Cost / 1k emails" value={fmtMoney(costPer1k, currency)} sublabel="at current capacity" tone="mint" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="p-5">
          <h2 className="mb-2 text-lg">Spend by category</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" outerRadius={80} stroke="#000" strokeWidth={2}>
                  {pieData.map((entry, i) => (
                    <Cell key={i} fill={CATEGORY_COLORS[entry.name] ?? "#999"} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => fmtMoney(v, currency)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-3 flex items-center gap-2 text-lg">
            <CalendarClock size={18} /> Upcoming renewals
          </h2>
          {renewals.length === 0 ? (
            <p className="text-sm text-muted">No renewal dates set on your cost items.</p>
          ) : (
            <div className="space-y-2">
              {renewals.map(({ c, days }) => (
                <div key={c.id} className="flex items-center justify-between rounded-xl border-2 border-ink bg-white p-3">
                  <div className="flex items-center gap-3">
                    <ProviderLogo name={c.provider || c.name} />
                    <div>
                      <p className="font-bold">{c.name}</p>
                      <p className="text-xs text-muted">{fmtDate(c.renews_on)} · {fmtMoney(c.amount * c.quantity, c.currency)}</p>
                    </div>
                  </div>
                  <Badge tone={(days as number) <= 7 ? "danger" : (days as number) <= 30 ? "coral" : "white"}>
                    {(days as number) < 0 ? "Overdue" : `${days}d`}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b-2 border-ink p-4">
          <h2 className="text-lg">Cost items</h2>
          <button className="btn-primary btn-sm" onClick={() => setEditing(blank())}>
            <Plus size={14} /> Add cost
          </button>
        </div>
        {costs.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={<DollarSign size={32} />} title="No costs tracked" description="Add your domains, SES, Instantly, hosting and tools to see true cost." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b-2 border-ink bg-canvas text-xs uppercase">
                  <th className="table-cell">Item</th>
                  <th className="table-cell">Category</th>
                  <th className="table-cell">Amount</th>
                  <th className="table-cell">Cycle</th>
                  <th className="table-cell">Monthly</th>
                  <th className="table-cell">Annual</th>
                  <th className="table-cell">Renews</th>
                  <th className="table-cell text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.id} className={!c.active ? "opacity-50" : ""}>
                    <td className="table-cell">
                      <div className="flex items-center gap-2">
                        <ProviderLogo name={c.provider || c.name} size={18} />
                        <span className="font-bold">{c.name}</span>
                      </div>
                    </td>
                    <td className="table-cell">
                      <span className="badge" style={{ background: CATEGORY_COLORS[c.category] }}>
                        {c.category}
                      </span>
                    </td>
                    <td className="table-cell">
                      {fmtMoney(c.amount, c.currency)}
                      {c.quantity > 1 ? <span className="text-muted"> × {c.quantity}</span> : null}
                    </td>
                    <td className="table-cell text-muted">{c.billing_cycle}</td>
                    <td className="table-cell font-bold">{fmtMoney(monthlyCost(c, opts), currency)}</td>
                    <td className="table-cell">{fmtMoney(annualCost(c, opts), currency)}</td>
                    <td className="table-cell text-muted">{c.renews_on ? fmtDate(c.renews_on) : "—"}</td>
                    <td className="table-cell text-right">
                      <div className="flex justify-end gap-1">
                        <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-canvas" onClick={() => setEditing(c)}>
                          <Pencil size={13} />
                        </button>
                        <button className="rounded-lg border-2 border-ink bg-white p-1.5 hover:bg-danger hover:text-white" onClick={() => setDeleting(c)}>
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

      {editing ? <CostModal item={editing} onClose={() => setEditing(null)} onSave={save} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        title="Delete cost item"
        message={`Remove ${deleting?.name}?`}
      />
    </div>
  );
}

function CostModal({
  item,
  onClose,
  onSave,
}: {
  item: CostItem;
  onClose: () => void;
  onSave: (c: CostItem) => void;
}) {
  const [form, setForm] = useState<CostItem>(item);
  const set = <K extends keyof CostItem>(k: K, v: CostItem[K]) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      open
      onClose={onClose}
      title={item.name ? `Edit ${item.name}` : "Add cost"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(form)} disabled={!form.name}>
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          <TextField value={form.name} onChange={(v) => set("name", v)} />
        </Field>
        <Field label="Provider">
          <TextField value={form.provider} onChange={(v) => set("provider", v)} />
        </Field>
        <Field label="Category">
          <SelectField value={form.category} onChange={(v) => set("category", v as CostCategory)} options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
        </Field>
        <Field label="Amount">
          <NumberField value={form.amount} onChange={(v) => set("amount", v ?? 0)} min={0} step={0.01} />
        </Field>
        <Field label="Quantity">
          <NumberField value={form.quantity} onChange={(v) => set("quantity", v ?? 1)} min={1} />
        </Field>
        <Field label="Billing cycle">
          <SelectField value={form.billing_cycle} onChange={(v) => set("billing_cycle", v as BillingCycle)} options={CYCLES} />
        </Field>
        <Field label="Currency">
          <TextField value={form.currency} onChange={(v) => set("currency", v)} />
        </Field>
        <Field label="Renews on">
          <TextField type="date" value={form.renews_on ?? ""} onChange={(v) => set("renews_on", v || null)} />
        </Field>
        <Field label="Active">
          <SelectField value={form.active ? "yes" : "no"} onChange={(v) => set("active", v === "yes")} options={[{ value: "yes", label: "Active" }, { value: "no", label: "Inactive" }]} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <TextArea value={form.notes} onChange={(v) => set("notes", v)} />
        </Field>
      </div>
    </Modal>
  );
}
