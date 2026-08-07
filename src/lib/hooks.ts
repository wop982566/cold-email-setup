import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { db, WithId } from "./db";
import { AppSettings, TableName } from "./types";

export function useCollection<T extends WithId>(table: TableName) {
  return useQuery({
    queryKey: [table],
    queryFn: () => db.list<T>(table),
    staleTime: 1000 * 30,
  });
}

// Verifies the app can actually read from the configured backend. On Supabase
// this surfaces paused-project / missing-migration / RLS / bad-key errors
// instead of silently rendering empty data.
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
