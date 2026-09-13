// ---------------------------------------------------------------------------
// Build comprehensive CSV exports of the live Instantly workspace:
//   1. accounts.csv  — every email account with all its settings, its tags,
//                      and the campaigns it's connected to.
//   2. campaigns.csv — every campaign with the accounts connected to it + tags.
//   3. campaign-account-map.csv — one row per (campaign ↔ account) pair.
//
// Pure: it takes the raw payloads the Instantly proxy returns (accounts,
// campaigns, the custom-tags payload) and returns CSV strings. No network, no
// DOM — the Settings page fetches and triggers the download; this is unit-
// tested against sample payloads. Column sets are the UNION of every key the
// API returns, so "all their settings" stays true even as Instantly's fields
// change. Anything password/secret-shaped is masked, never exported.
// ---------------------------------------------------------------------------
import { csvCell } from "./dnsPlan";
import { parseTagPayload, normaliseTags } from "./tags";

type Row = Record<string, unknown>;

// Same shape the server proxy scrubs by, so a credential can't reach the CSV.
const SECRET_KEY = /pass|secret|token|credential|api[_-]?key/i;

function scrubValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === "object") {
    const o: Row = {};
    for (const [k, val] of Object.entries(v as Row)) o[k] = SECRET_KEY.test(k) ? "***" : scrubValue(val);
    return o;
  }
  return v;
}

/** One cell value: primitives as-is, objects/arrays as scrubbed JSON. */
function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(scrubValue(v));
}

function toCsv(headers: string[], rows: string[][]): string {
  const head = headers.map(csvCell).join(",");
  const body = rows.map((r) => r.map((c) => csvCell(c ?? "")).join(",")).join("\n");
  return body ? `${head}\n${body}` : head;
}

/** The union of top-level keys across rows, minus `skip`, priority keys first. */
function orderedKeys(rows: Row[], skip: Set<string>, priority: string[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!skip.has(k) && !SECRET_KEY.test(k)) seen.add(k);
  const rest = [...seen].filter((k) => !priority.includes(k)).sort();
  return [...priority.filter((k) => seen.has(k)), ...rest];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}
function email(v: unknown): string {
  return str(v).toLowerCase();
}
function campaignId(c: Row): string {
  return str(c.id) || str(c.campaign_id) || str((c as { _id?: unknown })._id);
}
function campaignName(c: Row): string {
  return str(c.name) || str(c.campaign_name) || str(c.title);
}
function emailListOf(c: Row): string[] {
  const list = (c as { email_list?: unknown }).email_list;
  return Array.isArray(list) ? list.map(email).filter(Boolean) : [];
}

export interface InstantlyExportInput {
  accounts: Row[];
  campaigns: Row[];
  /** The raw `data` from the Instantly `tags` resource, or null if unsupported. */
  tagsPayload?: unknown;
}

export interface InstantlyExport {
  accountsCsv: string;
  campaignsCsv: string;
  mapCsv: string;
  counts: { accounts: number; campaigns: number; connections: number; taggedAccounts: number };
}

const ACCOUNT_PRIORITY = [
  "first_name", "last_name", "status", "warmup_status", "daily_limit",
  "warmup_limit", "warmup_increment", "warmup_reply_rate", "provider_code",
  "tracking_domain_name", "timestamp_created", "timestamp_updated",
];
const CAMPAIGN_PRIORITY = ["status", "timestamp_created", "timestamp_updated"];

export function buildInstantlyExport(input: InstantlyExportInput): InstantlyExport {
  const accounts = input.accounts ?? [];
  const campaigns = input.campaigns ?? [];
  const ta = parseTagPayload(input.tagsPayload ?? null);

  // Reverse the campaign→email_list linkage into email→campaigns.
  const emailToCampaigns = new Map<string, { id: string; name: string }[]>();
  let connections = 0;
  for (const c of campaigns) {
    const id = campaignId(c);
    const name = campaignName(c);
    for (const e of emailListOf(c)) {
      const arr = emailToCampaigns.get(e) ?? [];
      arr.push({ id, name });
      emailToCampaigns.set(e, arr);
      connections++;
    }
  }

  // Per-account tags = the account's own inline tags ∪ the tags endpoint's
  // per-email assignments.
  const accountTags = (a: Row): string[] => {
    const inline = Array.isArray(a.tags)
      ? (a.tags as unknown[]).map((t) =>
          typeof t === "string" ? t : str((t as Row)?.name ?? (t as Row)?.label),
        )
      : [];
    return normaliseTags([...inline, ...(ta.byEmail.get(email(a.email)) ?? [])]);
  };
  const campaignTags = (c: Row): string[] => {
    const inline = Array.isArray(c.tags)
      ? (c.tags as unknown[]).map((t) =>
          typeof t === "string" ? t : str((t as Row)?.name ?? (t as Row)?.label),
        )
      : [];
    return normaliseTags([...inline, ...(ta.byCampaign.get(campaignId(c)) ?? [])]);
  };

  // --- accounts.csv ---
  const accKeys = orderedKeys(accounts, new Set(["email", "tags"]), ACCOUNT_PRIORITY);
  const accHeaders = ["email", "tags", "connected_campaigns", "connected_campaign_ids", ...accKeys];
  let taggedAccounts = 0;
  const accRows = accounts.map((a) => {
    const tags = accountTags(a);
    if (tags.length) taggedAccounts++;
    const conns = emailToCampaigns.get(email(a.email)) ?? [];
    return [
      email(a.email),
      tags.join("; "),
      conns.map((c) => c.name || c.id).join("; "),
      conns.map((c) => c.id).join("; "),
      ...accKeys.map((k) => cell(a[k])),
    ];
  });

  // --- campaigns.csv ---
  const campKeys = orderedKeys(
    campaigns,
    new Set(["id", "campaign_id", "name", "campaign_name", "email_list", "tags"]),
    CAMPAIGN_PRIORITY,
  );
  const campHeaders = ["campaign_id", "name", "tags", "connected_count", "connected_emails", ...campKeys];
  const campRows = campaigns.map((c) => {
    const list = emailListOf(c);
    return [
      campaignId(c),
      campaignName(c),
      campaignTags(c).join("; "),
      String(list.length),
      list.join("; "),
      ...campKeys.map((k) => cell(c[k])),
    ];
  });

  // --- campaign-account-map.csv (one row per connection) ---
  const accByEmail = new Map<string, Row>();
  for (const a of accounts) accByEmail.set(email(a.email), a);
  const mapHeaders = ["campaign_id", "campaign_name", "campaign_status", "email", "account_status", "account_tags"];
  const mapRows: string[][] = [];
  for (const c of campaigns) {
    const id = campaignId(c);
    const name = campaignName(c);
    const cStatus = str(c.status);
    for (const e of emailListOf(c)) {
      const a = accByEmail.get(e);
      mapRows.push([id, name, cStatus, e, a ? str(a.status) : "", a ? accountTags(a).join("; ") : ""]);
    }
  }

  return {
    accountsCsv: toCsv(accHeaders, accRows),
    campaignsCsv: toCsv(campHeaders, campRows),
    mapCsv: toCsv(mapHeaders, mapRows),
    counts: { accounts: accounts.length, campaigns: campaigns.length, connections, taggedAccounts },
  };
}
