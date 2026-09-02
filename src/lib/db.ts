// ---------------------------------------------------------------------------
// Repository layer with two interchangeable backends:
//   • Server — Netlify Blobs via the /data function (default; persists across
//              devices, nothing to configure)
//   • Local  — browser localStorage, pre-seeded (when VITE_FORCE_LOCAL=true)
// Both expose the same async API so the rest of the app never branches on it.
// ---------------------------------------------------------------------------
import {
  AppSettings,
  DEFAULT_SETTINGS,
  SECRET_TABLES,
  TableName,
  TABLES,
} from "./types";
import {
  seedCampaigns,
  seedCapacity,
  seedCosts,
  seedDomains,
  seedLeadLists,
  seedLeads,
  seedSettings,
  seedSetups,
  seedSetupSteps,
} from "./seed";
import { uuid } from "./utils";

export type Row = { id: string; [key: string]: unknown };
// Records used across the app have a string id but typed fields (no index
// signature), so the public API constrains on this looser shape.
export type WithId = { id: string };

function seedFor(table: TableName): Row[] {
  switch (table) {
    case TABLES.campaigns:
      return seedCampaigns as unknown as Row[];
    case TABLES.domains:
      return seedDomains as unknown as Row[];
    case TABLES.capacity:
      return seedCapacity as unknown as Row[];
    case TABLES.costs:
      return seedCosts as unknown as Row[];
    case TABLES.leadLists:
      return seedLeadLists as unknown as Row[];
    case TABLES.leads:
      return seedLeads as unknown as Row[];
    case TABLES.setups:
      return seedSetups as unknown as Row[];
    case TABLES.setupSteps:
      return seedSetupSteps as unknown as Row[];
    default:
      return [];
  }
}

export interface Repo {
  mode: "server" | "local";
  list<T extends WithId>(table: TableName): Promise<T[]>;
  insert<T extends WithId>(table: TableName, row: Partial<T>): Promise<T>;
  insertMany<T extends WithId>(table: TableName, rows: Partial<T>[]): Promise<T[]>;
  update<T extends WithId>(
    table: TableName,
    id: string,
    patch: Partial<T>,
    opts?: { keepalive?: boolean },
  ): Promise<T>;
  updateMany<T extends WithId>(table: TableName, ids: string[], patch: Partial<T>): Promise<void>;
  upsertMany<T extends WithId>(table: TableName, rows: Partial<T>[]): Promise<void>;
  remove(table: TableName, id: string): Promise<void>;
  removeMany(table: TableName, ids: string[]): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(s: AppSettings): Promise<AppSettings>;
  ping(): Promise<void>;
  resetLocal?(): void;
}

// --------------------------------------------------------------------------
// Local adapter
// --------------------------------------------------------------------------
const LS_PREFIX = "cec:v1:";

function lsKey(table: string) {
  return `${LS_PREFIX}${table}`;
}

function lsRead<T = Row>(table: string): T[] {
  try {
    const raw = localStorage.getItem(lsKey(table));
    if (raw === null) return [];
    return JSON.parse(raw) as T[];
  } catch {
    return [];
  }
}

function lsWrite(table: string, rows: unknown[]) {
  localStorage.setItem(lsKey(table), JSON.stringify(rows));
}

function ensureSeeded() {
  if (localStorage.getItem(`${LS_PREFIX}__seeded`) === "true") return;
  for (const table of Object.values(TABLES)) {
    if (table === TABLES.settings) continue;
    if (localStorage.getItem(lsKey(table)) === null) {
      lsWrite(table, seedFor(table as TableName));
    }
  }
  if (localStorage.getItem(lsKey(TABLES.settings)) === null) {
    lsWrite(TABLES.settings, [{ id: "app", ...seedSettings }]);
  }
  localStorage.setItem(`${LS_PREFIX}__seeded`, "true");
}

