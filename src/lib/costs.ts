import { CostItem } from "./types";

export interface CostOptions {
  monthlyEmails?: number; // used to price per-1000-email items
}

export function monthlyCost(item: CostItem, opts: CostOptions = {}): number {
  if (!item.active) return 0;
  const { amount, quantity, billing_cycle } = item;
  switch (billing_cycle) {
    case "monthly":
      return amount * quantity;
    case "annual":
      return (amount * quantity) / 12;
    case "one-time":
      return 0;
    case "per-1000-emails": {
      const emails = opts.monthlyEmails ?? 0;
      return (emails / 1000) * amount;
    }
    default:
      return 0;
  }
}

export function annualCost(item: CostItem, opts: CostOptions = {}): number {
  if (!item.active) return 0;
  if (item.billing_cycle === "annual") return item.amount * item.quantity;
  if (item.billing_cycle === "one-time") return item.amount * item.quantity;
  return monthlyCost(item, opts) * 12;
}

export function totalMonthly(items: CostItem[], opts: CostOptions = {}): number {
  return items.reduce((sum, i) => sum + monthlyCost(i, opts), 0);
}

export function totalAnnual(items: CostItem[], opts: CostOptions = {}): number {
  return items.reduce((sum, i) => sum + annualCost(i, opts), 0);
}

export function byCategory(items: CostItem[], opts: CostOptions = {}) {
  const map = new Map<string, number>();
  for (const item of items) {
    const m = monthlyCost(item, opts);
    map.set(item.category, (map.get(item.category) ?? 0) + m);
  }
  return Array.from(map.entries())
    .map(([category, monthly]) => ({ category, monthly }))
    .sort((a, b) => b.monthly - a.monthly);
}
