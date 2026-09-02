import {
  differenceInCalendarDays,
  format,
  isValid,
  parseISO,
} from "date-fns";

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = parseISO(value);
  if (!isValid(d)) return value;
  return format(d, "dd MMM yyyy");
}

export function fmtDateShort(value: string | null | undefined): string {
  if (!value) return "—";
  const d = parseISO(value);
  if (!isValid(d)) return value;
  return format(d, "dd MMM");
}

export function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const d = parseISO(value);
  if (!isValid(d)) return null;
  return differenceInCalendarDays(d, new Date());
}

const currencySymbols: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  CAD: "C$",
  AUD: "A$",
};

export function currencySymbol(code: string): string {
  return currencySymbols[code] ?? `${code} `;
}

export function fmtMoney(amount: number, currency = "USD"): string {
  const sym = currencySymbol(currency);
  const rounded = Math.round(amount * 100) / 100;
  const str = rounded.toLocaleString(undefined, {
    minimumFractionDigits: rounded % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${sym}${str}`;
}

export function fmtNumber(n: number): string {
  return Math.round(n).toLocaleString();
}

export function fmtCompact(n: number): string {
  return Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

export function fmtPercent(n: number): string {
  return `${Math.round(n)}%`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
