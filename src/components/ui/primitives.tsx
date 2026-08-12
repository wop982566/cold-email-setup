import { ReactNode, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

export function Card({
  children,
  className,
  flat,
}: {
  children: ReactNode;
  className?: string;
  flat?: boolean;
}) {
  return <div className={cn(flat ? "card-flat" : "card", className)}>{children}</div>;
}

export function SectionTitle({
  title,
  subtitle,
  icon,
  action,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div className="flex items-center gap-3">
        {icon ? (
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border-2 border-ink bg-pink shadow-hard-sm">
            {icon}
          </span>
        ) : null}
        <div>
          <h2 className="text-xl leading-none">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
        </div>
      </div>
      {action}
    </div>
  );
}

const badgeTones: Record<string, string> = {
  pink: "bg-pink",
  sun: "bg-sun",
  mint: "bg-mint text-white",
  lime: "bg-lime",
  coral: "bg-coral text-white",
  sky: "bg-sky",
  lavender: "bg-lavender",
  danger: "bg-danger text-white",
  ink: "bg-ink text-white",
  white: "bg-white",
};

export function Badge({
  children,
  tone = "white",
  className,
}: {
  children: ReactNode;
  tone?: keyof typeof badgeTones;
  className?: string;
}) {
  return <span className={cn("badge", badgeTones[tone], className)}>{children}</span>;
}

export function ProgressBar({
  value,
  max = 100,
  color = "#FF90E8",
  height = 14,
}: {
  value: number;
  max?: number;
  color?: string;
  height?: number;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      className="w-full overflow-hidden rounded-full border-2 border-ink bg-white"
      style={{ height }}
    >
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

export function StatCard({
  label,
  value,
  sublabel,
  tone = "white",
  icon,
}: {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  tone?: keyof typeof badgeTones;
  icon?: ReactNode;
}) {
  return (
    <div className={cn("card p-4", badgeTones[tone])}>
      <div className="flex items-start justify-between">
        <p className="text-xs font-bold uppercase tracking-wide opacity-70">{label}</p>
        {icon}
      </div>
      <p className="mt-2 text-3xl font-extrabold leading-none">{value}</p>
      {sublabel ? <p className="mt-1 text-xs font-semibold opacity-70">{sublabel}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-ink/40 bg-white/60 p-10 text-center">
      {icon ? <div className="mb-3 text-ink/70">{icon}</div> : null}
      <h3 className="text-lg font-bold">{title}</h3>
      {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm font-semibold text-muted">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-ink border-t-transparent" />
      {label ?? "Loading…"}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2"
    >
      <span
        className={cn(
          "relative h-6 w-11 rounded-full border-2 border-ink transition-colors",
          checked ? "bg-mint" : "bg-white",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full border-2 border-ink bg-white transition-all",
            checked ? "left-5" : "left-0.5",
          )}
        />
      </span>
      {label ? <span className="text-sm font-semibold">{label}</span> : null}
    </button>
  );
}

/**
 * Secondary detail, collapsed by default.
 *
 * Exists because the maintenance tab grew a habit of showing everything at
 * once — diagnostics, campaign lists, copy buttons — until the thing you
 * actually had to decide was buried. Anything that only matters once you've
 * asked goes in here.
 */
export function Details({
  summary,
  children,
  className,
}: {
  summary: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("mt-1.5", className)}>
      <button
        className="flex items-center gap-1 text-[11px] font-semibold text-muted hover:text-ink"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {summary}
      </button>
      {open ? <div className="mt-1.5">{children}</div> : null}
    </div>
  );
}
