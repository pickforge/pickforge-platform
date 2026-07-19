begin;

select plan(15);

select ok(
  has_function_privilege(
    'authenticated',
    'public.settings_sync_lww_write(uuid, text, jsonb, timestamptz, timestamptz)',
    'execute'
  ),
  'authenticated can execute the durable LWW write function'
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000301', 'authenticated', 'authenticated',
    'settings-sync-lww-a@example.invalid', '{}'::jsonb, '{}'::jsonb, false, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000302', 'authenticated', 'authenticated',
    'settings-sync-lww-b@example.invalid', '{}'::jsonb, '{}'::jsonb, false, now(), now()
  );

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000301', true);

-- One durable operation both inserts an absent row and reports it as written.
select is(
  public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000301', 'appSettings', '{"theme":"dark"}'::jsonb,
    '2026-07-09T04:00:00.000000Z'::timestamptz, null
  ),
  jsonb_build_object(
    'written', true,
    'user_id', '00000000-0000-0000-0000-000000000301',
    'field_group', 'appSettings',
    'payload', '{"theme":"dark"}'::jsonb,
    'updated_at', '2026-07-09T04:00:00.000000Z'::timestamptz,
    'deleted_at', null
  ),
  'the first write for an absent row is durably inserted and reported written'
);

-- A strictly newer write wins and replaces the row in the same call.
select is(
  public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000301', 'appSettings', '{"theme":"light"}'::jsonb,
    '2026-07-09T04:05:00.000000Z'::timestamptz, null
  ),
  jsonb_build_object(
    'written', true,
    'user_id', '00000000-0000-0000-0000-000000000301',
    'field_group', 'appSettings',
    'payload', '{"theme":"light"}'::jsonb,
    'updated_at', '2026-07-09T04:05:00.000000Z'::timestamptz,
    'deleted_at', null
  ),
  'a strictly newer updated_at overwrites the stored row'
);

-- A strictly older write is stale and the winning row comes back without a
-- second read.
select is(
  public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000301', 'appSettings', '{"theme":"stale"}'::jsonb,
    '2026-07-09T04:01:00.000000Z'::timestamptz, null
  ),
  jsonb_build_object(
    'written', false,
    'user_id', '00000000-0000-0000-0000-000000000301',
    'field_group', 'appSettings',
    'payload', '{"theme":"light"}'::jsonb,
    'updated_at', '2026-07-09T04:05:00.000000Z'::timestamptz,
    'deleted_at', null
  ),
  'an older updated_at is stale and returns the still-current winning row'
);

-- An equal updated_at is also stale: the first writer wins ties.
select is(
  public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000301', 'appSettings', '{"theme":"tie"}'::jsonb,
    '2026-07-09T04:05:00.000000Z'::timestamptz, null
  ),
  jsonb_build_object(
    'written', false,
    'user_id', '00000000-0000-0000-0000-000000000301',
    'field_group', 'appSettings',
    'payload', '{"theme":"light"}'::jsonb,
    'updated_at', '2026-07-09T04:05:00.000000Z'::timestamptz,
    'deleted_at', null
  ),
  'an equal updated_at is stale, so the first writer wins the tie'
);

-- Microsecond precision is preserved through the compare/write decision.
select is(
  public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000301', 'operatorConfig', '{"threads":2}'::jsonb,
    '2026-07-09T04:00:00.000001Z'::timestamptz, null
  ),
  jsonb_build_object(
    'written', true,
    'user_id', '00000000-0000-0000-0000-000000000301',
    'field_group', 'operatorConfig',
    'payload', '{"threads":2}'::jsonb,
    'updated_at', '2026-07-09T04:00:00.000001Z'::timestamptz,
    'deleted_at', null
  ),
  'a microsecond-precision first write is durably inserted'
);
select is(
  public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000301', 'operatorConfig', '{"threads":8}'::jsonb,
    '2026-07-09T04:00:00.000002Z'::timestamptz, null
  ),
  jsonb_build_object(
    'written', true,
    'user_id', '00000000-0000-0000-0000-000000000301',
    'field_group', 'operatorConfig',
    'payload', '{"threads":8}'::jsonb,
    'updated_at', '2026-07-09T04:00:00.000002Z'::timestamptz,
    'deleted_at', null
  ),
  'a one-microsecond-newer write wins over the prior microsecond'
);

