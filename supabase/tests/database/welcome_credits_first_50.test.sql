begin;

select plan(23);

select is(
  (
    select enabled
    from welcome_credits_private.campaigns
    where campaign_key = 'launch_welcome_first_50'
  ),
  true,
  'the campaign starts enabled'
);

select is(
  (
    select issued_count
    from welcome_credits_private.campaigns
    where campaign_key = 'launch_welcome_first_50'
  ),
  0,
  'the campaign starts with no issued credits'
);

select ok(
  not has_schema_privilege('anon', 'welcome_credits_private', 'usage'),
  'anon cannot access the private campaign schema'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'welcome_credits_private.grant_launch_welcome_credit()',
    'execute'
  ),
  'authenticated users cannot execute the grant function'
);

select ok(
  not has_schema_privilege('authenticated', 'welcome_credits_private', 'usage'),
  'authenticated users cannot access the campaign schema'
);

select ok(
  not has_schema_privilege('service_role', 'welcome_credits_private', 'usage'),
  'service role cannot access the campaign schema'
);

select ok(
  not has_table_privilege('anon', 'welcome_credits_private.campaigns', 'select'),
  'anon cannot read campaign state'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'welcome_credits_private.campaigns',
    'select'
  ),
  'authenticated users cannot read campaign state'
);

select ok(
  not has_table_privilege(
    'service_role',
    'welcome_credits_private.campaigns',
    'select'
  ),
  'service role cannot read campaign state'
);

select ok(
  not has_function_privilege(
    'anon',
    'welcome_credits_private.grant_launch_welcome_credit()',
    'execute'
  ),
  'anon cannot execute the grant function'
);

select ok(
  not has_function_privilege(
    'service_role',
    'welcome_credits_private.grant_launch_welcome_credit()',
    'execute'
  ),
  'service role cannot execute the grant function'
);

select is(
  (
    select relrowsecurity
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'welcome_credits_private'
      and pg_class.relname = 'campaigns'
  ),
  true,
  'campaign state has row level security enabled'
);

update welcome_credits_private.campaigns
set enabled = false,
    issued_count = 0
where campaign_key = 'launch_welcome_first_50';

insert into auth.users (
  id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000101',
  'authenticated',
  'authenticated',
  'welcome-disabled@example.invalid',
  '{}'::jsonb,
  '{}'::jsonb,
  false,
  now(),
  now()
);

select is(
  (
    select count(*)::integer
    from public.credit_ledger
    where user_id = '00000000-0000-0000-0000-000000000101'
  ),
  0,
  'the kill switch prevents a grant'
);

update welcome_credits_private.campaigns
set enabled = true
where campaign_key = 'launch_welcome_first_50';

insert into auth.users (
  id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000102',
  'authenticated',
  'authenticated',
  'welcome-eligible@example.invalid',
  '{}'::jsonb,
  '{}'::jsonb,
  false,
  now(),
  now()
);

select is(
  (
    select amount_cents
    from public.credit_ledger
    where user_id = '00000000-0000-0000-0000-000000000102'
  ),
  100,
  'an eligible account receives exactly one dollar'
);

select is(
  (
    select kind
    from public.credit_ledger
    where user_id = '00000000-0000-0000-0000-000000000102'
  ),
  'grant',
  'the welcome credit is recorded as a grant'
);

select is(
  (
    select idempotency_key
    from public.credit_ledger
    where user_id = '00000000-0000-0000-0000-000000000102'
  ),
  'welcome:first-50:v1',
  'the grant uses the fixed campaign idempotency key'
);

select is(
  public.credit_balance_cents('00000000-0000-0000-0000-000000000102'),
  100,
  'the existing balance function includes the grant'
);

insert into auth.users (
  id,
  aud,
  role,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000103',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb,
  true,
  now(),
  now()
);

select is(
  (
    select count(*)::integer
    from public.credit_ledger
    where user_id = '00000000-0000-0000-0000-000000000103'
  ),
  0,
  'anonymous users are ineligible'
);

update auth.users
set raw_user_meta_data = '{"name":"Updated"}'::jsonb
where id = '00000000-0000-0000-0000-000000000102';

select is(
  (
    select count(*)::integer
    from public.credit_ledger
    where user_id = '00000000-0000-0000-0000-000000000102'
  ),
  1,
  'profile updates do not replay the insert-only grant trigger'
);

delete from auth.users
where id = '00000000-0000-0000-0000-000000000102';

select is(
  (
    select issued_count
    from welcome_credits_private.campaigns
    where campaign_key = 'launch_welcome_first_50'
  ),
  1,
  'account deletion does not reopen a lifetime campaign slot'
);

alter table public.credit_ledger
  add constraint welcome_test_block_grant check (kind <> 'grant');

create temporary table welcome_test_failures (
  observed boolean not null
);

do $$
begin
  begin
    insert into auth.users (
      id,
      aud,
      role,
      email,
      raw_app_meta_data,
      raw_user_meta_data,
      is_anonymous,
      created_at,
      updated_at
    )
    values (
      '00000000-0000-0000-0000-000000000104',
      'authenticated',
      'authenticated',
      'welcome-failure@example.invalid',
      '{}'::jsonb,
      '{}'::jsonb,
      false,
      now(),
      now()
    );
  exception
    when check_violation then
      insert into welcome_test_failures values (true);
  end;
end;
$$;

select is(
  (select count(*)::integer from welcome_test_failures),
  1,
  'a ledger failure aborts account creation'
);

select is(
  (
    select count(*)::integer
    from auth.users
    where id = '00000000-0000-0000-0000-000000000104'
  ),
  0,
  'a failed grant leaves no auth user behind'
);

select is(
  (
    select issued_count
    from welcome_credits_private.campaigns
    where campaign_key = 'launch_welcome_first_50'
  ),
  1,
  'a failed grant does not consume a campaign slot'
);

select * from finish();

rollback;
