begin;

select plan(5);

-- The covering index exists on the ledger.
select ok(
  (
    select count(*)::integer
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'credit_ledger'
      and indexname = 'credit_ledger_user_id_amount_cents_idx'
  ) = 1,
  'the balance covering index is present on credit_ledger'
);

-- It is keyed on user_id and carries amount_cents as an INCLUDE payload column.
select ok(
  (
    select pg_get_indexdef(oid)
    from pg_class
    where relname = 'credit_ledger_user_id_amount_cents_idx'
  ) like '%(user_id) INCLUDE (amount_cents)%',
  'the covering index is keyed on user_id with amount_cents as an INCLUDE column'
);

-- The additive index does not displace the pre-existing lookup index.
select ok(
  (
    select count(*)::integer
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'credit_ledger'
      and indexname = 'credit_ledger_user_id_created_at_idx'
  ) = 1,
  'the original user_id/created_at index still exists'
);

-- The balance function remains a stable aggregate.
select is(
  (select provolatile from pg_proc where proname = 'credit_balance_cents'),
  's',
  'credit_balance_cents remains a stable function'
);

-- The balance function sums amount_cents correctly through the new index.
-- An anonymous user is used so the welcome-credit grant trigger does not fire.
insert into auth.users (
  id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000201',
  'authenticated', 'authenticated',
  '{}'::jsonb, '{}'::jsonb, true, now(), now()
);

insert into public.credit_ledger (user_id, amount_cents, kind, description)
values
  ('00000000-0000-0000-0000-000000000201', 1000, 'purchase', 'seed purchase'),
  ('00000000-0000-0000-0000-000000000201', -2, 'usage', 'router call'),
  ('00000000-0000-0000-0000-000000000201', -3, 'usage', 'router call');

select is(
  public.credit_balance_cents('00000000-0000-0000-0000-000000000201'),
  995,
  'the balance function sums amount_cents correctly with the covering index'
);

select * from finish();

rollback;
