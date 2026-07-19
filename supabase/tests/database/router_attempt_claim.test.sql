begin;

select plan(23);

-- Only service_role can claim/complete/fail router attempts.
select ok(
  not has_function_privilege('anon', 'public.router_attempt_claim(uuid, text, integer)', 'execute'),
  'anon cannot claim router attempts'
);
select ok(
  not has_function_privilege('authenticated', 'public.router_attempt_claim(uuid, text, integer)', 'execute'),
  'authenticated cannot claim router attempts'
);
select ok(
  has_function_privilege('service_role', 'public.router_attempt_claim(uuid, text, integer)', 'execute'),
  'service_role can claim router attempts'
);
select ok(
  not has_function_privilege('anon', 'public.router_attempt_complete(uuid, text, text, integer, integer)', 'execute'),
  'anon cannot complete router attempts'
);
select ok(
  has_function_privilege('service_role', 'public.router_attempt_complete(uuid, text, text, integer, integer)', 'execute'),
  'service_role can complete router attempts'
);
select ok(
  not has_function_privilege('anon', 'public.router_attempt_fail(uuid, text)', 'execute'),
  'anon cannot fail router attempts'
);
select ok(
  has_function_privilege('service_role', 'public.router_attempt_fail(uuid, text)', 'execute'),
  'service_role can fail router attempts'
);
select ok(
  not has_table_privilege('anon', 'public.router_attempts', 'select'),
  'anon has no direct router_attempts privileges'
);
select ok(
  not has_table_privilege('authenticated', 'public.router_attempts', 'select'),
  'authenticated has no direct router_attempts privileges'
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000401', 'authenticated', 'authenticated',
  'router-attempt-claim@example.invalid', '{}'::jsonb, '{}'::jsonb, false, now(), now()
);

-- The first claim for a key durably owns provider invocation.
select is(
  public.router_attempt_claim('00000000-0000-0000-0000-000000000401', 'router:attempt-1'),
  jsonb_build_object('outcome', 'claimed'),
  'the first claim for an absent key is durably claimed'
);

-- A second claim for the same still-claimed key must not also claim it.
select is(
  public.router_attempt_claim('00000000-0000-0000-0000-000000000401', 'router:attempt-1'),
  jsonb_build_object('outcome', 'in_progress'),
  'a live claim is reported in_progress, never re-claimed'
);

-- Recording the provider outcome makes it durably completed.
select is(
  public.router_attempt_complete(
    '00000000-0000-0000-0000-000000000401', 'router:attempt-1',
    '{"action":"openProject"}', 42, 13
  ),
  jsonb_build_object(
    'outcome', 'completed',
    'proposal_json', '{"action":"openProject"}',
    'usage_input', 42,
    'usage_output', 13
  ),
  'completing a claimed attempt durably records the provider outcome'
);

-- Replaying completion on an already-completed attempt is idempotent.
select is(
  public.router_attempt_complete(
    '00000000-0000-0000-0000-000000000401', 'router:attempt-1',
    '{"action":"different"}', 1, 1
  ),
  jsonb_build_object(
    'outcome', 'completed',
    'proposal_json', '{"action":"openProject"}',
    'usage_input', 42,
    'usage_output', 13
  ),
  'completing an already-completed attempt is a no-op that returns the stored outcome'
);

-- A later claim on a completed key returns the stored result instead of
-- reclaiming, so a retry can skip straight to a debit retry.
select is(
  public.router_attempt_claim('00000000-0000-0000-0000-000000000401', 'router:attempt-1'),
  jsonb_build_object(
    'outcome', 'completed',
    'proposal_json', '{"action":"openProject"}',
    'usage_input', 42,
    'usage_output', 13
  ),
  'claiming an already-completed key returns the stored outcome, not a new claim'
);

-- A definitive provider failure releases the claim immediately.
select public.router_attempt_claim('00000000-0000-0000-0000-000000000401', 'router:attempt-2');
select public.router_attempt_fail('00000000-0000-0000-0000-000000000401', 'router:attempt-2');
select is(
  public.router_attempt_claim('00000000-0000-0000-0000-000000000401', 'router:attempt-2'),
  jsonb_build_object('outcome', 'claimed'),
  'a failed attempt can be re-claimed immediately, without waiting out a lease'
);

-- A stale claim (past its lease) is recoverable.
update public.router_attempts
set claimed_at = now() - interval '1 hour'
where user_id = '00000000-0000-0000-0000-000000000401'
  and idempotency_key = 'router:attempt-2';
select is(
  public.router_attempt_claim('00000000-0000-0000-0000-000000000401', 'router:attempt-2', 30),
  jsonb_build_object('outcome', 'claimed'),
  'a claim past its lease is recoverable by a later caller'
);

-- A claim still within its lease is not recoverable.
select is(
  public.router_attempt_claim('00000000-0000-0000-0000-000000000401', 'router:attempt-2', 30),
  jsonb_build_object('outcome', 'in_progress'),
  'a claim within its lease stays in_progress'
);

-- Completing an attempt that was never claimed fails loudly.
select throws_ok(
  $$select public.router_attempt_complete('00000000-0000-0000-0000-000000000401', 'router:never-claimed', 'x', 1, 1)$$,
  '55000',
  'router attempt for user 00000000-0000-0000-0000-000000000401 and key router:never-claimed is not claimed',
  'completing an attempt with no matching claim raises'
);

-- Per-user isolation: two users can independently claim the same literal key.
insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000402', 'authenticated', 'authenticated',
  'router-attempt-claim-b@example.invalid', '{}'::jsonb, '{}'::jsonb, false, now(), now()
);
select is(
  public.router_attempt_claim('00000000-0000-0000-0000-000000000402', 'router:attempt-1'),
  jsonb_build_object('outcome', 'claimed'),
  'a different user can independently claim the same literal idempotency key'
);

-- Input validation.
select throws_ok(
  $$select public.router_attempt_claim('00000000-0000-0000-0000-000000000401', '')$$,
  '22023',
  'idem_key must be a non-empty string',
  'claim rejects an empty idempotency key'
);
select throws_ok(
  $$select public.router_attempt_claim('00000000-0000-0000-0000-000000000401', 'router:attempt-3', 0)$$,
  '22023',
  'lease_seconds must be a positive integer',
  'claim rejects a non-positive lease'
);
select throws_ok(
  $$select public.router_attempt_complete('00000000-0000-0000-0000-000000000401', 'router:attempt-1', '', 1, 1)$$,
  '22023',
  'new_proposal_json must be a non-empty string',
  'complete rejects an empty proposal_json'
);
select throws_ok(
  $$select public.router_attempt_complete('00000000-0000-0000-0000-000000000401', 'router:attempt-1', 'x', -1, 1)$$,
  '22023',
  'new_usage_input and new_usage_output must be non-negative integers',
  'complete rejects negative usage'
);

select finish();
rollback;
