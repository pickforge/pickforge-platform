create schema if not exists welcome_credits_private;

revoke all on schema welcome_credits_private from public, anon, authenticated, service_role;

create table welcome_credits_private.campaigns (
  campaign_key text primary key,
  enabled boolean not null default true,
  issued_count integer not null default 0,
  check (issued_count between 0 and 50)
);

alter table welcome_credits_private.campaigns enable row level security;

revoke all on table welcome_credits_private.campaigns from public, anon, authenticated, service_role;

insert into welcome_credits_private.campaigns (campaign_key)
values ('launch_welcome_first_50');

create function welcome_credits_private.grant_launch_welcome_credit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  granted_id uuid;
begin
  perform 1
  from welcome_credits_private.campaigns
  where campaign_key = 'launch_welcome_first_50'
    and enabled
    and issued_count < 50
  for update;

  if not found then
    return new;
  end if;

  insert into public.credit_ledger (
    user_id,
    amount_cents,
    kind,
    description,
    idempotency_key,
    metadata
  )
  values (
    new.id,
    100,
    'grant',
    'Launch welcome credit',
    'welcome:first-50:v1',
    jsonb_build_object('campaign', 'launch_welcome_first_50')
  )
  on conflict (user_id, idempotency_key) do nothing
  returning id into granted_id;

  if granted_id is not null then
    update welcome_credits_private.campaigns
    set issued_count = issued_count + 1
    where campaign_key = 'launch_welcome_first_50';
  end if;

  return new;
end;
$$;

revoke execute on function welcome_credits_private.grant_launch_welcome_credit() from public, anon, authenticated, service_role;

create trigger grant_launch_welcome_credit_on_auth_user_created
  after insert on auth.users
  for each row
  when (coalesce(new.is_anonymous, false) = false)
  execute function welcome_credits_private.grant_launch_welcome_credit();
