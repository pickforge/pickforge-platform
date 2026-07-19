-- Additive-only migration (per #35): no renumbering, no destructive change.
--
-- Both public.credit_balance_cents() and public.debit_credits() derive a balance
-- from sum(amount_cents) over every ledger row of a user, and the operator router
-- computes it twice per request (getCreditBalance + debit). The ledger grows one
-- row per ~2c call, so the scan cost per request grows without bound.
--
-- The existing credit_ledger_user_id_created_at_idx (user_id, created_at desc)
-- can locate a user's rows but does not carry amount_cents, so the aggregate must
-- fetch every matching heap tuple. This covering index carries amount_cents in the
-- index payload, letting the balance sum run as an index-only scan for the user's
-- range without touching the heap.
--
-- A cached/running balance (trigger-maintained aggregate row) is intentionally
-- deferred, not attempted here: it would alter the ledger write path and requires
-- its own concurrency correctness proof (interaction with the per-user advisory
-- lock in debit_credits and with purchase/grant/refund inserts). The covering
-- index is the safe additive minimum this policy allows.
create index if not exists credit_ledger_user_id_amount_cents_idx
  on public.credit_ledger (user_id) include (amount_cents);
