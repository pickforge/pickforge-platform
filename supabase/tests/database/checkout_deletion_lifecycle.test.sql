begin;

select plan(45);

select ok(
  not has_schema_privilege('anon', 'checkout_lifecycle_private', 'usage'),
  'anon cannot access the lifecycle schema'
);
select ok(
  not has_schema_privilege('authenticated', 'checkout_lifecycle_private', 'usage'),
  'authenticated cannot access the lifecycle schema'
);
select ok(
  not has_schema_privilege('service_role', 'checkout_lifecycle_private', 'usage'),
  'service role reaches lifecycle state only through approved RPCs'
);

select ok(
  not has_table_privilege('anon', 'checkout_lifecycle_private.deletion_fences', 'select'),
  'anon cannot read deletion fences'
);
select ok(
  not has_table_privilege('authenticated', 'checkout_lifecycle_private.deletion_fences', 'select'),
  'authenticated cannot read deletion fences'
);
select ok(
  not has_table_privilege('service_role', 'checkout_lifecycle_private.deletion_fences', 'select'),
  'service role cannot directly read deletion fences'
);
select ok(
  not has_table_privilege('anon', 'checkout_lifecycle_private.checkout_sessions', 'select'),
  'anon cannot read Checkout Session registrations'
);
select ok(
  not has_table_privilege('authenticated', 'checkout_lifecycle_private.checkout_sessions', 'select'),
  'authenticated cannot read Checkout Session registrations'
);
select ok(
  not has_table_privilege('service_role', 'checkout_lifecycle_private.checkout_sessions', 'select'),
  'service role cannot directly read Checkout Session registrations'
);

select is(
  (
    select relrowsecurity
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'checkout_lifecycle_private'
      and pg_class.relname = 'deletion_fences'
  ),
  true,
  'deletion fences have RLS defense in depth'
);
select is(
  (
    select relrowsecurity
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'checkout_lifecycle_private'
      and pg_class.relname = 'checkout_sessions'
  ),
  true,
  'Checkout Session registrations have RLS defense in depth'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.checkout_lifecycle_is_deletion_fenced(uuid)',
    'execute'
  ),
  'anon cannot inspect deletion fences through RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.checkout_lifecycle_register_session(uuid,text)',
    'execute'
  ),
  'authenticated cannot register arbitrary Checkout Sessions'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.checkout_lifecycle_mark_refunded(text,text)',
    'execute'
  ),
  'authenticated cannot mark arbitrary Checkout Sessions refunded'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.checkout_lifecycle_fence_deletion(uuid)',
    'execute'
  ),
  'service role can invoke the deletion fence RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.checkout_lifecycle_reconcile_completion(uuid,text,text,text,integer,text,text)',
    'execute'
  ),
  'service role can invoke atomic completion reconciliation'
);
select ok(
  not exists (
    select 1
    from pg_proc
    join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
    cross join lateral aclexplode(coalesce(pg_proc.proacl, acldefault('f', pg_proc.proowner))) as acl
    where pg_namespace.nspname = 'public'
      and pg_proc.proname like 'checkout_lifecycle_%'
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no implicit execute privilege on lifecycle RPCs'
);

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
values
  (
    '00000000-0000-0000-0000-000000000201',
    'authenticated',
    'authenticated',
    'checkout-lifecycle@example.invalid',
    '{}'::jsonb,
    '{}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000202',
    'authenticated',
    'authenticated',
    'checkout-lifecycle-other@example.invalid',
    '{}'::jsonb,
    '{}'::jsonb,
    false,
    now(),
    now()
  );

select is(
  public.checkout_lifecycle_register_session(
    '00000000-0000-0000-0000-000000000201',
    'cs_normal'
  ),
  false,
  'the first Session registers while checkout is allowed'
);
select is(
  public.checkout_lifecycle_is_deletion_fenced(
    '00000000-0000-0000-0000-000000000201'
  ),
  false,
  'the user starts unfenced'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_normal',
    'evt_normal',
    'checkout.session.completed',
    1000,
    'cus_normal',
    'pi_normal'
  ),
  'credited',
  'an unfenced completion grants credits atomically'
);
select is(
  (
    select count(*)::integer
    from public.credit_ledger
    where user_id = '00000000-0000-0000-0000-000000000201'
      and stripe_checkout_session_id = 'cs_normal'
  ),
  1,
  'normal reconciliation creates exactly one purchase ledger row'
);
select is(
  (
    select state
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_normal'
  ),
  'completed',
  'normal reconciliation marks the registry complete in the same transaction'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_normal',
    'evt_normal_replay',
    'checkout.session.completed',
    1000,
    'cus_normal',
    'pi_normal'
  ),
  'duplicate',
  'a credited completion is idempotent'
);

do $$
begin
  perform public.checkout_lifecycle_register_session(
    '00000000-0000-0000-0000-000000000201',
    'cs_owner_guard'
  );
end;
$$;

