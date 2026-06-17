import { ReactNode, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Globe,
  Gauge,
  Users,
  Mail,
  DollarSign,
  BookOpenCheck,
  BarChart3,
  Settings as SettingsIcon,
  Bell,
  Menu,
  X,
  Database,
  HardDrive,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { dbMode } from "../../lib/db";
import { useCollection, useSettings } from "../../lib/hooks";
import { Domain, TABLES } from "../../lib/types";
import { daysUntil } from "../../lib/format";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/domains", label: "Domains", icon: Globe },
  { to: "/capacity", label: "Sending Capacity", icon: Gauge },
  { to: "/leads", label: "Leads", icon: Users },
  { to: "/sequences", label: "Sequences", icon: Mail },
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
  const isSupabase = dbMode === "supabase";
  return (
    <span
      className={cn(
        "badge",
        isSupabase ? "bg-mint text-white" : "bg-sun",
      )}
      title={
        isSupabase
          ? "Connected to Supabase"
          : "Local mode — data lives in your browser until Supabase is connected"
      }
    >
      {isSupabase ? <Database size={12} /> : <HardDrive size={12} />}
      {isSupabase ? "Supabase" : "Local mode"}
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
          </div>
        </header>
        <main className="flex-1 p-4 lg:p-6">{children ?? <Outlet />}</main>
      </div>
    </div>
  );
}