-- A tombstone (deleted_at = updated_at) is just another LWW-compared write:
-- a newer tombstone wins over the live row it replaces.
select is(
  public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000301', 'appSettings', '{}'::jsonb,
    '2026-07-09T04:10:00.000000Z'::timestamptz, '2026-07-09T04:10:00.000000Z'::timestamptz
  ),
  jsonb_build_object(
    'written', true,
    'user_id', '00000000-0000-0000-0000-000000000301',
    'field_group', 'appSettings',
    'payload', '{}'::jsonb,
    'updated_at', '2026-07-09T04:10:00.000000Z'::timestamptz,
    'deleted_at', '2026-07-09T04:10:00.000000Z'::timestamptz
  ),
  'a tombstone write durably replaces the live row'
);

-- Older data racing in after a newer tombstone stays stale and does not
-- resurrect the tombstoned group.
select is(
  public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000301', 'appSettings', '{"theme":"late-arrival"}'::jsonb,
    '2026-07-09T04:05:00.000000Z'::timestamptz, null
  ),
  jsonb_build_object(
    'written', false,
    'user_id', '00000000-0000-0000-0000-000000000301',
    'field_group', 'appSettings',
    'payload', '{}'::jsonb,
    'updated_at', '2026-07-09T04:10:00.000000Z'::timestamptz,
    'deleted_at', '2026-07-09T04:10:00.000000Z'::timestamptz
  ),
  'a push older than a tombstone stays stale and the tombstone is not resurrected'
);

-- A newer push after the tombstone restores the group.
select is(
  public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000301', 'appSettings', '{"theme":"restored"}'::jsonb,
    '2026-07-09T04:15:00.000000Z'::timestamptz, null
  ),
  jsonb_build_object(
    'written', true,
    'user_id', '00000000-0000-0000-0000-000000000301',
    'field_group', 'appSettings',
    'payload', '{"theme":"restored"}'::jsonb,
    'updated_at', '2026-07-09T04:15:00.000000Z'::timestamptz,
    'deleted_at', null
  ),
  'a push newer than the tombstone clears it and restores the group'
);

-- Far-future timestamps still hit the existing check constraint: the durable
-- operation does not loosen that invariant.
select throws_ok(
  $$select public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000301', 'keybindings', '{}'::jsonb,
    now() + interval '10 minutes', null
  )$$,
  '23514',
  null,
  'a far-future updated_at still violates the existing check constraint'
);

-- Per-user isolation: one authenticated user cannot durably write another
-- user's row through this function, exactly like direct table access today.
select throws_ok(
  $$select public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000302', 'appSettings', '{}'::jsonb, now(), null
  )$$,
  '42501',
  null,
  'the function cannot be used to write another user''s row'
);

-- Nothing was written to user 302's rows by the isolation attempt above.
select is(
  (select count(*)::integer from public.settings_sync where user_id = '00000000-0000-0000-0000-000000000302'),
  0,
  'the isolation attempt left the other user with no sync rows'
);

-- A second user's groups are independent of the first user's LWW state.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000302', true);
select is(
  public.settings_sync_lww_write(
    '00000000-0000-0000-0000-000000000302', 'appSettings', '{"theme":"own"}'::jsonb,
    '2026-07-09T04:00:00.000000Z'::timestamptz, null
  ),
  jsonb_build_object(
    'written', true,
    'user_id', '00000000-0000-0000-0000-000000000302',
    'field_group', 'appSettings',
    'payload', '{"theme":"own"}'::jsonb,
    'updated_at', '2026-07-09T04:00:00.000000Z'::timestamptz,
    'deleted_at', null
  ),
  'a second user has their own independent LWW state for the same group'
);
reset role;
select is(
  (select payload from public.settings_sync where user_id = '00000000-0000-0000-0000-000000000301' and field_group = 'appSettings'),
  '{"theme":"restored"}'::jsonb,
  'the first user''s row is unaffected by the second user''s write'
);

select * from finish();

rollback;
