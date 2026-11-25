-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query)
create extension if not exists "pgcrypto";

create table if not exists public.subjects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text default '',
  color       text default '#6366f1',
  created_at  timestamptz not null default now()
);

create table if not exists public.lectures (
  id               uuid primary key default gen_random_uuid(),
  subject_id       uuid references public.subjects(id) on delete cascade,
  title            text not null default 'Untitled',
  ppt_text         text default '',
  pyq_text         text default '',
  summaries        jsonb not null default '[]'::jsonb,
  notes            text default '',
  duration_seconds integer default 0,
  created_at       timestamptz not null default now()
);

create index if not exists lectures_subject_id_idx on public.lectures(subject_id);

-- If you use the anon key (not the service_role key) the backend needs access.
-- Simplest for local/dev use: disable RLS on these two tables.
alter table public.subjects disable row level security;
alter table public.lectures disable row level security;
