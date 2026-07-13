begin;

select plan(112);

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
select ok(
  not has_table_privilege('anon', 'checkout_lifecycle_private.refund_attempts', 'select'),
  'anon cannot read Refund attempt history'
);
select ok(
  not has_table_privilege('authenticated', 'checkout_lifecycle_private.refund_attempts', 'select'),
  'authenticated cannot read Refund attempt history'
);
select ok(
  not has_table_privilege('service_role', 'checkout_lifecycle_private.refund_attempts', 'select'),
  'service role cannot directly read Refund attempt history'
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
select is(
  (
    select relrowsecurity
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'checkout_lifecycle_private'
      and pg_class.relname = 'refund_attempts'
  ),
  true,
  'Refund attempt history has RLS defense in depth'
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
select lives_ok(
  $$select public.checkout_lifecycle_fence_deletion('00000000-0000-0000-0000-000000000202')$$,
  'a user with a pre-lifecycle credited purchase can begin deletion'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000202',
    'cs_conflict_owner',
    'evt_conflict_owner_retry',
    'checkout.session.completed',
    100,
    'cus_conflict_owner',
    'pi_conflict_owner'
  ),
  'duplicate',
  'a fenced retry backfills the authoritative credited purchase instead of refunding'
);
select is(
  (
    select state
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_conflict_owner'
  ),
  'completed',
  'the pre-lifecycle credited purchase is durably terminalized as completed'
);
select is(
  (
    select count(*)::integer
    from public.credit_ledger
    where stripe_checkout_session_id = 'cs_conflict_owner'
  ),
  1,
  'the credited retry remains exact-once'
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
select is(
  (public.checkout_lifecycle_prepare_refund_attempt('cs_raced') ->> 'attempt')::integer,
  1,
  'the initial refund attempt receives a durable attempt number'
);
select lives_ok(
  $$select public.checkout_lifecycle_record_refund_attempt(
    'cs_raced', 'evt_raced', 're_failed', 1, 2500
  )$$,
  'the initial Stripe Refund id is durably attached to its attempt'
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
select is(
  (public.checkout_lifecycle_prepare_refund_attempt('cs_raced') ->> 'attempt')::integer,
  2,
  'a terminal Refund permits exactly one new attempt number'
);
select lives_ok(
  $$select public.checkout_lifecycle_record_refund_attempt(
    'cs_raced', 'evt_raced_retry', 're_retry', 2, 1000
  )$$,
  'the retry persists a distinct Stripe Refund id'
);
select is(
  public.checkout_lifecycle_prepare_refund_attempt('cs_raced') ->> 'refund_id',
  're_retry',
  'an attached Refund remains recoverable after a crash before retrieval'
);
select is(
  public.checkout_lifecycle_reconcile_refund_event(
    're_retry',
    'evt_refund_missing_payment_intent',
    'succeeded',
    1000,
    null
  ) ->> 'status',
  'ignored',
  'an owned Refund event with missing checkout-specific fields is ignored'
);
select is(
  (
    select status
    from checkout_lifecycle_private.refund_attempts
    where stripe_checkout_session_id = 'cs_raced'
      and attempt = 2
  ),
  'pending',
  'an invalid owned Refund event cannot mutate attempt state'
);
select is(
  public.checkout_lifecycle_reconcile_refund_event(
    're_retry',
    'evt_refund_succeeded',
    'succeeded',
    1000,
    'pi_raced'
  ) ->> 'status',
  'succeeded',
  'a signed partial succeeded Refund remains attached for aggregate verification'
);
select is(
  (
    select state
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_raced'
  ),
  'refund_pending',
  'an individual partial Refund cannot terminalize compensation'
);
select throws_ok(
  $$select public.checkout_lifecycle_mark_refunded('cs_raced', 'evt_partial_only')$$,
  '23000',
  'Refund attempt history does not cover the full Checkout Session amount',
  'SQL refuses to mark a Checkout Session refunded before owned attempts cover it'
);
select lives_ok(
  $$select public.checkout_lifecycle_record_refund_failure(
    'cs_raced', 'evt_refund_partial', 're_retry', 'partial'
  )$$,
  'aggregate shortfall is durably retryable'
);
select is(
  (public.checkout_lifecycle_prepare_refund_attempt('cs_raced') ->> 'attempt')::integer,
  3,
  'a partial succeeded Refund claims the next attempt'
);
select lives_ok(
  $$select public.checkout_lifecycle_record_refund_attempt(
    'cs_raced', 'evt_remaining_attempt', 're_remaining', 3, 1500
  )$$,
  'the remaining-amount attempt is durably attached'
);
select is(
  public.checkout_lifecycle_reconcile_refund_event(
    're_remaining',
    'evt_remaining_succeeded',
    'succeeded',
    1500,
    'pi_raced'
  ) ->> 'status',
  'succeeded',
  'the remaining Refund is accepted for aggregate verification'
);
select lives_ok(
  $$select public.checkout_lifecycle_mark_refunded('cs_raced', 'evt_aggregate_full')$$,
  'aggregate full-refund verification can terminalize compensation'
);
select is(
  public.checkout_lifecycle_reconcile_refund_event(
    're_retry',
    'evt_superseded_refund_failure',
    'failed',
    1000,
    'pi_raced'
  ) ->> 'status',
  'retry_required',
  'a superseded partial Refund remains reconcilable after aggregate completion'
);
select is(
  (
    select state
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_raced'
  ),
  'refund_pending',
  'a superseded partial Refund reversal reopens compensation'
);
select is(
  (
    select status
    from checkout_lifecycle_private.refund_attempts
    where stripe_refund_id = 're_retry'
  ),
  'failed',
  'the superseded attempt retains its own terminal status'
);
select is(
  public.checkout_lifecycle_reconcile_refund_event(
    're_retry',
    'evt_out_of_order_succeeded',
    'succeeded',
    1000,
    'pi_raced'
  ) ->> 'status',
  'ignored',
  'an out-of-order succeeded event cannot resurrect a terminal Refund'
);
select is(
  public.checkout_lifecycle_reconcile_refund_event(
    're_remaining',
    'evt_late_refund_failure',
    'failed',
    1500,
    'pi_raced'
  ) ->> 'status',
  'retry_required',
  'a formerly succeeded Refund that later fails reopens compensation'
);
select is(
  (
    select state
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_raced'
  ),
  'refund_pending',
  'late Refund failure blocks finalization again'
);
select is(
  (
    public.checkout_lifecycle_finalize_deletion(
      '00000000-0000-0000-0000-000000000201'
    ) ->> 'status'
  ),
  'unsafe',
  'reopened compensation prevents account deletion'
);
select is(
  (public.checkout_lifecycle_prepare_refund_attempt('cs_raced') ->> 'attempt')::integer,
  4,
  'late Refund failure claims a new persisted attempt'
);
select lives_ok(
  $$select public.checkout_lifecycle_record_refund_attempt(
    'cs_raced', 'evt_late_recovery', 're_late_recovery', 4, 2500
  )$$,
  'late Refund recovery attaches its replacement Refund'
);
select is(
  public.checkout_lifecycle_reconcile_refund_event(
    're_late_recovery',
    'evt_late_recovery_succeeded',
    'succeeded',
    2500,
    'pi_raced'
  ) ->> 'status',
  'succeeded',
  'the replacement full Refund is accepted for aggregate verification'
);
select lives_ok(
  $$select public.checkout_lifecycle_mark_refunded('cs_raced', 'evt_late_recovery_full')$$,
  'late Refund recovery can terminalize compensation again'
);
select is(
  public.checkout_lifecycle_reconcile_refund_event(
    're_retry',
    'evt_duplicate_late_failure',
    'failed',
    1000,
    'pi_raced'
  ) ->> 'status',
  'ignored',
  'a duplicate historical failure cannot reopen fully restored coverage'
);
select is(
  (
    select refund_error_code
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_raced'
  ),
  null::text,
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
select throws_ok(
  $$select public.checkout_lifecycle_record_refund_failure(
    'cs_unknown_refund_failure',
    'evt_unknown_refund_failure',
    're_unknown_refund_failure',
    'failed'
  )$$,
  'P0002',
  'Checkout Session refund failure is not pending',
  'recording a Refund failure cannot silently update zero rows'
);
select is(
  public.checkout_lifecycle_reconcile_refund_event(
    're_unknown',
    'evt_unknown_refund',
    'succeeded',
    2500,
    'pi_unknown'
  ) ->> 'status',
  'ignored',
  'an unknown Refund cannot mutate lifecycle state'
);

do $$
begin
  perform public.checkout_lifecycle_fence_deletion(
    '00000000-0000-0000-0000-000000000202'
  );
  perform public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000202',
    'cs_other_refund_owner',
    'evt_other_refund_owner',
    'checkout.session.completed',
    500,
    'cus_other_refund_owner',
    'pi_other_refund_owner'
  );
  perform public.checkout_lifecycle_prepare_refund_attempt('cs_other_refund_owner');
end;
$$;
select throws_ok(
  $$select public.checkout_lifecycle_record_refund_attempt(
    'cs_other_refund_owner',
    'evt_cross_owner_refund',
    're_late_recovery',
    1,
    500
  )$$,
  '23505',
  null,
  'a Stripe Refund id cannot be attached to another user or Checkout Session'
);

select is(
  (
    public.checkout_lifecycle_finalize_deletion(
      '00000000-0000-0000-0000-000000000201'
    ) ->> 'status'
  ),
  'unsafe',
  'locked deletion finalization rejects an existing open registry row'
);
select lives_ok(
  $$select public.checkout_lifecycle_mark_expired('cs_owner_guard')$$,
  'settled open Sessions can be durably marked expired'
);

do $$
begin
  perform public.checkout_lifecycle_register_session(
    '00000000-0000-0000-0000-000000000201',
    'cs_async_failed'
  );
end;
$$;

select is(
  public.checkout_lifecycle_mark_async_payment_failed(
    '00000000-0000-0000-0000-000000000201',
    'cs_async_failed',
    'evt_async_failed',
    'cus_async_failed'
  ),
  'terminalized',
  'failed asynchronous payment terminalizes its registered Session'
);
select is(
  (
    select state
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_async_failed'
  ),
  'payment_failed',
  'failed asynchronous payment is a terminal non-credit state'
);
select is(
  (
    select stripe_customer_id
    from checkout_lifecycle_private.checkout_sessions
    where stripe_checkout_session_id = 'cs_async_failed'
  ),
  'cus_async_failed',
  'failed asynchronous payment durably retains its Stripe customer'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_async_failed',
    'evt_paid_after_async_failure',
    'checkout.session.completed',
    1000,
    'cus_async_failed',
    'pi_async_failed'
  ),
  'duplicate',
  'a delayed paid event after async failure remains non-credit terminal'
);
select is(
  (
    select count(*)::integer
    from public.credit_ledger
    where stripe_checkout_session_id = 'cs_async_failed'
  ),
  0,
  'a delayed paid event after async failure cannot mint credits'
);
select is(
  (
    public.checkout_lifecycle_finalize_deletion(
      '00000000-0000-0000-0000-000000000201'
    ) ->> 'status'
  ),
  'finalized',
  'locked deletion finalization succeeds only after every row is terminal'
);
select ok(
  (
    public.checkout_lifecycle_finalize_deletion(
      '00000000-0000-0000-0000-000000000201'
    ) -> 'customer_ids'
  ) @> '["cus_raced"]'::jsonb,
  'locked deletion finalization returns the authoritative customer snapshot'
);
select is(
  public.checkout_lifecycle_register_session(
    '00000000-0000-0000-0000-000000000201',
    'cs_after_finalize'
  ),
  true,
  'registration after finalization is fenced without creating new pending work'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_after_finalize',
    'evt_after_finalize',
    'checkout.session.completed',
    5000,
    'cus_after_finalize',
    'pi_after_finalize'
  ),
  'refund_missing_user',
  'a completion after finalization requires refund and customer cleanup while auth exists'
);
select is(
  (
    select finalized_at is null
    from checkout_lifecycle_private.deletion_fences
    where user_id = '00000000-0000-0000-0000-000000000201'
  ),
  true,
  'late completion invalidates the frozen deletion snapshot'
);
do $$
begin
  perform public.checkout_lifecycle_record_observed_refund(
    'cs_after_finalize',
    'evt_after_finalize',
    're_after_finalize',
    5000,
    'pi_after_finalize'
  );
end;
$$;
select lives_ok(
  $$select public.checkout_lifecycle_mark_refunded('cs_after_finalize', 'evt_after_finalize')$$,
  'late finalized-fence refund can become terminal'
);
select is(
  public.checkout_lifecycle_get_customer_cleanup('cs_after_finalize') ->> 'customer_id',
  'cus_after_finalize',
  'late finalized-fence cleanup stores its authoritative customer'
);
select lives_ok(
  $$select public.checkout_lifecycle_complete_customer_cleanup('cs_after_finalize')$$,
  'late finalized-fence customer cleanup can become terminal'
);
select is(
  (
    public.checkout_lifecycle_finalize_deletion(
      '00000000-0000-0000-0000-000000000201'
    ) ->> 'status'
  ),
  'finalized',
  'deletion can be finalized again after late refund cleanup'
);
select ok(
  (
    public.checkout_lifecycle_finalize_deletion(
      '00000000-0000-0000-0000-000000000201'
    ) -> 'customer_ids'
  ) @> '["cus_after_finalize"]'::jsonb,
  'refinalization returns the late customer in its authoritative snapshot'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_atomic_race',
    'evt_atomic_race',
    'checkout.session.completed',
    5000,
    'cus_atomic_race',
    'pi_atomic_race'
  ),
  'refund_missing_user',
  'completion can start customer cleanup after the frozen snapshot'
);
select is(
  public.checkout_lifecycle_delete_auth_user(
    '00000000-0000-0000-0000-000000000201'
  ),
  'unsafe',
  'atomic auth deletion rejects completion work started after finalization'
);
select ok(
  exists (
    select 1
    from auth.users
    where id = '00000000-0000-0000-0000-000000000201'
  ),
  'the user survives the finalization-to-auth deletion race'
);
do $$
begin
  perform public.checkout_lifecycle_record_observed_refund(
    'cs_atomic_race',
    'evt_atomic_race',
    're_atomic_race',
    5000,
    'pi_atomic_race'
  );
