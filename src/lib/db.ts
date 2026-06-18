// ---------------------------------------------------------------------------
// Repository layer with two interchangeable backends:
//   • Supabase  — used when VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are set
//   • Local     — browser localStorage, pre-seeded, used otherwise
// Both expose the same async API so the rest of the app never branches on it.
// ---------------------------------------------------------------------------
import { isSupabaseConfigured, supabase } from "./supabase";
import {
  AppSettings,
  DEFAULT_SETTINGS,
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

// Split an array into chunks (Supabase .in() URLs and upsert bodies have limits).
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
  mode: "supabase" | "local";
  list<T extends WithId>(table: TableName): Promise<T[]>;
  insert<T extends WithId>(table: TableName, row: Partial<T>): Promise<T>;
  insertMany<T extends WithId>(table: TableName, rows: Partial<T>[]): Promise<T[]>;
  update<T extends WithId>(table: TableName, id: string, patch: Partial<T>): Promise<T>;
  updateMany<T extends WithId>(table: TableName, ids: string[], patch: Partial<T>): Promise<void>;
  upsertMany<T extends WithId>(table: TableName, rows: Partial<T>[]): Promise<void>;
  remove(table: TableName, id: string): Promise<void>;
  removeMany(table: TableName, ids: string[]): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(s: AppSettings): Promise<AppSettings>;
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
  resetLocal() {
    for (const table of Object.values(TABLES)) {
      localStorage.removeItem(lsKey(table));
    }
    localStorage.removeItem(`${LS_PREFIX}__seeded`);
    ensureSeeded();
  },
};

// --------------------------------------------------------------------------
// Supabase adapter
// --------------------------------------------------------------------------
const supabaseRepo: Repo = {
  mode: "supabase",
  async list<T extends WithId>(table: TableName): Promise<T[]> {
    // PostgREST caps a single select at ~1000 rows. Page through with the
    // exact count so large tables (thousands of leads) load completely.
    const PAGE = 1000;
    const first = await supabase!.from(table).select("*", { count: "exact" }).range(0, PAGE - 1);
    if (first.error) throw first.error;
    const out = (first.data ?? []) as T[];
    const total = first.count ?? out.length;
    while (out.length < total) {
      const { data, error } = await supabase!
        .from(table)
        .select("*")
        .range(out.length, out.length + PAGE - 1);
      if (error) throw error;
      const batch = (data ?? []) as T[];
      if (batch.length === 0) break; // safety: nothing more to fetch
      out.push(...batch);
    }
    return out;
  },
  async insert<T extends WithId>(table: TableName, row: Partial<T>): Promise<T> {
    const payload = { id: (row.id as string) ?? uuid(), ...row };
    const { data, error } = await supabase!.from(table).insert(payload).select().single();
    if (error) throw error;
    return data as T;
  },
  async insertMany<T extends WithId>(table: TableName, rows: Partial<T>[]): Promise<T[]> {
    const payload = rows.map((r) => ({ id: (r.id as string) ?? uuid(), ...r }));
    const { data, error } = await supabase!.from(table).insert(payload).select();
    if (error) throw error;
    return (data ?? []) as T[];
  },
  async update<T extends WithId>(table: TableName, id: string, patch: Partial<T>): Promise<T> {
    const { data, error } = await supabase!
      .from(table)
      .update(patch as Record<string, unknown>)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data as T;
  },
  async updateMany<T extends WithId>(table: TableName, ids: string[], patch: Partial<T>): Promise<void> {
    // Chunk ids — a single .in() with thousands of ids overflows the URL.
    for (const batch of chunk(ids, 200)) {
      const { error } = await supabase!
        .from(table)
        .update(patch as Record<string, unknown>)
        .in("id", batch);
      if (error) throw error;
    }
  },
  async upsertMany<T extends WithId>(table: TableName, rows: Partial<T>[]): Promise<void> {
    for (const batch of chunk(rows, 500)) {
      const { error } = await supabase!
        .from(table)
        .upsert(batch as Record<string, unknown>[], { onConflict: "id" });
      if (error) throw error;
    }
  },
  async remove(table: TableName, id: string): Promise<void> {
    const { error } = await supabase!.from(table).delete().eq("id", id);
    if (error) throw error;
  },
  async removeMany(table: TableName, ids: string[]): Promise<void> {
    for (const batch of chunk(ids, 200)) {
      const { error } = await supabase!.from(table).delete().in("id", batch);
      if (error) throw error;
    }
  },
  async getSettings(): Promise<AppSettings> {
    const { data, error } = await supabase!
      .from(TABLES.settings)
      .select("value")
      .eq("id", "app")
      .maybeSingle();
    if (error) throw error;
    const value = (data?.value as Partial<AppSettings>) ?? {};
    return { ...DEFAULT_SETTINGS, ...value };
  },
  async saveSettings(s: AppSettings): Promise<AppSettings> {
    const { error } = await supabase!
      .from(TABLES.settings)
      .upsert({ id: "app", value: s });
    if (error) throw error;
    return s;
  },
};

export const db: Repo = isSupabaseConfigured ? supabaseRepo : localRepo;
export const dbMode = db.mode;
export { uuid };
