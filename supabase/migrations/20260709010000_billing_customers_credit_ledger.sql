create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount_cents integer not null check (amount_cents <> 0),
  kind text not null check (kind in ('purchase','usage','grant','refund','adjustment')),
  description text,
  stripe_event_id text unique,
  stripe_checkout_session_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Server-only idempotency table: RLS is enabled intentionally with no policies.
create table if not exists public.stripe_events (
  event_id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);

create index if not exists credit_ledger_user_id_created_at_idx
  on public.credit_ledger(user_id, created_at desc);

create unique index if not exists credit_ledger_purchase_session_idx
  on public.credit_ledger(stripe_checkout_session_id)
  where kind = 'purchase';

alter table public.billing_customers enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.stripe_events enable row level security;

drop policy if exists "billing_customers_select_own" on public.billing_customers;
create policy "billing_customers_select_own"
  on public.billing_customers
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "credit_ledger_select_own" on public.credit_ledger;
create policy "credit_ledger_select_own"
  on public.credit_ledger
  for select
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.credit_balance_cents(target_user uuid)
returns integer
language sql
security invoker
stable
as $$
  select coalesce(sum(amount_cents), 0)::integer
  from public.credit_ledger
  where user_id = target_user;
$$;
