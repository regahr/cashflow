-- One bot thread for each day. Spends are logged as replies in the day's thread.

create table public.day_threads (
  day        date primary key,             -- WIB calendar date
  ts         text not null unique,         -- the bot's parent message ts
  created_at timestamptz not null default now()
);
alter table public.day_threads enable row level security;

-- The Sunday-only close job becomes a daily job at 00:05 WIB (17:05 UTC):
-- it posts the new day's thread, and on Monday it closes last week first.
select cron.unschedule('cashflow-close');

select cron.schedule('cashflow-day', '5 17 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/slack?job=day',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb)
$$);