select throws_ok(
  $$select public.checkout_lifecycle_register_session(
    '00000000-0000-0000-0000-000000000202',
    'cs_owner_guard'
  )$$,
  '23000',
  'Checkout Session is already registered to another user',
  'registration cannot steal a Session through ON CONFLICT'
);
select throws_ok(
  $$select public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000202',
    'cs_owner_guard',
    'evt_owner_guard',
    'checkout.session.completed',
    1000,
    'cus_owner_guard',
    'pi_owner_guard'
  )$$,
  '23000',
  'Checkout Session is already registered to another user',
  'reconciliation cannot steal a Session registered to another user'
);

insert into public.credit_ledger (
  user_id,
  amount_cents,
  kind,
  stripe_event_id,
  stripe_checkout_session_id,
  idempotency_key
)
values (
  '00000000-0000-0000-0000-000000000202',
  100,
  'purchase',
  'evt_conflict_guard',
  'cs_conflict_owner',
  'stripe:cs_conflict_owner'
);

select throws_ok(
  $$select public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_conflict_attempt',
    'evt_conflict_guard',
    'checkout.session.completed',
    1000,
    'cus_conflict_attempt',
    'pi_conflict_attempt'
  )$$,
  '23000',
  'Stripe completion conflicts with another ledger entry',
  'a conflicting ledger event cannot terminalize an unrelated Session'
);
select throws_ok(
  $$select public.checkout_lifecycle_mark_refunded('cs_normal', 'evt_wrong_state')$$,
  'P0002',
  'Checkout Session refund is not pending',
  'only refund-pending Sessions can be marked refunded'
);

select lives_ok(
  $$select public.checkout_lifecycle_fence_deletion('00000000-0000-0000-0000-000000000201')$$,
  'deletion establishes the fence'
);
select is(
  public.checkout_lifecycle_register_session(
    '00000000-0000-0000-0000-000000000201',
    'cs_raced'
  ),
  true,
  'post-create registration reports that deletion won the race'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_raced',
    'evt_raced',
    'checkout.session.completed',
    2500,
    'cus_raced',
    'pi_raced'
  ),
  'refund',
  'a fenced completion requires compensation instead of credit'
);
select is(
  (
    select count(*)::integer
    from public.credit_ledger
    where stripe_checkout_session_id = 'cs_raced'
  ),
  0,
  'a fenced completion never grants credits'
);
select is(
  (
    select state
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_raced'
  ),
  'refund_pending',
  'refund work remains durable until Stripe compensation succeeds'
);
select lives_ok(
  $$select public.checkout_lifecycle_record_refund_failure(
    'cs_raced',
    'evt_raced',
    're_failed',
    'failed'
  )$$,
  'terminal refund failure remains in the private lifecycle registry'
);
select is(
  (
    select refund_error_code
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_raced'
  ),
  'failed',
  'terminal refund status is operator-visible'
);
select is(
  (
    select stripe_refund_id
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_raced'
  ),
  're_failed',
  'terminal refund records the Stripe Refund id for manual resolution'
);
select lives_ok(
  $$select public.checkout_lifecycle_mark_refunded('cs_raced', 'evt_raced')$$,
  'successful compensation marks the Session refunded'
);
select is(
  (
    select refund_error_code
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_raced'
  ),
  null,
  'successful manual or automatic resolution clears the terminal refund error'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_raced',
    'evt_raced_replay',
    'checkout.session.completed',
    2500,
    'cus_raced',
    'pi_raced'
  ),
  'refunded',
  'a compensated completion is idempotently terminal'
);
select is(
  (
    select count(*)::integer
    from public.checkout_lifecycle_list_sessions(
      '00000000-0000-0000-0000-000000000201',
      0,
      1000
    )
  ),
  3,
  'deletion can discover every registered Session'
);

select lives_ok(
  $$delete from auth.users where id = '00000000-0000-0000-0000-000000000201'$$,
  'lifecycle tombstones survive auth deletion'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_after_delete',
    'evt_after_delete',
    'checkout.session.completed',
    5000,
    'cus_after_delete',
    'pi_after_delete'
  ),
  'refund',
  'a payment for a missing user enters the same compensation path'
);
select is(
  (
    select state
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_after_delete'
  ),
  'refund_pending',
  'the missing-user payment durably retains pending refund work'
);
select is(
  (
    select count(*)::integer
    from public.credit_ledger
    where stripe_checkout_session_id = 'cs_after_delete'
  ),
  0,
  'the missing-user compensation path cannot mint credits'
);
select lives_ok(
  $$select public.checkout_lifecycle_mark_refunded('cs_after_delete', 'evt_after_delete')$$,
  'missing-user compensation can become terminal after Stripe succeeds'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_after_delete',
    'evt_after_delete_replay',
    'checkout.session.completed',
    5000,
    'cus_after_delete',
    'pi_after_delete'
  ),
  'refunded',
  'missing-user compensation is idempotently terminal'
);

select * from finish();
rollback;
