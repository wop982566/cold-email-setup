-- ===========================================================================
-- Cold Email Command Center — schema
-- IDs are TEXT (app-generated UUID-ish strings) so the browser and DB agree.
-- The app runs with the public anon key and NO login, so RLS is enabled with
-- permissive policies. If you later add auth, tighten these policies.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- Auto-update updated_at on row changes -------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Campaigns ------------------------------------------------------------------
create table if not exists campaigns (
  id          text primary key default gen_random_uuid()::text,
  name        text not null,
  type        text default '',
  description text default '',
  color       text default '#FF90E8',
  status      text default 'active',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Domains --------------------------------------------------------------------
create table if not exists domains (
  id                     text primary key default gen_random_uuid()::text,
  position               int default 0,
  domain_name            text not null,
  email_1                text default '',
  email_2                text default '',
  expiry_date            date,
  expiry_source          text default 'manual',
  expiry_checked_at      timestamptz,
  domain_provider        text default '',
  mailing_server         text default '',
  mailing_status         text default '',
  dns_provider           text default '',
  dns_status             text default '',
  email_forward          text default '',
  hosting_provider       text default '',
  hosting_account        text default '',
  website_note           text default '',
  emails_forwarded_to    text default '',
  campaign_id            text references campaigns(id) on delete set null,
  campaign_label         text default '',
  gravatar               text default '',
  gmail_send_configured  text default '',
  connected_to_instantly text default '',
  warmup_started         text default '',
  mailbox_daily_limit    numeric,
  renewal_cost           numeric default 0,
  notes                  text default '',
  custom                 jsonb default '{}'::jsonb,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

-- Capacity sources (SES, Instantly, …) --------------------------------------
create table if not exists capacity_sources (
  id           text primary key default gen_random_uuid()::text,
  name         text not null,
  kind         text default 'sending',
  limit_amount numeric default 0,
  limit_period text default 'day',
  used_amount  numeric default 0,
  color        text default '#FF90E8',
  notes        text default '',
  enabled      boolean default true,
  sort         int default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- Cost items -----------------------------------------------------------------
create table if not exists cost_items (
  id            text primary key default gen_random_uuid()::text,
  name          text not null,
  category      text default 'Other',
  provider      text default '',
  amount        numeric default 0,
  currency      text default 'USD',
  billing_cycle text default 'monthly',
  quantity      numeric default 1,
  renews_on     date,
  notes         text default '',
  active        boolean default true,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- Lead lists (with sub-lists via parent_id) ----------------------------------
create table if not exists lead_lists (
  id          text primary key default gen_random_uuid()::text,
  name        text not null,
  parent_id   text references lead_lists(id) on delete set null,
  description text default '',
  color       text default '#FF90E8',
  source      text default '',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Leads ----------------------------------------------------------------------
create table if not exists leads (
  id                  text primary key default gen_random_uuid()::text,
  list_id             text references lead_lists(id) on delete set null,
  email               text default '',
  first_name          text default '',
  last_name           text default '',
  company             text default '',
  title               text default '',
  website             text default '',
  linkedin            text default '',
  phone               text default '',
  location            text default '',
  industry            text default '',
  employees           text default '',
  status              text default 'new',
  used_in_campaign_id text references campaigns(id) on delete set null,
  used_at             timestamptz,
  enriched            boolean default false,
  score               numeric default 50,
  tags                jsonb default '[]'::jsonb,
  enrichment          jsonb default '{}'::jsonb,
  custom              jsonb default '{}'::jsonb,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
create index if not exists leads_list_idx on leads(list_id);
create index if not exists leads_email_idx on leads(lower(email));
create index if not exists leads_status_idx on leads(status);

-- Setup playbooks ------------------------------------------------------------
create table if not exists setups (
  id         text primary key default gen_random_uuid()::text,
  name       text not null,
  date       date,
  summary    text default '',
  status     text default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists setup_steps (
  id           text primary key default gen_random_uuid()::text,
  setup_id     text references setups(id) on delete cascade,
  position     int default 0,
  title        text not null,
  category     text default 'Other',
  platform     text default '',
  account_used text default '',
  details      text default '',
  links        jsonb default '[]'::jsonb,
  done         boolean default false,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index if not exists setup_steps_setup_idx on setup_steps(setup_id);

-- Custom field definitions ---------------------------------------------------
create table if not exists custom_fields (
  id         text primary key default gen_random_uuid()::text,
  entity     text not null,
  key        text not null,
  label      text not null,
  type       text default 'text',
  options    jsonb default '[]'::jsonb,
  sort       int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- App settings (single row id='app') ----------------------------------------
create table if not exists app_settings (
  id         text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- updated_at triggers --------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'campaigns','domains','capacity_sources','cost_items','lead_lists',
    'leads','setups','setup_steps','custom_fields','app_settings'
  ]
  loop
    execute format('drop trigger if exists set_updated_at on %I;', t);
    execute format(
      'create trigger set_updated_at before update on %I for each row execute function set_updated_at();',
      t
    );
  end loop;
end $$;

-- Row Level Security ---------------------------------------------------------
-- Open access (no login). Anyone with the anon key can read/write. If you add
-- Supabase Auth later, replace these with auth.uid()-scoped policies.
do $$
declare t text;
begin
  foreach t in array array[
    'campaigns','domains','capacity_sources','cost_items','lead_lists',
    'leads','setups','setup_steps','custom_fields','app_settings'
  ]
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists anon_all on %I;', t);
    execute format(
      'create policy anon_all on %I for all to anon, authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;
