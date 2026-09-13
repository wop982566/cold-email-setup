import { Check, Minus, X, CircleDashed } from "lucide-react";
import { TriState } from "../../lib/types";
import { cn } from "../../lib/utils";

export function TriStateBadge({ value }: { value: TriState }) {
  const map: Record<string, { cls: string; icon: JSX.Element; label: string }> = {
    Yes: {
      cls: "bg-mint text-white",
      icon: <Check size={12} />,
      label: "Yes",
    },
    No: {
      cls: "bg-danger text-white",
      icon: <X size={12} />,
      label: "No",
    },
    Partially: {
      cls: "bg-sun",
      icon: <CircleDashed size={12} />,
      label: "Partial",
    },
    NA: {
      cls: "bg-white text-muted",
      icon: <Minus size={12} />,
      label: "N/A",
    },
    "": {
      cls: "bg-white text-muted",
      icon: <Minus size={12} />,
      label: "—",
    },
  };
  const s = map[value] ?? map[""];
  return <span className={cn("badge", s.cls)}>{s.icon} {s.label}</span>;
}

// Provider monogram "logos" with brand colours — consistent and dependency-free.
const PROVIDERS: Record<string, { label: string; bg: string; fg: string }> = {
  ionos: { label: "IO", bg: "#003D8F", fg: "#fff" },
  cloudflare: { label: "CF", bg: "#F38020", fg: "#fff" },
  netlify: { label: "NL", bg: "#00AD9F", fg: "#fff" },
  "amazon ses": { label: "SES", bg: "#FF9900", fg: "#000" },
  ses: { label: "SES", bg: "#FF9900", fg: "#000" },
  aws: { label: "AWS", bg: "#232F3E", fg: "#fff" },
  instantly: { label: "IN", bg: "#3F6BFF", fg: "#fff" },
  gmail: { label: "GM", bg: "#EA4335", fg: "#fff" },
  google: { label: "G", bg: "#4285F4", fg: "#fff" },
  openai: { label: "AI", bg: "#10A37F", fg: "#fff" },
  gravatar: { label: "GR", bg: "#1E8CBE", fg: "#fff" },
  apollo: { label: "AP", bg: "#5C6CFF", fg: "#fff" },
};

export function ProviderLogo({ name, size = 22 }: { name: string; size?: number }) {
  const key = (name || "").trim().toLowerCase();
  const matchKey =
    Object.keys(PROVIDERS).find((k) => key.includes(k)) ?? null;
  const p = matchKey ? PROVIDERS[matchKey] : null;
  const label = p?.label ?? (name ? name.slice(0, 2).toUpperCase() : "?");
  return (
    <span
      className="inline-flex items-center justify-center rounded-md border-2 border-ink font-extrabold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        backgroundColor: p?.bg ?? "#fff",
        color: p?.fg ?? "#000",
      }}
      title={name}
    >
      {label}
    </span>
  );
}

export function ProviderTag({ name }: { name: string }) {
  if (!name) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderLogo name={name} size={18} />
      <span className="text-sm font-semibold">{name}</span>
    </span>
  );
}