const localRepo: Repo = {
  mode: "local",
  async list<T extends WithId>(table: TableName): Promise<T[]> {
    ensureSeeded();
    return lsRead<T>(table);
  },
  async insert<T extends WithId>(table: TableName, row: Partial<T>): Promise<T> {
    ensureSeeded();
    const rows = lsRead<T>(table);
    const record = {
      id: (row.id as string) ?? uuid(),
      created_at: new Date().toISOString(),
      ...row,
    } as unknown as T;
    rows.unshift(record);
    lsWrite(table, rows);
    return record;
  },
  async insertMany<T extends WithId>(table: TableName, newRows: Partial<T>[]): Promise<T[]> {
    ensureSeeded();
    const rows = lsRead<T>(table);
    const created = newRows.map(
      (r) =>
        ({
          id: (r.id as string) ?? uuid(),
          created_at: new Date().toISOString(),
          ...r,
        }) as unknown as T,
    );
    lsWrite(table, [...created, ...rows]);
    return created;
  },
  async update<T extends WithId>(table: TableName, id: string, patch: Partial<T>): Promise<T> {
    ensureSeeded();
    const rows = lsRead<T>(table);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`Row ${id} not found in ${table}`);
    rows[idx] = { ...rows[idx], ...patch, updated_at: new Date().toISOString() };
    lsWrite(table, rows);
    return rows[idx];
  },
  async updateMany<T extends WithId>(table: TableName, ids: string[], patch: Partial<T>): Promise<void> {
    ensureSeeded();
    if (ids.length === 0) return;
    const set = new Set(ids);
    const ts = new Date().toISOString();
    const rows = lsRead(table);
    for (let i = 0; i < rows.length; i++) {
      if (set.has(rows[i].id)) rows[i] = { ...rows[i], ...patch, updated_at: ts };
    }
    lsWrite(table, rows);
  },
  async upsertMany<T extends WithId>(table: TableName, newRows: Partial<T>[]): Promise<void> {
    ensureSeeded();
    if (newRows.length === 0) return;
    const ts = new Date().toISOString();
    const byId = new Map<string, Row>(lsRead(table).map((r) => [r.id, r] as const));
    for (const r of newRows) {
      const id = r.id as string;
      const existing = byId.get(id);
      byId.set(id, existing ? { ...existing, ...r, updated_at: ts } : ({ created_at: ts, ...r } as Row));
    }
    lsWrite(table, Array.from(byId.values()));
  },
  async remove(table: TableName, id: string): Promise<void> {
    ensureSeeded();
    lsWrite(
      table,
      lsRead(table).filter((r) => r.id !== id),
    );
  },
  async removeMany(table: TableName, ids: string[]): Promise<void> {
    ensureSeeded();
    const set = new Set(ids);
    lsWrite(
      table,
      lsRead(table).filter((r) => !set.has(r.id)),
    );
  },
  async getSettings(): Promise<AppSettings> {
    ensureSeeded();
    const rows = lsRead<Row>(TABLES.settings);
    const found = rows[0] as unknown as (AppSettings & { id: string }) | undefined;
    if (!found) return { ...DEFAULT_SETTINGS };
    const { id: _id, ...rest } = found;
    return { ...DEFAULT_SETTINGS, ...(rest as AppSettings) };
  },
  async saveSettings(s: AppSettings): Promise<AppSettings> {
    lsWrite(TABLES.settings, [{ id: "app", ...s }]);
    return s;
  },
  async ping(): Promise<void> {
    ensureSeeded();
  },
  resetLocal() {
    for (const table of Object.values(TABLES)) {
      localStorage.removeItem(lsKey(table));
    }
    localStorage.removeItem(`${LS_PREFIX}__seeded`);
    ensureSeeded();
  },
};

// --------------------------------------------------------------------------
// Server adapter — Netlify Blobs via the /data function.
// No external database, nothing to pause, persists across devices.
// --------------------------------------------------------------------------
const FN = "/.netlify/functions/data";
const APP_TOKEN = import.meta.env.VITE_APP_TOKEN as string | undefined;

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (APP_TOKEN) h["x-app-token"] = APP_TOKEN;
  return h;
}

