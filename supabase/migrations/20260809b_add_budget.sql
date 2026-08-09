-- Run this in the Supabase SQL editor (Project > SQL Editor > New query).
-- Adds a single-row `budget` table holding one recurring monthly budget
-- amount (applies to every month until the user changes it — there's no
-- per-month history, matching the simple "one number, editable in
-- settings" model this app uses elsewhere). The `id boolean` + check
-- constraint is a standard singleton-table trick: id can only ever be
-- `true`, so a second row is impossible and the app can always fetch/update
-- "the" row without needing to know its id.

create table if not exists public.budget (
  id boolean primary key default true,
  monthly_budget_cents integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint budget_singleton check (id)
);

insert into public.budget (id, monthly_budget_cents) values (true, 0)
on conflict (id) do nothing;
