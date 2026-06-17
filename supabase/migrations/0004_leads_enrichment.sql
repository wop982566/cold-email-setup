-- ===========================================================================
-- Lead enrichment fields: category, relevance, and the "Discarded" bucket.
-- Idempotent; safe to run on an existing project.
-- ===========================================================================

alter table leads add column if not exists category     text default '';
alter table leads add column if not exists relevance    text default '';
alter table leads add column if not exists discarded     boolean default false;
alter table leads add column if not exists discarded_at  timestamptz;

create index if not exists leads_discarded_idx on leads(discarded);
create index if not exists leads_category_idx on leads(category);
