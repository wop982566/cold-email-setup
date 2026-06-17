// ---------------------------------------------------------------------------
// Domain model shared across the app. These mirror the Supabase tables defined
// in supabase/migrations/0001_init.sql. Every record has a string uuid `id`.
// ---------------------------------------------------------------------------

export type ID = string;

export type TriState = "Yes" | "No" | "Partially" | "NA" | "";

export interface BaseRow {
  id: ID;
  created_at?: string;
  updated_at?: string;
}

export interface Campaign extends BaseRow {
  name: string;
  type: string; // e.g. AEO, CBD, Backlink
  description: string;
  color: string; // hex used for chips/badges
  status: "active" | "paused" | "archived";
}

export interface Domain extends BaseRow {
  position: number;
  domain_name: string;
  email_1: string;
  email_2: string;
  expiry_date: string | null; // ISO yyyy-mm-dd
  expiry_source: "manual" | "auto";
  expiry_checked_at: string | null;
  domain_provider: string; // registrar e.g. IONOS
  mailing_server: string; // e.g. "SES done"
  mailing_status: TriState;
  dns_provider: string; // e.g. Cloudflare
  dns_status: TriState;
  email_forward: string; // e.g. Cloudflare
  hosting_provider: string; // e.g. Netlify
  hosting_account: string; // e.g. "git login - tanuj9825"
  website_note: string;
  emails_forwarded_to: string;
  campaign_id: ID | null;
  campaign_label: string; // denormalized label fallback
  gravatar: TriState;
  gmail_send_configured: TriState;
  connected_to_instantly: TriState;
  warmup_started: TriState;
  mailbox_daily_limit: number | null; // per-mailbox/day override for this domain
  renewal_cost: number; // annual cost for this domain
  notes: string;
  custom: Record<string, unknown>;
}

export interface CapacitySource extends BaseRow {
  name: string; // Amazon SES, Instantly...
  kind: "sending" | "contacts";
  limit_amount: number;
  limit_period: "day" | "week" | "month"; // window for the limit
  used_amount: number; // optional manual "currently used"
  color: string;
  notes: string;
  enabled: boolean;
  sort: number;
}

export type CostCategory =
  | "Domains"
  | "Email Infrastructure"
  | "Sending"
  | "Hosting"
  | "Tools"
  | "AI"
  | "Other";

export type BillingCycle = "monthly" | "annual" | "one-time" | "per-1000-emails";

export interface CostItem extends BaseRow {
  name: string;
  category: CostCategory;
  provider: string;
  amount: number;
  currency: string;
  billing_cycle: BillingCycle;
  quantity: number;
  renews_on: string | null;
  notes: string;
  active: boolean;
}

export interface LeadList extends BaseRow {
  name: string;
  parent_id: ID | null; // for sub-lists
  description: string;
  color: string;
  source: string; // where it was scraped from
}

export type LeadStatus =
  | "new"
  | "enriched"
  | "queued"
  | "used"
  | "replied"
  | "bounced"
  | "unsubscribed"
  | "invalid";

export interface Lead extends BaseRow {
  list_id: ID | null;
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  title: string;
  website: string;
  linkedin: string;
  phone: string;
  location: string;
  industry: string;
  employees: string;
  status: LeadStatus;
  used_in_campaign_id: ID | null;
  used_at: string | null;
  enriched: boolean;
  score: number; // 0-100 lead quality score
  tags: string[];
  enrichment: Record<string, unknown>;
  custom: Record<string, unknown>;
}

export interface SetupPlaybook extends BaseRow {
  name: string;
  date: string | null;
  summary: string;
  status: "active" | "archived";
}

export interface SetupStep extends BaseRow {
  setup_id: ID;
  position: number;
  title: string;
  category: string; // Domains, DNS, Email Server, Forwarding, Sites, Gmail, Warmup, Sending Tool
  platform: string; // IONOS, Cloudflare, Netlify, Amazon SES, Gmail, Instantly
  account_used: string;
  details: string;
  links: { label: string; url: string }[];
  done: boolean;
}

export type FieldType = "text" | "number" | "date" | "boolean" | "select";

export interface CustomField extends BaseRow {
  entity: "domains" | "leads";
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  sort: number;
}

// Settings is a single JSON blob stored under one row keyed "app".
export interface AppSettings {
  org_name: string;
  currency: string;
  reminder_window_days: number;
  per_mailbox_daily_limit: number; // safe sends per inbox per day
  emails_per_domain: number; // how many sending mailboxes per domain
  sending_days_per_week: number; // how many days/week you actually send
  warmup_ramp_per_day: number; // increment during warmup
  warmup_target: number; // target per inbox after warmup
  default_sends_per_lead: number; // steps in a sequence per lead
  ai_enabled: boolean;
  accent: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  org_name: "Web of Picasso",
  currency: "USD",
  reminder_window_days: 30,
  per_mailbox_daily_limit: 30,
  emails_per_domain: 2,
  sending_days_per_week: 5,
  warmup_ramp_per_day: 5,
  warmup_target: 40,
  default_sends_per_lead: 3,
  ai_enabled: true,
  accent: "#FF90E8",
};

// Table name constants — single source of truth.
export const TABLES = {
  campaigns: "campaigns",
  domains: "domains",
  capacity: "capacity_sources",
  costs: "cost_items",
  leadLists: "lead_lists",
  leads: "leads",
  setups: "setups",
  setupSteps: "setup_steps",
  customFields: "custom_fields",
  settings: "app_settings",
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];
