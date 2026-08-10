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
  category: string; // AI/rule assigned category (e.g. "Marketing agency")
  relevance: "relevant" | "review" | "unrelated" | "";
  discarded: boolean; // hidden from normal views until restored
  discarded_at: string | null;
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

// --- Email sequences / campaigns ------------------------------------------
export type SequencePlatform =
  | "instantly"
  | "smartlead"
  | "apollo"
  | "lemlist"
  | "gmail"
  | "manual";

export type SequenceStatus = "draft" | "live" | "paused" | "won" | "archived";

export type PersonalizationLevel = "hyper" | "account" | "segment" | "volume";

export interface SequenceBrief {
  audience: string; // ICP: role, company type, size
  sender_name: string;
  sender_role: string;
  offer: string; // what you solve / value prop
  proof: string; // case study / result / credibility
  signal: string; // trigger / research signal (optional)
  industry: string;
  angle: string; // save time, reduce risk, growth, deliverability…
  personalization: PersonalizationLevel;
  tone: string; // peer/casual, professional, technical, C-suite brief
  sequence_type: string; // classic7 | fast5 | nurture | custom
  email_count: number;
  length_pref: string; // ultra-short | short | medium
  cta_style: string; // interest | soft | direct
  use_spintax: boolean;
  notes: string; // extra instructions
}

export interface SequencePerformance {
  sent: number;
  opens: number;
  replies: number;
  positive_replies: number;
  meetings: number;
  rating: number; // 0-5 stars
  is_winner: boolean;
  notes: string;
}

export interface Sequence extends BaseRow {
  name: string;
  platform: SequencePlatform;
  campaign_id: ID | null;
  status: SequenceStatus;
  brief: SequenceBrief;
  performance: SequencePerformance;
  generated_by: "ai" | "manual";
  model: string;
}

export interface SequenceEmail extends BaseRow {
  sequence_id: ID;
  position: number; // step number, 1-based
  day: number; // send-day offset from start
  send_time: string; // e.g. "10:00"
  subject: string;
  subject_variants: string[];
  body: string; // may contain spintax + platform variables
  angle: string;
  goal: string;
  word_count: number;
  notes: string;
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
  // --- Campaign planner ----------------------------------------------------
  excluded_mailboxes: string[]; // lowercased emails ignored by the planner + sending health
  // How many inboxes you're ACTUALLY running campaigns from. 0 = use every
  // connected mailbox. When set, the planner keeps the N most clearly in-use
  // mailboxes (campaign-attached first) and ignores the rest.
  planner_active_inbox_count: number;
  campaign_group_overrides: Record<string, string>; // instantly campaign id -> group key
  planner_goal_kind: "emails" | "leads";
  planner_goal_value: number;
  // --- Campaign maintenance ------------------------------------------------
  maintenance_min_warmup_score: number; // below this, a mature mailbox needs replacing
  maintenance_critical_score: number; // below this, pull it now
  maintenance_new_mailbox_days: number; // younger than this, a low score is just warmup
  maintenance_min_inbox_rate: number; // inbox-vs-spam placement floor
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
  excluded_mailboxes: [],
  planner_active_inbox_count: 0,
  campaign_group_overrides: {},
  planner_goal_kind: "emails",
  planner_goal_value: 500,
  maintenance_min_warmup_score: 80,
  maintenance_critical_score: 50,
  maintenance_new_mailbox_days: 21,
  maintenance_min_inbox_rate: 80,
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
  sequences: "sequences",
  sequenceEmails: "sequence_emails",
  settings: "app_settings",
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];
