-- Cashflow bot: spend log. The math is not stored. The engine replays it from these rows each time.

create table public.entries (
  id          bigserial primary key,
  source_key  text not null unique,        -- Slack message ts, or "cmd:<trigger_id>" for /spent
  channel     text not null,
  user_id     text not null,
  spent_on    date not null,               -- WIB calendar date
  amount      bigint not null,             -- IDR, may be negative (refund)
  note        text not null default '',
  bill        boolean not null default false,
  reply_ts    text,                        -- the bot's reply, edited on correction
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index entries_spent_on_idx on public.entries (spent_on) where deleted_at is null;

-- Each cron job runs once per WIB day, even if it fires twice.
create table public.job_runs (
  kind    text not null,
  run_on  date not null,
  primary key (kind, run_on)
);

-- Only the Edge Function (service role) touches these tables. No policies = no access for anon keys.
alter table public.entries enable row level security;
alter table public.job_runs enable row level security;

-- Cron: 20:00 WIB reminder (13:00 UTC), and the Sunday close at 00:05 WIB Monday (17:05 UTC Sunday).
-- Needs 2 Vault secrets: project_url and cron_secret (see README).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('cashflow-reminder', '0 13 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/slack?job=reminder',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb)
$$);

select cron.schedule('cashflow-close', '5 17 * * 0', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/slack?job=close',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb)
$$);