async function api<T = unknown>(opts: {
  method: "GET" | "POST";
  query?: string;
  body?: unknown;
  /**
   * Let the request finish even if the page is unloading. Used by autosave's
   * pagehide flush, so a refresh between the last keystroke and the debounced
   * save still commits. Capped at 64KB by the browser, which a setup batch is
   * comfortably under.
   */
  keepalive?: boolean;
}): Promise<T> {
  const res = await fetch(FN + (opts.query ? `?${opts.query}` : ""), {
    method: opts.method,
    headers: apiHeaders(),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    keepalive: opts.keepalive,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON (e.g. function missing) */
  }
  const d = data as { ok?: boolean; error?: string } | null;
  if (!res.ok || (d && d.ok === false)) {
    throw new Error(d?.error || `Data request failed (HTTP ${res.status})`);
  }
  return data as T;
}

// Seed the store once (first run) with the same starter data local mode uses.
let seedPromise: Promise<void> | null = null;
function ensureServerSeeded(): Promise<void> {
  if (!seedPromise) {
    // Seed the infrastructure tables (domains, capacity, costs, campaigns,
    // playbooks) but NOT the leads area — the operator imports real leads, so
    // starting with demo leads/lists would just get in the way.
    const skipSeed: TableName[] = [TABLES.leads, TABLES.leadLists];
    const tables: Record<string, Row[]> = {};
    for (const table of Object.values(TABLES)) {
      if (table === TABLES.settings || skipSeed.includes(table)) continue;
      // Credential tables have no seed data and the server refuses to serve
      // them without a token — naming them here once broke every read.
      if (SECRET_TABLES.includes(table)) continue;
      tables[table] = seedFor(table as TableName);
    }
    seedPromise = api({ method: "POST", body: { op: "seedIfEmpty", tables, settings: seedSettings } })
      .then(() => undefined)
      .catch((e) => {
        seedPromise = null; // don't cache a failed seed — allow retry
        throw e;
      });
  }
  return seedPromise;
}

const serverRepo: Repo = {
  mode: "server",
  async list<T extends WithId>(table: TableName): Promise<T[]> {
    await ensureServerSeeded();
    const { rows } = await api<{ rows: T[] }>({ method: "GET", query: `table=${encodeURIComponent(table)}` });
    return rows ?? [];
  },
  async insert<T extends WithId>(table: TableName, row: Partial<T>): Promise<T> {
    await ensureServerSeeded();
    const payload = { id: (row.id as string) ?? uuid(), created_at: new Date().toISOString(), ...row };
    const { row: saved } = await api<{ row: T }>({ method: "POST", body: { op: "insert", table, row: payload } });
    return saved;
  },
  async insertMany<T extends WithId>(table: TableName, rows: Partial<T>[]): Promise<T[]> {
    await ensureServerSeeded();
    const ts = new Date().toISOString();
    const payload = rows.map((r) => ({ id: (r.id as string) ?? uuid(), created_at: ts, ...r }));
    await api({ method: "POST", body: { op: "insertMany", table, rows: payload } });
    return payload as unknown as T[];
  },
  async update<T extends WithId>(
    table: TableName,
    id: string,
    patch: Partial<T>,
    opts?: { keepalive?: boolean },
  ): Promise<T> {
    await ensureServerSeeded();
    const { row } = await api<{ row: T }>({
      method: "POST",
      body: { op: "update", table, id, patch: { ...patch, updated_at: new Date().toISOString() } },
      keepalive: opts?.keepalive,
    });
    return row;
  },
  async updateMany<T extends WithId>(table: TableName, ids: string[], patch: Partial<T>): Promise<void> {
    await ensureServerSeeded();
    await api({
      method: "POST",
      body: { op: "updateMany", table, ids, patch: { ...patch, updated_at: new Date().toISOString() } },
    });
  },
  async upsertMany<T extends WithId>(table: TableName, rows: Partial<T>[]): Promise<void> {
    await ensureServerSeeded();
    await api({ method: "POST", body: { op: "upsertMany", table, rows } });
  },
  async remove(table: TableName, id: string): Promise<void> {
    await ensureServerSeeded();
    await api({ method: "POST", body: { op: "remove", table, id } });
  },
  async removeMany(table: TableName, ids: string[]): Promise<void> {
    await ensureServerSeeded();
    await api({ method: "POST", body: { op: "removeMany", table, ids } });
  },
  async getSettings(): Promise<AppSettings> {
    await ensureServerSeeded();
    const { value } = await api<{ value: Partial<AppSettings> | null }>({
      method: "POST",
      body: { op: "getSettings" },
    });
    return { ...DEFAULT_SETTINGS, ...(value ?? {}) };
  },
  async saveSettings(s: AppSettings): Promise<AppSettings> {
    await ensureServerSeeded();
    await api({ method: "POST", body: { op: "saveSettings", value: s } });
    return s;
  },
  async ping(): Promise<void> {
    await api({ method: "GET", query: "ping=1" });
  },
};

// Default to the server (Netlify Blobs) backend. Set VITE_FORCE_LOCAL=true to
// use browser localStorage instead (e.g. plain `vite dev` without functions).
const forceLocal = (import.meta.env.VITE_FORCE_LOCAL as string | undefined) === "true";
export const db: Repo = forceLocal ? localRepo : serverRepo;
export const dbMode = db.mode;
export { uuid };
