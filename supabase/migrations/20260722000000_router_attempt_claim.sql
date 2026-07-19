-- Issue #37 (CAND-4): operator-router's idempotency only became durable
-- AFTER provider work. The handler checked `credit_ledger` for a completed
-- route, invoked the OpenAI-compatible provider, and only then wrote a
-- debit row keyed by the idempotency key. Two concurrent requests for the
-- same key could both find nothing completed, both call the provider, and
-- the losing response was simply discarded after the winner's debit landed
-- — wasted provider spend with no compensating record.
--
-- `router_attempts` and its three RPCs move the durable decision in front of
-- the provider call: `router_attempt_claim` durably claims the (user_id,
-- idempotency_key) attempt before any provider invocation happens, so at
-- most one caller ever owns "go call the provider" for a given key at a
-- time. `router_attempt_complete` records the provider outcome once it is
-- known (independent of whether the following debit succeeds), and
-- `router_attempt_fail` releases a claim immediately after a definitive
-- provider failure so a retry does not have to wait out the lease.
--
-- A claim that is neither completed nor explicitly failed (e.g. the edge
-- function crashed mid-flight) is recoverable once its lease
-- (`lease_seconds`, caller-supplied) has elapsed — a stale claim is exactly
-- the "in-progress recovery" case: nothing else can prove the original
-- attempt is dead, so a bounded lease is the only way to make forward
-- progress possible again.
--
-- This is additive only (new table, new functions): existing
-- `credit_ledger` rows written by `debit_credits` before this migration
-- remain the authoritative record for old completed routes, and the
-- application layer (edge-shared) keeps honoring them — this migration does
-- not touch `credit_ledger` or `debit_credits`.
create table public.router_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  status text not null check (status in ('claimed', 'completed', 'failed')),
  proposal_json text,
  usage_input integer,
  usage_output integer,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, idempotency_key),
  constraint router_attempts_completed_has_result check (
    status <> 'completed'
    or (
      proposal_json is not null
      and usage_input is not null
      and usage_output is not null
      and completed_at is not null
    )
  )
);

alter table public.router_attempts enable row level security;

-- Server-only idempotency table: RLS is enabled intentionally with no
-- policies, and no client role gets any direct table privilege at all — the
-- three RPCs below (service_role only) are the only way in.
revoke all on public.router_attempts from anon, authenticated;

-- Durably claims (user_id, idempotency_key) before any provider invocation.
-- Returns one of:
--   {"outcome": "claimed"}    caller now owns provider invocation for this key.
--   {"outcome": "in_progress"} another live claim owns it right now; caller
--                               must not invoke the provider or debit.
--   {"outcome": "completed", "proposal_json": ..., "usage_input": ...,
--    "usage_output": ...}     the provider already ran for this key; caller
--                               should skip straight to the debit step with
--                               the returned result instead of re-invoking
--                               the provider.
create function public.router_attempt_claim(
  target_user uuid,
  idem_key text,
  lease_seconds integer default 30
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_row public.router_attempts%rowtype;
begin
  if idem_key is null or btrim(idem_key) = '' then
    raise exception 'idem_key must be a non-empty string'
      using errcode = '22023';
  end if;

  if lease_seconds is null or lease_seconds <= 0 then
    raise exception 'lease_seconds must be a positive integer'
      using errcode = '22023';
  end if;

  insert into public.router_attempts (user_id, idempotency_key, status, claimed_at)
  values (target_user, idem_key, 'claimed', now())
  on conflict (user_id, idempotency_key) do nothing
  returning * into current_row;

  if found then
    return jsonb_build_object('outcome', 'claimed');
  end if;

  -- Lost the insert race (or a prior attempt already exists): lock the row
  -- and decide what a caller may do with it.
  select *
  into current_row
  from public.router_attempts
  where user_id = target_user
    and idempotency_key = idem_key
  for update;

  if current_row.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'completed',
      'proposal_json', current_row.proposal_json,
      'usage_input', current_row.usage_input,
      'usage_output', current_row.usage_output
    );
  end if;

  if current_row.status = 'failed'
    or current_row.claimed_at <= now() - make_interval(secs => lease_seconds)
  then
    update public.router_attempts
    set status = 'claimed',
        claimed_at = now(),
        proposal_json = null,
        usage_input = null,
        usage_output = null,
        completed_at = null
    where user_id = target_user
      and idempotency_key = idem_key;

    return jsonb_build_object('outcome', 'claimed');
  end if;

  return jsonb_build_object('outcome', 'in_progress');
end;
$$;

-- Records a provider outcome for a claimed attempt. Idempotent: replaying a
-- completion for an already-completed attempt (e.g. a retried caller that
-- still holds a reference to its own claim) returns the stored outcome
-- instead of erroring.
create function public.router_attempt_complete(
  target_user uuid,
  idem_key text,
  new_proposal_json text,
  new_usage_input integer,
  new_usage_output integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_row public.router_attempts%rowtype;
begin
  if new_proposal_json is null or btrim(new_proposal_json) = '' then
    raise exception 'new_proposal_json must be a non-empty string'
      using errcode = '22023';
  end if;

  if new_usage_input is null or new_usage_input < 0 or new_usage_output is null or new_usage_output < 0 then
    raise exception 'new_usage_input and new_usage_output must be non-negative integers'
      using errcode = '22023';
  end if;

  update public.router_attempts
  set status = 'completed',
      proposal_json = new_proposal_json,
      usage_input = new_usage_input,
      usage_output = new_usage_output,
      completed_at = now()
  where user_id = target_user
    and idempotency_key = idem_key
    and status = 'claimed'
  returning * into current_row;

  if found then
    return jsonb_build_object(
      'outcome', 'completed',
      'proposal_json', current_row.proposal_json,
      'usage_input', current_row.usage_input,
      'usage_output', current_row.usage_output
    );
  end if;

  select *
  into current_row
  from public.router_attempts
  where user_id = target_user
    and idempotency_key = idem_key;

  if current_row.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'completed',
      'proposal_json', current_row.proposal_json,
      'usage_input', current_row.usage_input,
      'usage_output', current_row.usage_output
    );
  end if;

  raise exception 'router attempt for user % and key % is not claimed', target_user, idem_key
    using errcode = '55000';
end;
$$;

-- Releases a claim immediately after a definitive provider failure, so a
-- retry does not have to wait out the lease to try again.
create function public.router_attempt_fail(
  target_user uuid,
  idem_key text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.router_attempts
  set status = 'failed'
  where user_id = target_user
    and idempotency_key = idem_key
    and status = 'claimed';
end;
$$;

revoke execute on function public.router_attempt_claim(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.router_attempt_claim(uuid, text, integer) to service_role;

revoke execute on function public.router_attempt_complete(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.router_attempt_complete(uuid, text, text, integer, integer) to service_role;

revoke execute on function public.router_attempt_fail(uuid, text) from public, anon, authenticated;
grant execute on function public.router_attempt_fail(uuid, text) to service_role;
