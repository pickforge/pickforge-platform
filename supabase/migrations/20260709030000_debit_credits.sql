alter table public.credit_ledger
  add column if not exists idempotency_key text;

alter table public.credit_ledger
  drop constraint if exists credit_ledger_idempotency_key_key;

create unique index if not exists credit_ledger_user_id_idempotency_key_idx
  on public.credit_ledger(user_id, idempotency_key);

create or replace function public.debit_credits(
  target_user uuid,
  debit_cents integer,
  reason text,
  idem_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_balance integer;
  next_balance integer;
begin
  if debit_cents is null or debit_cents <= 0 then
    raise exception 'debit_cents must be a positive integer'
      using errcode = '22023';
  end if;

  if idem_key is null or btrim(idem_key) = '' then
    raise exception 'idem_key must be a non-empty string'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_user::text));

  if exists (
    select 1
    from public.credit_ledger
    where user_id = target_user
      and idempotency_key = idem_key
  ) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  select coalesce(sum(amount_cents), 0)::integer
  into current_balance
  from public.credit_ledger
  where user_id = target_user;

  if current_balance < debit_cents then
    return jsonb_build_object('status', 'insufficient', 'balance', current_balance);
  end if;

  next_balance := current_balance - debit_cents;

  begin
    insert into public.credit_ledger (
      user_id,
      amount_cents,
      kind,
      description,
      idempotency_key
    )
    values (
      target_user,
      -debit_cents,
      'usage',
      reason,
      idem_key
    );
  exception
    when unique_violation then
      return jsonb_build_object('status', 'duplicate');
  end;

  return jsonb_build_object('status', 'ok', 'balance', next_balance);
end;
$$;

revoke execute on function public.debit_credits(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.debit_credits(uuid, integer, text, text) to service_role;
