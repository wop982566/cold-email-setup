-- ===========================================================================
-- Email sequences (AI-generated cold-email campaigns) + their emails.
-- Depends on 0001_init.sql (set_updated_at function, campaigns table).
-- ===========================================================================

create table if not exists sequences (
  id           text primary key default gen_random_uuid()::text,
  name         text not null,
  platform     text default 'instantly',
  campaign_id  text references campaigns(id) on delete set null,
  status       text default 'draft',
  brief        jsonb default '{}'::jsonb,
  performance  jsonb default '{}'::jsonb,
  generated_by text default 'manual',
  model        text default '',
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create table if not exists sequence_emails (
  id               text primary key default gen_random_uuid()::text,
  sequence_id      text references sequences(id) on delete cascade,
  position         int default 0,
  day              int default 0,
  send_time        text default '10:00',
  subject          text default '',
  subject_variants jsonb default '[]'::jsonb,
  body             text default '',
  angle            text default '',
  goal             text default '',
  word_count       int default 0,
  notes            text default '',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists sequence_emails_seq_idx on sequence_emails(sequence_id);

-- updated_at triggers + open RLS policies (matches 0001_init.sql) --------------
do $$
declare t text;
begin
  foreach t in array array['sequences','sequence_emails']
  loop
    execute format('drop trigger if exists set_updated_at on %I;', t);
    execute format(
      'create trigger set_updated_at before update on %I for each row execute function set_updated_at();',
      t
    );
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists anon_all on %I;', t);
    execute format(
      'create policy anon_all on %I for all to anon, authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;
