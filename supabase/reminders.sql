-- Household Helper: daily phone reminders. Already applied to the household-helper project.
-- Kept here as a record. The secret values are NOT stored in this file.

create table public.push_subs (
  endpoint text primary key check (char_length(endpoint) < 1000),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  p256dh text not null check (char_length(p256dh) < 200),
  auth text not null check (char_length(auth) < 100),
  person_id text check (char_length(person_id) < 100),
  remind_at text not null default '16:00' check (remind_at ~ '^[0-2][0-9]:[0-5][0-9]$'),
  tz text not null default 'Australia/Perth' check (char_length(tz) < 64),
  prefs jsonb not null default '{"cook":true,"chores":true,"pantry":true,"lunch":true}',
  last_sent date,
  created_at timestamptz not null default now()
);
create index push_subs_user_idx on public.push_subs(user_id);
alter table public.push_subs enable row level security;
create policy "own phones read" on public.push_subs for select to authenticated using (user_id = (select auth.uid()));
create policy "own phones add" on public.push_subs for insert to authenticated with check (user_id = (select auth.uid()) and household_id = (select public.my_household()));
create policy "own phones change" on public.push_subs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and household_id = (select public.my_household()));
create policy "own phones remove" on public.push_subs for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.push_subs from anon;
grant select, insert, update, delete on public.push_subs to authenticated;

-- Server-only settings (no policies, so only the service role can read them):
-- vapid_public, vapid_private (Web Push keys) and cron_secret (shared with the timer)
create table public.app_secrets (name text primary key, value text not null);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Every 15 minutes, call the send-reminders Edge Function (supabase/functions/send-reminders)
-- select cron.schedule('household-helper-reminders', '*/15 * * * *', $$
--   select net.http_post(url := 'https://vfmsgeuxugojifzmpaaa.supabase.co/functions/v1/send-reminders',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<cron_secret>'),
--     body := '{}'::jsonb, timeout_milliseconds := 20000) $$);