end;
$$;
select lives_ok(
  $$select public.checkout_lifecycle_mark_refunded('cs_atomic_race', 'evt_atomic_race')$$,
  'the racing completion refund can become terminal'
);
select is(
  (
    public.checkout_lifecycle_finalize_deletion(
      '00000000-0000-0000-0000-000000000201'
    ) ->> 'status'
  ),
  'unsafe',
  'refunded customer cleanup remains unsafe until durably cleared'
);
select lives_ok(
  $$select public.checkout_lifecycle_complete_customer_cleanup('cs_atomic_race')$$,
  'the racing completion customer cleanup can become terminal'
);
select is(
  (
    public.checkout_lifecycle_finalize_deletion(
      '00000000-0000-0000-0000-000000000201'
    ) ->> 'status'
  ),
  'finalized',
  'deletion refinalizes after the racing completion is fully cleaned'
);
select is(
  public.checkout_lifecycle_delete_auth_user(
    '00000000-0000-0000-0000-000000000201'
  ),
  'deleted',
  'auth deletion linearizes under the lifecycle advisory lock'
);
select ok(
  not exists (
    select 1
    from auth.users
    where id = '00000000-0000-0000-0000-000000000201'
  ),
  'atomic lifecycle deletion removes auth only after cleanup'
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
  6,
  'deletion can discover every registered Session'
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
  'refund_missing_user',
  'a payment for a missing user enters refund plus customer-cleanup compensation'
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
do $$
begin
  perform public.checkout_lifecycle_record_observed_refund(
    'cs_after_delete',
    'evt_after_delete',
    're_after_delete',
    5000,
    'pi_after_delete'
  );
end;
$$;
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
  'refunded_cleanup_pending',
  'missing-user refund remains nonterminal until late customer cleanup succeeds'
);
select is(
  public.checkout_lifecycle_get_customer_cleanup('cs_after_delete') ->> 'customer_id',
  'cus_after_delete',
  'late customer cleanup reads the customer id stored by reconciliation'
);
select lives_ok(
  $$select public.checkout_lifecycle_complete_customer_cleanup('cs_after_delete')$$,
  'late missing-user Stripe customer cleanup can be durably acknowledged'
);
select lives_ok(
  $$select public.checkout_lifecycle_complete_customer_cleanup('cs_after_delete')$$,
  'replayed customer cleanup is idempotent after pending work is cleared'
);
select lives_ok(
  $$select public.checkout_lifecycle_complete_customer_cleanup('cs_unknown_cleanup')$$,
  'unknown customer cleanup is an idempotent no-op'
);
select is(
  public.checkout_lifecycle_reconcile_completion(
    '00000000-0000-0000-0000-000000000201',
    'cs_after_delete',
    'evt_after_delete_final',
    'checkout.session.completed',
    5000,
    'cus_after_delete',
    'pi_after_delete'
  ),
  'refunded',
  'missing-user compensation becomes terminal only after customer cleanup'
);

select * from finish();
rollback;
