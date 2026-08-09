-- Run this in the Supabase SQL editor (Project > SQL Editor > New query).
-- Adds a `card_source` text column on transactions ('chase' | 'amex' | null)
-- for payments captured live via the Google Wallet notification listener.
-- This is separate from the existing `source` column, which is a
-- notification-vs-manual discriminator used by orphan-matching logic
-- elsewhere in the app (see getPaymentsForPeriod in src/supabase.ts) — that
-- meaning must not change, so the card issuer gets its own column instead.
-- Statement imports already track chase/amex/csv via
-- statement_transactions.source (see 20260724_add_statement_transactions.sql)
-- and are unaffected by this migration.

alter table public.transactions add column if not exists card_source text;
