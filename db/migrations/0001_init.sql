-- Barnacle schema. Run in the Supabase SQL editor (or `supabase db push`).
-- The bot uses the service-role key, which bypasses RLS; RLS is enabled with
-- no policies so the anon/public keys can't read anything.

create extension if not exists pgcrypto;

create table if not exists users (
  discord_id          text primary key,
  username            text not null,
  first_seen          timestamptz not null default now(),
  last_seen           timestamptz not null default now(),
  last_interacted_at  timestamptz,           -- last time they addressed the bot
  dm_open             boolean not null default true,
  opted_out           boolean not null default false
);

create table if not exists memories (
  id                  uuid primary key default gen_random_uuid(),
  user_id             text not null references users(discord_id) on delete cascade,
  kind                text not null check (kind in ('fact','preference','event','relationship')),
  content             text not null,
  importance          int  not null default 2 check (importance between 1 and 5),
  created_at          timestamptz not null default now(),
  last_referenced_at  timestamptz,
  condensed           boolean not null default false,
  condensed_at        timestamptz
);
create index if not exists memories_user_live_idx on memories (user_id, condensed, created_at desc);

create table if not exists memory_summaries (
  user_id     text primary key references users(discord_id) on delete cascade,
  summary     text not null,
  updated_at  timestamptz not null default now()
);

create table if not exists outreach (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null references users(discord_id) on delete cascade,
  sent_at     timestamptz not null default now(),
  status      text not null default 'pending' check (status in ('pending','replied','ignored')),
  replied_at  timestamptz,
  content     text
);
create index if not exists outreach_user_idx on outreach (user_id, sent_at desc);
create index if not exists outreach_pending_idx on outreach (status, sent_at) where status = 'pending';

create table if not exists outreach_state (
  user_id              text primary key references users(discord_id) on delete cascade,
  consecutive_ignored  int not null default 0,
  next_eligible_at     timestamptz,
  paused               boolean not null default false
);

create table if not exists llm_usage (
  day       date primary key,
  requests  int not null default 0,
  tokens    int not null default 0
);

alter table users            enable row level security;
alter table memories         enable row level security;
alter table memory_summaries enable row level security;
alter table outreach         enable row level security;
alter table outreach_state   enable row level security;
alter table llm_usage        enable row level security;
