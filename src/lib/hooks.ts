import { useCallback, useEffect, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { db, WithId } from "./db";
import { AppSettings, TableName } from "./types";

export function useCollection<T extends WithId>(
  table: TableName,
  // Escape hatch for tables that can fail permanently — the credentials table
  // 403s until APP_FUNCTION_TOKEN is set, and retrying that is pure delay.
  options?: { retry?: boolean | number },
) {
  return useQuery({
    queryKey: [table],
    queryFn: () => db.list<T>(table),
    staleTime: 1000 * 30,
    ...options,
  });
}

// Verifies the app can actually read from the configured backend, so a data
// function/store outage surfaces as a clear banner instead of silent zeros.
export function useDbHealth() {
  return useQuery({
    queryKey: ["__db_health"],
    queryFn: async () => {
      await db.ping();
      return true as const;
    },
    retry: false,
    staleTime: 1000 * 60,
  });
}

export function useInsert<T extends WithId>(table: TableName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (row: Partial<T>) => db.insert<T>(table, row),
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  });
}

export function useInsertMany<T extends WithId>(table: TableName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: Partial<T>[]) => db.insertMany<T>(table, rows),
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  });
}

export function useUpdate<T extends WithId>(table: TableName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<T> }) =>
      db.update<T>(table, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  });
}

export function useUpdateMany<T extends WithId>(table: TableName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: Partial<T> }) =>
      db.updateMany<T>(table, ids, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  });
}

export function useUpsertMany<T extends WithId>(table: TableName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: Partial<T>[]) => db.upsertMany<T>(table, rows),
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  });
}

export function useRemove(table: TableName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => db.remove(table, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  });
}

export function useRemoveMany(table: TableName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => db.removeMany(table, ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["__settings"],
    queryFn: () => db.getSettings(),
    staleTime: 1000 * 60,
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: AppSettings) => db.saveSettings(s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["__settings"] }),
  });
}

// --- Autosave ---------------------------------------------------------------

export type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Debounced autosave with the two flushes that make it survive a refresh.
 *
 * The Bulk Setup page keeps state that is expensive to retype — DKIM tokens
 * copied out of AWS one domain at a time — and saves it server-side only, by
 * choice. That leaves a window where a refresh lands between the last keystroke
 * and the save. Three things close it:
 *
 *   • a short debounce, so the window is small to begin with;
 *   • `flush()`, called on blur, so leaving a field commits it;
 *   • a `pagehide` flush using `fetch(keepalive:true)` inside the save
 *     function, which the browser completes even as the page unloads.
 *
 * `sendBeacon` would be the obvious tool for the last one and is the wrong
 * one — it cannot set the `x-app-token` header that the data function requires.
 */
export function useDebouncedSave<T>(
  value: T,
  save: (value: T) => Promise<unknown>,
  {
    delay = 700,
    enabled = true,
    dirty,
  }: { delay?: number; enabled?: boolean; dirty: boolean },
) {
  const [state, setState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside callbacks so the unload handler always sees the latest value
  // rather than whatever was current when the listener was registered.
  const latest = useRef(value);
  latest.current = value;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const saveRef = useRef(save);
  saveRef.current = save;

  const run = useCallback(async () => {
    if (!dirtyRef.current) return;
    setState("saving");
    try {
      await saveRef.current(latest.current);
      setState("saved");
      setSavedAt(new Date());
    } catch {
      // Left as an error rather than retried forever: a failing save that keeps
      // quietly retrying is how you lose work while being told it's fine.
      setState("error");
    }
  }, []);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void run();
  }, [run]);

  useEffect(() => {
    if (!enabled || !dirty) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, enabled, dirty, delay, run]);

  useEffect(() => {
    if (!enabled) return;
    // pagehide covers refresh, navigation and tab close; visibilitychange
    // covers switching apps on mobile, where pagehide may never fire.
    const onHide = () => {
      if (dirtyRef.current) void run();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [enabled, run]);

  return { state, savedAt, flush };
}
