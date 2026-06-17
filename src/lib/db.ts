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
    const { data, error } = await supabase!.from(table).select("*");
    if (error) throw error;
    return (data ?? []) as T[];
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
  async remove(table: TableName, id: string): Promise<void> {
    const { error } = await supabase!.from(table).delete().eq("id", id);
    if (error) throw error;
  },
  async removeMany(table: TableName, ids: string[]): Promise<void> {
    const { error } = await supabase!.from(table).delete().in("id", ids);
    if (error) throw error;
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
