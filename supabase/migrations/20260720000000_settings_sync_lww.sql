-- Issue #37 (CAND-3): the settings sync last-writer-wins decision used to
-- cross multiple client/server round trips (a `.update()` guarded by
-- `updated_at < new updated_at`, then, only on a miss, an `.upsert()` with
-- `ignoreDuplicates`, then, only on a further miss, a third read to hand the
-- caller the winning row). That choreography reconstructed a durable
-- concurrency decision from client-driven retries instead of making it one
-- durable operation.
--
-- `settings_sync_lww_write` is that one operation: it locks the
-- (user_id, field_group) row (if any), compares the caller's `updated_at`
-- against it, and performs whichever of insert/update/no-op wins, all inside
-- one function call/transaction. It always returns the row that is now
-- authoritative (the caller's write when it won, the existing row when it
-- didn't), so callers never need a follow-up read to learn the outcome.
--
-- `security invoker` (the default) intentionally keeps this function inside
-- the existing `settings_sync` row-level-security boundary: it does not
-- re-implement per-user isolation, it relies on the same
-- `auth.uid() = user_id` select/insert/update policies the table already
-- enforces for direct client access, exactly like `public.credit_balance_cents`
-- (supabase/migrations/20260709010000_billing_customers_credit_ledger.sql).
create or replace function public.settings_sync_lww_write(
  target_user uuid,
  target_group text,
  new_payload jsonb,
  new_updated_at timestamptz,
  new_deleted_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.settings_sync%rowtype;
begin
  select *
  into current_row
  from public.settings_sync
  where user_id = target_user
    and field_group = target_group
  for update;

  if not found then
    insert into public.settings_sync (user_id, field_group, payload, updated_at, deleted_at)
    values (target_user, target_group, new_payload, new_updated_at, new_deleted_at)
    on conflict (user_id, field_group) do nothing
    returning * into current_row;

    if found then
      return pg_catalog.jsonb_build_object(
        'written', true,
        'user_id', current_row.user_id,
        'field_group', current_row.field_group,
        'payload', current_row.payload,
        'updated_at', current_row.updated_at,
        'deleted_at', current_row.deleted_at
      );
    end if;

    -- Lost the insert race: the winner's row now exists (and is visible,
    -- since the conflicting insert waited for it to commit). Lock it and
    -- fall through to the normal compare-and-decide path below.
    select *
    into current_row
    from public.settings_sync
    where user_id = target_user
      and field_group = target_group
    for update;
  end if;

  if new_updated_at > current_row.updated_at then
    update public.settings_sync
    set payload = new_payload,
        updated_at = new_updated_at,
        deleted_at = new_deleted_at
    where user_id = target_user
      and field_group = target_group
    returning * into current_row;

    return pg_catalog.jsonb_build_object(
      'written', true,
      'user_id', current_row.user_id,
      'field_group', current_row.field_group,
      'payload', current_row.payload,
      'updated_at', current_row.updated_at,
      'deleted_at', current_row.deleted_at
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'written', false,
    'user_id', current_row.user_id,
    'field_group', current_row.field_group,
    'payload', current_row.payload,
    'updated_at', current_row.updated_at,
    'deleted_at', current_row.deleted_at
  );
end;
$$;
