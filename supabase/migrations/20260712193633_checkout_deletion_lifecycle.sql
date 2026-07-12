create schema if not exists checkout_lifecycle_private;

revoke all on schema checkout_lifecycle_private from public, anon, authenticated, service_role;

create table checkout_lifecycle_private.deletion_fences (
  user_id uuid primary key,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz
);

create table checkout_lifecycle_private.checkout_sessions (
  stripe_checkout_session_id text primary key check (length(btrim(stripe_checkout_session_id)) > 0),
  user_id uuid not null,
  state text not null default 'open'
    check (state in ('open', 'expired', 'payment_failed', 'completed', 'refund_pending', 'refunded')),
  stripe_event_id text,
  amount_total_cents integer check (amount_total_cents is null or amount_total_cents > 0),
  stripe_customer_id text,
  stripe_payment_intent_id text,
  stripe_refund_id text,
  refund_error_code text check (refund_error_code is null or refund_error_code in ('failed', 'canceled')),
  refund_error_at timestamptz,
  customer_cleanup_pending boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index checkout_lifecycle_sessions_user_id_idx
  on checkout_lifecycle_private.checkout_sessions(user_id, stripe_checkout_session_id);

alter table checkout_lifecycle_private.deletion_fences enable row level security;
alter table checkout_lifecycle_private.checkout_sessions enable row level security;

revoke all on all tables in schema checkout_lifecycle_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema checkout_lifecycle_private from public, anon, authenticated, service_role;

create or replace function public.checkout_lifecycle_is_deletion_fenced(target_user uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from checkout_lifecycle_private.deletion_fences
    where user_id = target_user
  );
$$;

create or replace function public.checkout_lifecycle_register_session(
  target_user uuid,
  checkout_session_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(target_user::text));

  if exists (
    select 1
    from checkout_lifecycle_private.deletion_fences
    where user_id = target_user
      and finalized_at is not null
  ) then
    return true;
  end if;

  insert into checkout_lifecycle_private.checkout_sessions (
    stripe_checkout_session_id,
    user_id
  )
  values (checkout_session_id, target_user)
  on conflict (stripe_checkout_session_id) do update
    set updated_at = now()
    where checkout_lifecycle_private.checkout_sessions.user_id = excluded.user_id;

  if not found then
    raise integrity_constraint_violation using
      message = 'Checkout Session is already registered to another user';
  end if;

  return exists (
    select 1
    from checkout_lifecycle_private.deletion_fences
    where user_id = target_user
  );
end;
$$;

create or replace function public.checkout_lifecycle_fence_deletion(target_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(target_user::text));

  insert into checkout_lifecycle_private.deletion_fences (user_id)
  values (target_user)
  on conflict (user_id) do update
    set updated_at = now();
end;
$$;

create or replace function public.checkout_lifecycle_list_sessions(
  target_user uuid,
  page_start integer default 0,
  page_size integer default 1000
)
returns table (stripe_checkout_session_id text, state text, stripe_customer_id text)
language sql
security definer
stable
set search_path = ''
as $$
  select
    sessions.stripe_checkout_session_id,
    sessions.state,
    sessions.stripe_customer_id
  from checkout_lifecycle_private.checkout_sessions as sessions
  where sessions.user_id = target_user
  order by sessions.stripe_checkout_session_id
  offset greatest(page_start, 0)
  limit least(greatest(page_size, 1), 1000);
$$;

create or replace function public.checkout_lifecycle_reconcile_completion(
  target_user uuid,
  checkout_session_id text,
  event_id text,
  event_type text,
  amount_total_cents integer,
  stripe_customer_id text,
  stripe_payment_intent_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_user uuid;
  existing_state text;
  existing_cleanup_pending boolean;
  deletion_finalized boolean := false;
  credited_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(target_user::text));

  select sessions.user_id, sessions.state, sessions.customer_cleanup_pending
  into existing_user, existing_state, existing_cleanup_pending
  from checkout_lifecycle_private.checkout_sessions as sessions
  where sessions.stripe_checkout_session_id = checkout_session_id;

  if existing_user is not null and existing_user <> target_user then
    raise integrity_constraint_violation using
      message = 'Checkout Session is already registered to another user';
  end if;

  if existing_state = 'completed' then
    return 'duplicate';
  end if;
  if existing_state = 'refunded' then
    if existing_cleanup_pending then
      return 'refunded_cleanup_pending';
    end if;
    return 'refunded';
  end if;

  if not exists (
    select 1
    from auth.users
    where id = target_user
  ) then
    insert into checkout_lifecycle_private.checkout_sessions (
      stripe_checkout_session_id,
      user_id,
      state,
      stripe_event_id,
      amount_total_cents,
      stripe_customer_id,
      stripe_payment_intent_id,
      customer_cleanup_pending
    )
    values (
      checkout_session_id,
      target_user,
      'refund_pending',
      event_id,
      amount_total_cents,
      stripe_customer_id,
      stripe_payment_intent_id,
      true
    )
    on conflict (stripe_checkout_session_id) do update
      set state = 'refund_pending',
          stripe_event_id = excluded.stripe_event_id,
          amount_total_cents = excluded.amount_total_cents,
          stripe_customer_id = excluded.stripe_customer_id,
          stripe_payment_intent_id = excluded.stripe_payment_intent_id,
          customer_cleanup_pending = true,
          updated_at = now();

    return 'refund_missing_user';
  end if;

  select fences.finalized_at is not null
  into deletion_finalized
  from checkout_lifecycle_private.deletion_fences as fences
  where fences.user_id = target_user;

  if found then
    insert into checkout_lifecycle_private.checkout_sessions (
      stripe_checkout_session_id,
      user_id,
      state,
      stripe_event_id,
      amount_total_cents,
      stripe_customer_id,
      stripe_payment_intent_id,
      customer_cleanup_pending
    )
    values (
      checkout_session_id,
      target_user,
      'refund_pending',
      event_id,
      amount_total_cents,
      stripe_customer_id,
      stripe_payment_intent_id,
      deletion_finalized
    )
    on conflict (stripe_checkout_session_id) do update
      set state = 'refund_pending',
          stripe_event_id = excluded.stripe_event_id,
          amount_total_cents = excluded.amount_total_cents,
          stripe_customer_id = excluded.stripe_customer_id,
          stripe_payment_intent_id = excluded.stripe_payment_intent_id,
          customer_cleanup_pending =
            checkout_lifecycle_private.checkout_sessions.customer_cleanup_pending
            or excluded.customer_cleanup_pending,
          updated_at = now();

    if deletion_finalized then
      update checkout_lifecycle_private.deletion_fences
      set finalized_at = null,
          updated_at = now()
      where user_id = target_user;
      return 'refund_missing_user';
    end if;

    return 'refund';
  end if;

  if stripe_customer_id is not null then
    insert into public.billing_customers (
      user_id,
      stripe_customer_id,
      updated_at
    )
    values (
      target_user,
      stripe_customer_id,
      now()
    )
    on conflict (user_id) do update
      set stripe_customer_id = excluded.stripe_customer_id,
          updated_at = excluded.updated_at;
  end if;

  insert into public.credit_ledger (
    user_id,
    amount_cents,
    kind,
    description,
    stripe_event_id,
    stripe_checkout_session_id,
    idempotency_key,
    metadata
  )
  values (
    target_user,
    amount_total_cents,
    'purchase',
    'Credit purchase',
    event_id,
    checkout_session_id,
    'stripe:' || checkout_session_id,
    pg_catalog.jsonb_build_object(
      'amount_total', amount_total_cents,
      'stripe_customer_id', stripe_customer_id,
      'stripe_checkout_session_id', checkout_session_id,
      'stripe_event_type', event_type,
      'stripe_payment_intent_id', stripe_payment_intent_id
    )
  )
  on conflict do nothing
  returning id into credited_id;

  if credited_id is null and not exists (
    select 1
    from public.credit_ledger
    where user_id = target_user
      and kind = 'purchase'
      and (
        stripe_checkout_session_id = checkout_session_id
        or stripe_event_id = event_id
      )
  ) then
    raise integrity_constraint_violation using
      message = 'Stripe completion conflicts with another ledger entry';
  end if;

  insert into checkout_lifecycle_private.checkout_sessions (
    stripe_checkout_session_id,
    user_id,
    state,
    stripe_event_id,
    amount_total_cents,
    stripe_customer_id,
    stripe_payment_intent_id
  )
  values (
    checkout_session_id,
    target_user,
    'completed',
    event_id,
    amount_total_cents,
    stripe_customer_id,
    stripe_payment_intent_id
  )
  on conflict (stripe_checkout_session_id) do update
    set state = 'completed',
        stripe_event_id = excluded.stripe_event_id,
        amount_total_cents = excluded.amount_total_cents,
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_payment_intent_id = excluded.stripe_payment_intent_id,
        updated_at = now();

  if credited_id is null then
    return 'duplicate';
  end if;
  return 'credited';
end;
$$;

create or replace function public.checkout_lifecycle_mark_refunded(
  checkout_session_id text,
  event_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update checkout_lifecycle_private.checkout_sessions
  set state = 'refunded',
      stripe_event_id = event_id,
      refund_error_code = null,
      refund_error_at = null,
      updated_at = now()
  where stripe_checkout_session_id = checkout_session_id
    and state in ('refund_pending', 'refunded');

  if not found then
    raise no_data_found using message = 'Checkout Session refund is not pending';
  end if;
end;
$$;

create or replace function public.checkout_lifecycle_record_refund_failure(
  checkout_session_id text,
  event_id text,
  refund_id text,
  failure_status text
)
returns void
language sql
security definer
set search_path = ''
as $$
  update checkout_lifecycle_private.checkout_sessions
  set state = 'refund_pending',
      stripe_event_id = event_id,
      stripe_refund_id = refund_id,
      refund_error_code = failure_status,
      refund_error_at = now(),
      updated_at = now()
  where stripe_checkout_session_id = checkout_session_id
    and state = 'refund_pending';
$$;

create or replace function public.checkout_lifecycle_mark_expired(
  checkout_session_id text
)
returns void
language sql
security definer
set search_path = ''
as $$
  update checkout_lifecycle_private.checkout_sessions
  set state = 'expired',
      updated_at = now()
  where stripe_checkout_session_id = checkout_session_id
    and state in ('open', 'expired');
$$;

create or replace function public.checkout_lifecycle_mark_async_payment_failed(
  target_user uuid,
  checkout_session_id text,
  event_id text,
  stripe_customer_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_state text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(target_user::text));

  select state
  into existing_state
  from checkout_lifecycle_private.checkout_sessions
  where stripe_checkout_session_id = checkout_session_id
    and user_id = target_user;

  if existing_state is null then
    return 'missing';
  end if;
  if existing_state <> 'open' then
    return 'duplicate';
  end if;

  update checkout_lifecycle_private.checkout_sessions
  set state = 'payment_failed',
      stripe_event_id = event_id,
      stripe_customer_id = coalesce(
        checkout_lifecycle_mark_async_payment_failed.stripe_customer_id,
        checkout_lifecycle_private.checkout_sessions.stripe_customer_id
      ),
      updated_at = now()
  where stripe_checkout_session_id = checkout_session_id
    and user_id = target_user
    and state = 'open';

  return 'terminalized';
end;
$$;

create or replace function public.checkout_lifecycle_finalize_deletion(target_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  customer_ids jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(target_user::text));

  if not exists (
    select 1
    from checkout_lifecycle_private.deletion_fences
    where user_id = target_user
  ) or exists (
    select 1
    from checkout_lifecycle_private.checkout_sessions
    where user_id = target_user
      and state in ('open', 'refund_pending')
  ) then
    return pg_catalog.jsonb_build_object('status', 'unsafe');
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(distinct sessions.stripe_customer_id)
      filter (where sessions.stripe_customer_id is not null),
    '[]'::jsonb
  )
  into customer_ids
  from checkout_lifecycle_private.checkout_sessions as sessions
  where sessions.user_id = target_user;

  update checkout_lifecycle_private.deletion_fences
  set finalized_at = coalesce(finalized_at, now()),
      updated_at = now()
  where user_id = target_user;

  return pg_catalog.jsonb_build_object(
    'status', 'finalized',
    'customer_ids', customer_ids
  );
end;
$$;

create or replace function public.checkout_lifecycle_get_customer_cleanup(
  checkout_session_id text
)
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'pending', customer_cleanup_pending,
    'customer_id', stripe_customer_id
  )
  from checkout_lifecycle_private.checkout_sessions
  where stripe_checkout_session_id = checkout_session_id
    and state = 'refunded';
