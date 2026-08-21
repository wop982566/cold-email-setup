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

/**
 * A mailbox's niche, e.g. CBD.
 *
 * Kept per mailbox rather than per domain because a mailbox outlives the batch
 * that made it and may be retagged later, and because the swapper needs to
 * answer "may this address enter this campaign?" for addresses it has no other
 * information about — a swap candidate is attached to no active campaign, so
 * there's no history to infer a niche from.
 */
export interface MailboxTag extends BaseRow {
  email: string;
  tags: string[];
  /** Where it came from, so a hand correction is distinguishable from a bulk one. */
  source: "batch" | "manual" | "instantly";
}

// --- Bulk domain setup -----------------------------------------------------

/** Per-domain deviations from the batch defaults. */
export interface SetupOverride {
  prefixes?: string[];
  /** The three SES DKIM tokens, as pasted. The most expensive field to lose. */
  dkimText?: string;
  netlifySite?: string;
  /** Niche for this domain's mailboxes, e.g. CBD. Gates swap eligibility. */
  tag?: string;
  /** Per-address exceptions, when one mailbox on the domain serves another niche. */
  mailboxTags?: Record<string, string>;
}

/**
 * A bulk domain setup, saved as you work.
 *
 * Everything in the Bulk Setup page used to live in React state, so a refresh
 * discarded it — including the DKIM tokens, which are copied out of AWS one
 * domain at a time.
 *
 * `created_emails` is the other half: it records which mailboxes Instantly
 * confirmed, so an interrupted run resumes instead of re-attempting every
 * address with no idea where it stopped.
 *
 * Stores `profile_id` only. SMTP/IMAP credentials stay in `mail_profiles`,
 * which is gated behind APP_FUNCTION_TOKEN; copying them here would quietly
 * move secrets into a table that isn't.
 */
export interface SetupBatch extends BaseRow {
  name: string;
  status: "draft" | "creating" | "done";
  /** BatchConfig from dnsPlan.ts — typed loosely to avoid a circular import. */
  config: Record<string, unknown>;
  domains_text: string;
  default_prefixes: string[];
  overrides: Record<string, SetupOverride>;
  profile_id: string;
  /** Confirmed created in Instantly. Dry runs and failures never appear here. */
  created_emails: string[];
  create_log: string[];
  last_saved_at: string;
}

/**
 * One run of the daily scheduled swapper. Written by the cron, read-only in
 * the UI — the record of what happened while nobody was watching.
 */
export interface AutoSwapRun extends BaseRow {
  ran_at: string;
  applied: { from: string; to: string; campaigns: string[] }[];
  failed: string[];
  skipped: { email: string; reason: string }[];
  /** Eligible swaps left undone because the per-run cap was hit. */
  deferred: number;
  notification: string;
  log: string[];
}

// --- Test swaps ------------------------------------------------------------
/**
 * A temporary, self-reverting swap the operator runs to prove the automation.
 * The real swap is applied to a live campaign and reverted after `revert_at`;
 * the record survives a page reload so the revert still happens, and the daily
 * cron reverts any that were left `active` past their time as a last resort.
 */
export interface TestSwapRecord extends BaseRow {
  campaignId: string;
  campaignName: string;
  /** The failing mailbox pulled out for the test (restored on revert). */
  swappedOut: string;
  /** The spare swapped in for the test (removed on revert). */
  swappedIn: string;
  started_at: string;
  revert_at: string; // ISO — when the auto-revert is due
  status: "active" | "reverted" | "failed";
}

// --- Mailbox recovery ------------------------------------------------------
// "recovered" and "restored" are deliberately separate: the first releases a
// mailbox back into the spare pool for FUTURE swaps, the second puts it back
// into the campaign it was pulled from. Conflating them would make the archive
// claim swaps were reversed when they weren't.
export type RecoveryStatus = "recovering" | "recovered" | "restored" | "retired";

