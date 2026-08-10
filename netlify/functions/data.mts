// Server-side data store backed by Netlify Blobs. Replaces the Supabase
// backend — no external project to manage, nothing to pause, no keys, and it
// persists across devices. Each "table" is a JSON blob (an array of rows);
// settings are a single JSON object. All mutations are read-modify-write.
import { getStore } from "@netlify/blobs";

type Row = { id: string; [k: string]: unknown };

const STORE = "cec-data";

function store() {
  return getStore(STORE);
}

function tokenOk(req: Request): boolean {
  const required = process.env.APP_FUNCTION_TOKEN;
  if (!required) return true;
  return req.headers.get("x-app-token") === required;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function readTable(table: string): Promise<Row[]> {
  const data = (await store().get(table, { type: "json" })) as Row[] | null;
  return Array.isArray(data) ? data : [];
}
async function writeTable(table: string, rows: Row[]): Promise<void> {
  await store().setJSON(table, rows);
}

export default async (req: Request): Promise<Response> => {
  if (!tokenOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      if (url.searchParams.get("ping") != null) return json({ ok: true });
      const table = url.searchParams.get("table");
      if (!table) return json({ ok: false, error: "Missing table" }, 400);
      return json({ ok: true, rows: await readTable(table) });
    }

    if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

    const body = (await req.json()) as {
      op: string;
      table?: string;
      row?: Row;
      rows?: Row[];
      id?: string;
      ids?: string[];
      patch?: Record<string, unknown>;
      value?: unknown;
      tables?: Record<string, Row[]>;
      settings?: unknown;
    };
    const op = body.op;
    const table = body.table ?? "";

    switch (op) {
      case "getSettings": {
        const s = (await store().get("app_settings", { type: "json" })) as Record<string, unknown> | null;
        return json({ ok: true, value: s ?? null });
      }
      case "saveSettings": {
        await store().setJSON("app_settings", body.value ?? {});
        return json({ ok: true });
      }
      case "insert": {
        const rows = await readTable(table);
        const row = body.row as Row;
        rows.unshift(row);
        await writeTable(table, rows);
        return json({ ok: true, row });
      }
      case "insertMany": {
        const rows = await readTable(table);
        const add = body.rows ?? [];
        await writeTable(table, [...add, ...rows]);
        return json({ ok: true, rows: add });
      }
      case "update": {
        const rows = await readTable(table);
        let updated: Row | null = null;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].id === body.id) {
            rows[i] = { ...rows[i], ...(body.patch ?? {}) };
            updated = rows[i];
            break;
          }
        }
        await writeTable(table, rows);
        return json({ ok: true, row: updated });
      }
      case "updateMany": {
        const rows = await readTable(table);
        const set = new Set(body.ids ?? []);
        const patch = body.patch ?? {};
        for (let i = 0; i < rows.length; i++) if (set.has(rows[i].id)) rows[i] = { ...rows[i], ...patch };
        await writeTable(table, rows);
        return json({ ok: true });
      }
      case "upsertMany": {
        const rows = await readTable(table);
        const byId = new Map(rows.map((r) => [r.id, r] as const));
        for (const r of body.rows ?? []) {
          const ex = byId.get(r.id);
          byId.set(r.id, ex ? { ...ex, ...r } : r);
        }
        await writeTable(table, Array.from(byId.values()));
        return json({ ok: true });
      }
      case "remove": {
        const rows = await readTable(table);
        await writeTable(
          table,
          rows.filter((r) => r.id !== body.id),
        );
        return json({ ok: true });
      }
      case "removeMany": {
        const set = new Set(body.ids ?? []);
        const rows = await readTable(table);
        await writeTable(
          table,
          rows.filter((r) => !set.has(r.id)),
        );
        return json({ ok: true });
      }
      case "seedIfEmpty": {
        const s = store();
        const seeded = await s.get("__seeded", { type: "text" });
        if (seeded === "true") return json({ ok: true, seeded: false });
        for (const [t, rows] of Object.entries(body.tables ?? {})) {
          const existing = await s.get(t, { type: "json" });
          if (existing == null) await s.setJSON(t, rows);
        }
        if (body.settings) {
          const existing = await s.get("app_settings", { type: "json" });
          if (existing == null) await s.setJSON("app_settings", body.settings);
        }
        await s.set("__seeded", "true");
        return json({ ok: true, seeded: true });
      }
      default:
        return json({ ok: false, error: `Unknown op: ${op}` }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Server error" }, 500);
  }
};
