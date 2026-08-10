import { ReactNode, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Globe,
  Gauge,
  Users,
  Mail,
  Plug,
  DollarSign,
  BookOpenCheck,
  BarChart3,
  Settings as SettingsIcon,
  Bell,
  Menu,
  X,
  Database,
  HardDrive,
  LogOut,
  AlertTriangle,
  Target,
} from "lucide-react";
import { authEnabled, signOut } from "../../lib/auth";
import { cn } from "../../lib/utils";
import { dbMode } from "../../lib/db";
import { useCollection, useDbHealth, useSettings } from "../../lib/hooks";
import { Domain, TABLES } from "../../lib/types";
import { daysUntil } from "../../lib/format";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/domains", label: "Domains", icon: Globe },
  { to: "/capacity", label: "Sending Capacity", icon: Gauge },
  { to: "/planner", label: "Campaign Planner", icon: Target },
  { to: "/leads", label: "Leads", icon: Users },
  { to: "/sequences", label: "Sequences", icon: Mail },
  { to: "/instantly", label: "Instantly", icon: Plug },
  { to: "/costs", label: "Costs", icon: DollarSign },
  { to: "/setups", label: "Setup Playbooks", icon: BookOpenCheck },
  { to: "/insights", label: "Insights", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl border-2 border-ink bg-pink shadow-hard-sm">
        <svg viewBox="0 0 64 64" width="20" height="20">
          <rect x="12" y="18" width="40" height="28" rx="4" fill="none" stroke="#000" strokeWidth="5" />
          <path d="M12 22 L32 38 L52 22" fill="none" stroke="#000" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="leading-none">
        <p className="text-sm font-extrabold">Cold Email</p>
        <p className="text-sm font-extrabold text-pink-dark">Command Center</p>
      </div>
    </div>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 rounded-xl border-2 px-3 py-2 text-sm font-bold transition-all",
              isActive
                ? "border-ink bg-sun shadow-hard-sm"
                : "border-transparent text-ink/80 hover:border-ink hover:bg-white",
            )
          }
        >
          <item.icon size={18} />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

function ModeBadge() {
  const isServer = dbMode === "server";
  return (
    <span
      className={cn("badge", isServer ? "bg-mint text-white" : "bg-sun")}
      title={
        isServer
          ? "Data is stored server-side in Netlify Blobs (persists across devices)"
          : "Local mode — data lives in this browser only"
      }
    >
      {isServer ? <Database size={12} /> : <HardDrive size={12} />}
      {isServer ? "Cloud" : "Local mode"}
    </span>
  );
}

function ReminderBell() {
  const { data: domains } = useCollection<Domain>(TABLES.domains);
  const { data: settings } = useSettings();
  const window = settings?.reminder_window_days ?? 30;
  const count = useMemo(() => {
    if (!domains) return 0;
    return domains.filter((d) => {
      const days = daysUntil(d.expiry_date);
      return days !== null && days <= window;
    }).length;
  }, [domains, window]);

  return (
    <NavLink
      to="/domains?filter=expiring"
      className="relative flex h-10 w-10 items-center justify-center rounded-xl border-2 border-ink bg-white shadow-hard-sm hover:bg-canvas"
      title={`${count} domain(s) expiring within ${window} days`}
    >
      <Bell size={18} />
      {count > 0 ? (
        <span className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-ink bg-danger px-1 text-[10px] font-extrabold text-white">
          {count}
        </span>
      ) : null}
    </NavLink>
  );
}

// Turn a raw data-store error into a likely cause + fix.
function diagnoseDbError(msg: string): { cause: string; fix: string } {
  const m = msg.toLowerCase();
  if (/failed to fetch|networkerror|load failed|http 404|not found|fetch/.test(m)) {
    return {
      cause: "The data function isn't reachable.",
      fix: "On Netlify, check that the deploy succeeded and Functions are enabled. Running locally? Use `netlify dev` (plain `vite` has no functions), or set VITE_FORCE_LOCAL=true for browser storage.",
    };
  }
  if (/blob|store|getstore/.test(m)) {
    return {
      cause: "Netlify Blobs isn't available for this deploy.",
      fix: "Deploy from Git on Netlify (Blobs is automatic there). A manual drag-and-drop zip deploy doesn't enable Blobs or functions.",
    };
  }
  if (/unauthorized|401|token/.test(m)) {
    return {
      cause: "The function rejected the request (token mismatch).",
      fix: "If you set APP_FUNCTION_TOKEN, make sure VITE_APP_TOKEN matches it, then redeploy.",
    };
  }
  return { cause: "The data store returned an error.", fix: "See the message below; check the Netlify function logs for detail." };
}

function DbHealthBanner() {
  const { isError, error, isLoading } = useDbHealth();
  if (dbMode !== "server" || isLoading || !isError) return null;
  const msg = error instanceof Error ? error.message : String(error);
  const { cause, fix } = diagnoseDbError(msg);
  return (
    <div className="mb-4 rounded-xl border-2 border-ink bg-danger/15 p-3 text-sm">
      <p className="flex items-center gap-2 font-extrabold">
        <AlertTriangle size={16} /> Can't reach your data store — that's why everything shows 0.
      </p>
      <p className="mt-1">
        <span className="font-bold">Likely cause:</span> {cause}
      </p>
      <p className="mt-0.5">
        <span className="font-bold">Fix:</span> {fix}
      </p>
      <p className="mt-1 break-words rounded-lg border-2 border-ink/20 bg-white/60 px-2 py-1 font-mono text-xs">
        {msg}
      </p>
    </div>
  );
}

function PageTitle() {
  const { pathname } = useLocation();
  const item = NAV.find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to) && n.to !== "/"));
  return <h1 className="text-lg font-extrabold">{item?.label ?? "Dashboard"}</h1>;
}

export function Layout({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { data: settings } = useSettings();

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r-2 border-ink bg-canvas p-4 lg:flex">
        <Brand />
        <div className="mt-6 flex-1">
          <NavItems />
        </div>
        <div className="rounded-xl border-2 border-ink bg-white p-3 text-xs">
          <p className="font-bold">{settings?.org_name ?? "Workspace"}</p>
          <p className="mt-1 text-muted">Cold email infrastructure cockpit.</p>
        </div>
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-72 border-r-2 border-ink bg-canvas p-4">
            <div className="flex items-center justify-between">
              <Brand />
              <button
                onClick={() => setOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-lg border-2 border-ink bg-white"
              >
                <X size={16} />
              </button>
            </div>
            <div className="mt-6">
              <NavItems onNavigate={() => setOpen(false)} />
            </div>
          </aside>
        </div>
      ) : null}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b-2 border-ink bg-canvas/95 px-4 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-xl border-2 border-ink bg-white shadow-hard-sm lg:hidden"
            >
              <Menu size={18} />
            </button>
            <PageTitle />
          </div>
          <div className="flex items-center gap-2">
            <ModeBadge />
            <ReminderBell />
            {authEnabled ? (
              <button
                onClick={() => {
                  signOut();
                  window.location.reload();
                }}
                className="flex h-10 w-10 items-center justify-center rounded-xl border-2 border-ink bg-white shadow-hard-sm hover:bg-canvas"
                title="Sign out"
              >
                <LogOut size={18} />
              </button>
            ) : null}
          </div>
        </header>
        <main className="flex-1 p-4 lg:p-6">
          <DbHealthBanner />
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  );
}