/**
 * A mailbox pulled out of a live campaign because it was hurting
 * deliverability. Tracked so it isn't immediately proposed as a spare for the
 * next campaign, and so you can see whether warmup is actually repairing it.
 */
export interface RecoveryEntry extends BaseRow {
  email: string;
  swapped_out_at: string; // ISO
  score_at_swap: number | null;
  inbox_rate_at_swap: number | null;
  replaced_by: string; // the address that took over
  campaign_ids: string[]; // where it was pulled from
  campaign_names: string[];
  status: RecoveryStatus;
  released_at: string | null;
  // When the swap was actually reversed in Instantly, and which campaigns took
  // it — a multi-campaign undo can partly fail, and the archive must not imply
  // otherwise.
  restored_at: string | null;
  restored_campaigns: string[];
  reason: string; // what triggered the swap, in the words the UI used
  // Sampled whenever the planner loads, so the trend is real history rather
  // than a single before/after pair.
  history: { at: string; score: number | null; inbox_rate: number | null }[];
}

// --- Mailbox credential profiles -------------------------------------------
/**
 * A reusable SMTP/IMAP combination for creating mailboxes in bulk.
 *
 * Username fields accept {prefix} and {domain} placeholders so one profile
 * covers a whole batch of domains.
 *
 * NOTE: these rows hold live credentials. The /data function refuses to serve
 * the mail_profiles table unless APP_FUNCTION_TOKEN is set.
 */
export interface MailProfile extends BaseRow {
  name: string;
  iam_user_name: string; // the AWS IAM user the SMTP credential came from
  smtp_username: string;
  smtp_password: string;
  smtp_host: string;
  smtp_port: number;
  imap_username: string;
  imap_password: string;
  imap_host: string;
  imap_port: number;
  provider_code: number; // Instantly provider id
  daily_limit: number;
  warmup_limit: number;
  warmup_increment: number;
  warmup_reply_rate: number;
  tracking_domain_prefix: string; // e.g. "inst" -> inst.<domain>
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
  planner_per_campaign_limit: number; // daily cap you set per campaign (growth calc)
  planner_spares_per_niche: number; // healthy spares to keep for each niche
  // --- Campaign maintenance ------------------------------------------------
  maintenance_min_warmup_score: number; // below this, a mature mailbox needs replacing
  maintenance_critical_score: number; // below this, pull it now
  maintenance_new_mailbox_days: number; // younger than this, a low score is just warmup
  maintenance_min_inbox_rate: number; // inbox-vs-spam placement floor
  // --- Automatic swapping (daily scheduled function) -----------------------
  // The env var AUTO_SWAP_ENABLED is the kill switch; these tune it.
  auto_swap_max_per_run: number; // hard ceiling on swaps in one run
  // Consecutive bad daily readings before a mailbox is pulled. 1 acts on the
  // current reading — which is already a trailing window, not a single day.
  auto_swap_min_bad_days: number;
  auto_swap_notify_email: string; // where run summaries go
  auto_swap_from_email: string; // verified Resend sender
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
  planner_per_campaign_limit: 200,
  planner_spares_per_niche: 2,
  maintenance_min_warmup_score: 80,
  maintenance_critical_score: 50,
  maintenance_new_mailbox_days: 21,
  maintenance_min_inbox_rate: 80,
  auto_swap_max_per_run: 2,
  auto_swap_min_bad_days: 1,
  auto_swap_notify_email: "webofpicasso@gmail.com",
  auto_swap_from_email: "info@webofpicasso.net",
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
  recovery: "mailbox_recovery",
  autoSwapRuns: "auto_swap_runs",
  testSwaps: "test_swaps",
  setupBatches: "setup_batches",
  mailboxTags: "mailbox_tags",
  mailProfiles: "mail_profiles",
  settings: "app_settings",
} as const;

/** Tables holding credentials — gated behind APP_FUNCTION_TOKEN server-side. */
export const SECRET_TABLES: readonly string[] = [TABLES.mailProfiles];

export type TableName = (typeof TABLES)[keyof typeof TABLES];
