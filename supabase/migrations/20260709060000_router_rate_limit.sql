create table if not exists public.router_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0)
);

alter table public.router_rate_limits enable row level security;

create function public.consume_router_rate_limit(target_user uuid)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_window timestamptz;
  current_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(target_user::text));

  select window_started_at, request_count
  into current_window, current_count
  from public.router_rate_limits
  where user_id = target_user;

  if not found then
    insert into public.router_rate_limits (user_id, window_started_at, request_count)
    values (target_user, now(), 1);
    return true;
  end if;

  if current_window <= now() - interval '10 seconds' then
    update public.router_rate_limits
    set window_started_at = now(), request_count = 1
    where user_id = target_user;
    return true;
  end if;

  if current_count >= 10 then
    return false;
  end if;

  update public.router_rate_limits
  set request_count = request_count + 1
  where user_id = target_user;
  return true;
end;
$$;

revoke execute on function public.consume_router_rate_limit(uuid) from public, anon, authenticated;
grant execute on function public.consume_router_rate_limit(uuid) to service_role;