$$;

create or replace function public.checkout_lifecycle_complete_customer_cleanup(
  checkout_session_id text
)
returns void
language sql
security definer
set search_path = ''
as $$
  update checkout_lifecycle_private.checkout_sessions
  set customer_cleanup_pending = false,
      updated_at = now()
  where stripe_checkout_session_id = checkout_session_id
    and state = 'refunded';
$$;

revoke all on function public.checkout_lifecycle_is_deletion_fenced(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_register_session(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_fence_deletion(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_list_sessions(uuid, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_reconcile_completion(uuid, text, text, text, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_mark_refunded(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_mark_expired(text)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_record_refund_failure(text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_mark_async_payment_failed(uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_finalize_deletion(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_complete_customer_cleanup(text)
  from public, anon, authenticated, service_role;
revoke all on function public.checkout_lifecycle_get_customer_cleanup(text)
  from public, anon, authenticated, service_role;

grant execute on function public.checkout_lifecycle_is_deletion_fenced(uuid) to service_role;
grant execute on function public.checkout_lifecycle_register_session(uuid, text) to service_role;
grant execute on function public.checkout_lifecycle_fence_deletion(uuid) to service_role;
grant execute on function public.checkout_lifecycle_list_sessions(uuid, integer, integer) to service_role;
grant execute on function public.checkout_lifecycle_reconcile_completion(uuid, text, text, text, integer, text, text) to service_role;
grant execute on function public.checkout_lifecycle_mark_refunded(text, text) to service_role;
grant execute on function public.checkout_lifecycle_mark_expired(text) to service_role;
grant execute on function public.checkout_lifecycle_record_refund_failure(text, text, text, text) to service_role;
grant execute on function public.checkout_lifecycle_mark_async_payment_failed(uuid, text, text, text) to service_role;
grant execute on function public.checkout_lifecycle_finalize_deletion(uuid) to service_role;
grant execute on function public.checkout_lifecycle_complete_customer_cleanup(text) to service_role;
grant execute on function public.checkout_lifecycle_get_customer_cleanup(text) to service_role;
