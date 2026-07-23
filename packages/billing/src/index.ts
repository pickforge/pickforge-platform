export type LedgerKind = "purchase" | "usage" | "grant" | "refund" | "adjustment";

export type BillingErrorCode =
  | "database_error"
  | "invalid_checkout_amount"
  | "invalid_credit_balance"
  | "invalid_limit"
  | "invalid_string"
  | "invalid_stripe_event"
  | "invalid_stripe_event_object"
  | "invalid_user_id"
  | "refund_incomplete"
  | "refund_terminal_failure";

export type BillingJson =
  | string
  | number
  | boolean
  | null
  | BillingJson[]
  | { [key: string]: BillingJson };

export type BillingMetadata = { [key: string]: BillingJson };

export interface CreditLedgerEntry {
  id: string;
  userId: string;
  amountCents: number;
  kind: LedgerKind;
  description: string | null;
  stripeEventId: string | null;
  stripeCheckoutSessionId: string | null;
  metadata: BillingMetadata;
  createdAt: string;
}

export interface BillingCustomer {
  userId: string;
  stripeCustomerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StripeEventLike<TObject = unknown> {
  id: string;
  type: string;
  data: {
    object: TObject;
  };
}

export type StripeWebhookPayload = string | Uint8Array | ArrayBuffer;

export interface StripeCheckoutSessionCreateParams {
  mode: "payment";
  customer_creation?: "always";
  customer?: string;
  client_reference_id: string;
  line_items: Array<{
    price: string;
    quantity: number;
  }>;
  success_url: string;
  cancel_url: string;
}

export interface StripeRefundLike {
  id: string;
  amount: number;
  status: string | null;
}

interface StripeRefundEventObject {
  id: string;
  amount: number;
  status: string | null;
  payment_intent: unknown;
}

export interface StripeClientLike {
  checkout: {
    sessions: {
      create<TSession = unknown>(
        params: StripeCheckoutSessionCreateParams,
        options: { idempotencyKey: string },
      ): Promise<TSession>;
    };
  };
  customers: {
    del(customerId: string): Promise<unknown>;
  };
  refunds: {
    create(
      params: { payment_intent: string; amount?: number },
      options: { idempotencyKey: string },
    ): Promise<StripeRefundLike>;
    retrieve(refundId: string): Promise<StripeRefundLike>;
    list(params: {
      payment_intent: string;
      limit: number;
      starting_after?: string;
    }): Promise<{ data: StripeRefundLike[]; has_more: boolean }>;
  };
  webhooks: {
    constructEventAsync(
      payload: StripeWebhookPayload,
      signature: string,
      secret: string,
    ): Promise<StripeEventLike>;
  };
}

export interface SupabaseErrorLike {
  code?: string;
  message: string;
  details?: string;
  hint?: string;
}

export interface SupabaseQueryResult<T> {
  data: T | null;
  error: SupabaseErrorLike | null;
}

export interface SupabaseQueryBuilderLike<T = unknown> extends PromiseLike<SupabaseQueryResult<T>> {
  select(columns?: string): SupabaseQueryBuilderLike<T>;
  insert(values: unknown): SupabaseQueryBuilderLike<T>;
  upsert(
    values: unknown,
    options?: {
      onConflict?: string;
      ignoreDuplicates?: boolean;
    },
  ): SupabaseQueryBuilderLike<T>;
  eq(column: string, value: unknown): SupabaseQueryBuilderLike<T>;
  order(
    column: string,
    options?: {
      ascending?: boolean;
    },
  ): SupabaseQueryBuilderLike<T>;
  limit(count: number): SupabaseQueryBuilderLike<T>;
  maybeSingle(): PromiseLike<SupabaseQueryResult<T | null>>;
}

export interface SupabaseClientLike {
  from(table: string): unknown;
  rpc(fn: string, args?: Record<string, unknown>): unknown;
}

export class BillingError extends Error {
  readonly code: BillingErrorCode;

  constructor(code: BillingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BillingError";
    this.code = code;
    this.cause = options?.cause;
  }
}

export interface VerifyStripeEventOptions {
  payload: StripeWebhookPayload;
  signature: string;
  secret: string;
  stripe: StripeClientLike;
}

export interface ProcessStripeEventOptions {
  supabase: SupabaseClientLike;
  stripe: Pick<StripeClientLike, "customers" | "refunds">;
  event: StripeEventLike;
}

export interface ProcessStripeEventResult {
  handled: boolean;
  duplicate: boolean;
  reconciliation?: "deletion_race_refunded";
}

type CheckoutCompletionReconciliation =
  | "credited"
  | "refund"
  | "refunded"
  | "refund_missing_user"
  | "refunded_cleanup_pending"
  | "duplicate";

interface CheckoutCompletionReconciliationArgs extends Record<string, unknown> {
  target_user: string;
  checkout_session_id: string;
  event_id: string;
  event_type: string;
  amount_total_cents: number;
  stripe_customer_id: string | null;
  stripe_payment_intent_id: string;
}

export interface CreateCreditCheckoutSessionOptions {
  stripe: StripeClientLike;
  userId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  existingCustomerId?: string;
  /**
   * Stable per-attempt identity for the Stripe idempotency key. Retries of the
   * same purchase must reuse the same value; a genuinely new purchase must pass
   * a fresh value (or omit it, in which case a fresh one is generated).
   */
  requestId?: string;
}

export interface GetCreditBalanceOptions {
  supabase: SupabaseClientLike;
  userId: string;
}

export interface ListLedgerEntriesOptions {
  supabase: SupabaseClientLike;
  userId: string;
  limit?: number;
}

interface StripeCheckoutSessionObject {
  id?: unknown;
  amount_total?: unknown;
  customer?: unknown;
  client_reference_id?: unknown;
  payment_status?: unknown;
  payment_intent?: unknown;
}

interface CreditLedgerRow {
  id: string;
  user_id: string;
  amount_cents: number;
  kind: LedgerKind;
  description: string | null;
  stripe_event_id: string | null;
  stripe_checkout_session_id: string | null;
  metadata: unknown;
  created_at: string;
}

const MAX_CHECKOUT_AMOUNT_CENTS = 100_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function verifyStripeEvent({
  payload,
  signature,
  secret,
  stripe,
}: VerifyStripeEventOptions): Promise<StripeEventLike> {
  return stripe.webhooks.constructEventAsync(payload, signature, secret);
}

export async function processStripeEvent({
  supabase,
  stripe,
  event,
}: ProcessStripeEventOptions): Promise<ProcessStripeEventResult> {
  assertStripeEvent(event);

  if (
    event.type === "refund.created" ||
    event.type === "refund.updated" ||
    event.type === "refund.failed"
  ) {
    const result = await processRefundLifecycleEvent({ supabase, stripe, event });
    await recordStripeEventBestEffort(supabase, event);
    return result;
  }
  if (event.type === "checkout.session.async_payment_failed") {
    const result = await processCheckoutSessionAsyncPaymentFailed(supabase, event);
    await recordStripeEventBestEffort(supabase, event);
    return result;
  }

  if (isCheckoutMoneyEvent(event.type)) {
    const result = await processCheckoutSessionMoneyEvent({ supabase, stripe, event });
    await recordStripeEventBestEffort(supabase, event);

    return result;
  }

  return recordUnrecognizedStripeEvent(supabase, event);
}

export async function createCreditCheckoutSession<TSession = unknown>({
  stripe,
  userId,
  priceId,
  successUrl,
  cancelUrl,
  existingCustomerId,
  requestId,
}: CreateCreditCheckoutSessionOptions): Promise<TSession> {
  const validUserId = validateUuid(userId, "userId");
  const validPriceId = validateNonEmptyString(priceId, "priceId");
  const validSuccessUrl = validateNonEmptyString(successUrl, "successUrl");
  const validCancelUrl = validateNonEmptyString(cancelUrl, "cancelUrl");
  const customer = typeof existingCustomerId === "string" && existingCustomerId.trim().length > 0 ? existingCustomerId : undefined;
  // Deterministic idempotency key mirroring the refund pattern: the same purchase
  // attempt (network/SDK/app retry) reuses this key and Stripe returns the one
  // Session, while a distinct purchase supplies a fresh requestId and therefore a
  // distinct key, so a legitimately new purchase can never collide with an old one.
  const purchaseRequestId =
    typeof requestId === "string" && requestId.trim().length > 0
      ? requestId.trim()
      : globalThis.crypto.randomUUID();
  const idempotencyKey = `checkout-session:${validUserId}:${purchaseRequestId}`;

  return stripe.checkout.sessions.create<TSession>(
    {
      mode: "payment",
      ...(customer === undefined ? { customer_creation: "always" as const } : { customer }),
      client_reference_id: validUserId,
      line_items: [
        {
          price: validPriceId,
          quantity: 1,
        },
      ],
      success_url: validSuccessUrl,
      cancel_url: validCancelUrl,
    },
    { idempotencyKey },
  );
}

export async function getCreditBalanceCents({
  supabase,
  userId,
}: GetCreditBalanceOptions): Promise<number> {
  const validUserId = validateUuid(userId, "userId");
  const { data, error } = await (supabase.rpc("credit_balance_cents", {
    target_user: validUserId,
  }) as PromiseLike<SupabaseQueryResult<number>>);
  if (error !== null) {
    throw databaseError("Failed to read credit balance", error);
  }
  if (typeof data !== "number" || !Number.isInteger(data)) {
    throw new BillingError("invalid_credit_balance", "Supabase returned an invalid credit balance");
  }

  return data;
}

export async function listLedgerEntries({
  supabase,
  userId,
  limit,
}: ListLedgerEntriesOptions): Promise<CreditLedgerEntry[]> {
  const validUserId = validateUuid(userId, "userId");
  let query = (supabase.from("credit_ledger") as SupabaseQueryBuilderLike<CreditLedgerRow[]>)
    .select("id,user_id,amount_cents,kind,description,stripe_event_id,stripe_checkout_session_id,metadata,created_at")
    .eq("user_id", validUserId)
    .order("created_at", { ascending: false });

  if (limit !== undefined) {
    query = query.limit(validatePositiveInteger(limit, "limit", "invalid_limit"));
  }

  const { data, error } = await query;
  if (error !== null) {
    throw databaseError("Failed to list credit ledger entries", error);
  }

  return (data ?? []).map(toCreditLedgerEntry);
}

async function processCheckoutSessionAsyncPaymentFailed(
  supabase: SupabaseClientLike,
  event: StripeEventLike,
): Promise<ProcessStripeEventResult> {
  const session = getObject<StripeCheckoutSessionObject>(event);
  const sessionId = validateNonEmptyString(session.id, "checkout session id");
  const userId = validateUuid(session.client_reference_id, "client_reference_id");
  const { data, error } = await (supabase.rpc(
    "checkout_lifecycle_mark_async_payment_failed",
    {
      target_user: userId,
      checkout_session_id: sessionId,
      event_id: event.id,
      stripe_customer_id: readStripeObjectId(session.customer),
    },
  ) as PromiseLike<SupabaseQueryResult<string>>);
  if (error !== null) {
    throw databaseError("Failed to terminalize failed asynchronous Checkout Session", error);
  }
  if (data === "terminalized") {
    return { handled: true, duplicate: false };
  }
  if (data === "duplicate") {
    return { handled: false, duplicate: true };
  }
  if (data === "missing") {
    return { handled: false, duplicate: false };
  }
  throw databaseError("Invalid asynchronous Checkout Session failure response", {
    message: "checkout_lifecycle_mark_async_payment_failed returned an unknown result",
  });
}

async function processCheckoutSessionMoneyEvent({
  supabase,
  stripe,
  event,
}: ProcessStripeEventOptions): Promise<ProcessStripeEventResult> {
  const session = getObject<StripeCheckoutSessionObject>(event);
  const sessionId = validateNonEmptyString(session.id, "checkout session id");
  const userId = validateUuid(session.client_reference_id, "client_reference_id");
  const paymentStatus = validateNonEmptyString(session.payment_status, "payment_status");

  if (paymentStatus !== "paid") {
    return { handled: false, duplicate: false };
  }

  const amountCents = validateCheckoutAmount(session.amount_total);
  const customerId = readStripeObjectId(session.customer);
  const paymentIntentId = validateNonEmptyString(
    readStripeObjectId(session.payment_intent),
    "payment_intent",
  );
  const reconciliation = await reconcileCheckoutCompletion(supabase, {
    target_user: userId,
    checkout_session_id: sessionId,
    event_id: event.id,
    event_type: event.type,
    amount_total_cents: amountCents,
    stripe_customer_id: customerId,
    stripe_payment_intent_id: paymentIntentId,
  });

  if (reconciliation === "duplicate") {
    return { handled: false, duplicate: true };
  }
  if (reconciliation === "refunded") {
    return {
      handled: false,
      duplicate: true,
      reconciliation: "deletion_race_refunded",
    };
  }
  if (reconciliation === "refunded_cleanup_pending") {
    await completeLateCustomerCleanup(supabase, stripe, sessionId);
    return {
      handled: true,
      duplicate: false,
      reconciliation: "deletion_race_refunded",
    };
  }
  if (reconciliation === "refund" || reconciliation === "refund_missing_user") {
    await performDeletionRefund({
      supabase,
      stripe,
      sessionId,
      eventId: event.id,
      eventType: event.type,
      paymentIntentId,
      amountCents,
      cleanupLateCustomer: reconciliation === "refund_missing_user",
    });
    return {
      handled: true,
      duplicate: false,
      reconciliation: "deletion_race_refunded",
    };
  }

  return { handled: true, duplicate: false };
}

// eslint-disable-next-line max-lines-per-function -- TODO(#57): split the legacy refund lifecycle flow.
async function processRefundLifecycleEvent({
  supabase,
  stripe,
  event,
}: ProcessStripeEventOptions): Promise<ProcessStripeEventResult> {
  const refund = getObject<StripeRefundEventObject>(event);
  const refundId = validateNonEmptyString(refund.id, "refund id");
  const rawPaymentIntentId = readStripeObjectId(refund.payment_intent);
  const rawAmountCents = Number.isSafeInteger(refund.amount) ? refund.amount : null;
  const rawStatus = typeof refund.status === "string" && refund.status.length > 0
    ? refund.status
    : null;
  const data = await reconcileRefundLifecycleEvent(supabase, {
    refund_id: refundId,
    event_id: event.id,
    refund_status: rawStatus,
    refund_amount: rawAmountCents,
    payment_intent_id: rawPaymentIntentId,
  });
  if (data.status === "ignored") {
    return { handled: false, duplicate: false };
  }

  const paymentIntentId = validateNonEmptyString(rawPaymentIntentId, "payment_intent");
  const amountCents = validateCheckoutAmount(rawAmountCents);
  if (data.status === "pending") {
    return { handled: true, duplicate: false };
  }
  const sessionId = validateNonEmptyString(data.checkout_session_id, "checkout session id");
  const cleanupLateCustomer = data.customer_cleanup_pending === true;
  if (data.status === "succeeded") {
    const summary = await inspectPaymentIntentRefunds(stripe, paymentIntentId, refundId);
    await recordObservedSucceededRefunds(
      supabase,
      sessionId,
      event.id,
      paymentIntentId,
      summary.succeededRefunds,
    );
    if (summary.succeededCents + amountCents >= Number(data.amount_cents)) {
      await markCheckoutRefunded(supabase, sessionId, event.id);
      if (cleanupLateCustomer) {
        await completeLateCustomerCleanup(supabase, stripe, sessionId);
      }
      return { handled: true, duplicate: false, reconciliation: "deletion_race_refunded" };
    }
    if (summary.hasNonterminal) {
      throw refundReconciliationError(
        "refund_incomplete",
        "The PaymentIntent still has another nonterminal Refund",
        { eventId: event.id, eventType: event.type, sessionId },
      );
    }
    await recordCheckoutRefundFailure(supabase, sessionId, event.id, refundId, "partial");
    await performDeletionRefund({
      supabase,
      stripe,
      sessionId,
      eventId: event.id,
      eventType: event.type,
      paymentIntentId,
      amountCents: Number(data.amount_cents),
      cleanupLateCustomer,
      knownSucceededCents: summary.succeededCents + amountCents,
    });
    return { handled: true, duplicate: false, reconciliation: "deletion_race_refunded" };
  }
  if (data.status !== "retry_required") {
    throw databaseError("Invalid Stripe Refund reconciliation status", {
      message: `Unknown refund lifecycle status: ${data.status}`,
    });
  }

  const refundSummary = await inspectPaymentIntentRefunds(stripe, paymentIntentId);
  await recordObservedSucceededRefunds(
    supabase,
    sessionId,
    event.id,
    paymentIntentId,
    refundSummary.succeededRefunds,
  );
  if (refundSummary.succeededCents >= Number(data.amount_cents)) {
    await markCheckoutRefunded(supabase, sessionId, event.id);
    if (cleanupLateCustomer) {
      await completeLateCustomerCleanup(supabase, stripe, sessionId);
    }
    return { handled: true, duplicate: false, reconciliation: "deletion_race_refunded" };
  }
  if (refundSummary.hasNonterminal) {
    throw refundReconciliationError(
      "refund_incomplete",
      "The PaymentIntent still has a nonterminal Refund and is not safe to retry",
      { eventId: event.id, eventType: event.type, sessionId },
    );
  }
  await performDeletionRefund({
    supabase,
    stripe,
    sessionId,
    eventId: event.id,
    eventType: event.type,
    paymentIntentId,
    amountCents: Number(data.amount_cents),
    cleanupLateCustomer,
  });
  return { handled: true, duplicate: false, reconciliation: "deletion_race_refunded" };
}

async function reconcileRefundLifecycleEvent(
  supabase: SupabaseClientLike,
  args: {
    refund_id: string;
    event_id: string;
    refund_status: string | null;
    refund_amount: number | null;
    payment_intent_id: string | null;
  },
): Promise<Record<string, unknown>> {
  const { data, error } = await (supabase.rpc(
    "checkout_lifecycle_reconcile_refund_event",
    args,
  ) as PromiseLike<SupabaseQueryResult<unknown>>);
  if (error !== null) {
    throw databaseError("Failed to reconcile Stripe Refund event", error);
  }
  if (!isRecord(data) || typeof data.status !== "string") {
    throw databaseError("Invalid Stripe Refund reconciliation response", {
      message: "checkout_lifecycle_reconcile_refund_event returned an invalid result",
    });
  }
  return data;
}

// eslint-disable-next-line complexity, max-lines-per-function -- TODO(#57): split the legacy deletion refund flow.
async function performDeletionRefund({
  supabase,
  stripe,
  sessionId,
  eventId,
  eventType,
  paymentIntentId,
  amountCents,
  cleanupLateCustomer,
  knownSucceededCents = 0,
}: {
  supabase: SupabaseClientLike;
  stripe: Pick<StripeClientLike, "customers" | "refunds">;
  sessionId: string;
  eventId: string;
  eventType: string;
  paymentIntentId: string;
  amountCents: number;
  cleanupLateCustomer: boolean;
  knownSucceededCents?: number;
}): Promise<void> {
  const prepared = await (supabase.rpc("checkout_lifecycle_prepare_refund_attempt", {
    checkout_session_id: sessionId,
  }) as PromiseLike<SupabaseQueryResult<unknown>>);
  if (prepared.error !== null) {
    throw databaseError("Failed to prepare Checkout Session refund attempt", prepared.error);
  }
  if (
    !isRecord(prepared.data) ||
    !Number.isSafeInteger(prepared.data.attempt) ||
    Number(prepared.data.attempt) <= 0
  ) {
    throw refundReconciliationError(
      "refund_incomplete",
      "Checkout Session refund state is not recoverable",
      { eventId, eventType, sessionId },
    );
  }
  const attempt = Number(prepared.data.attempt);
  const mustCleanupCustomer =
    cleanupLateCustomer || prepared.data.customer_cleanup_pending === true;
  let refundId: string;
  if (prepared.data.action === "attached") {
    refundId = validateNonEmptyString(prepared.data.refund_id, "refund id");
  } else if (prepared.data.action === "create") {
    const summary = await inspectPaymentIntentRefunds(stripe, paymentIntentId);
    await recordObservedSucceededRefunds(
      supabase,
      sessionId,
      eventId,
      paymentIntentId,
      summary.succeededRefunds,
    );
    if (summary.hasNonterminal) {
      throw refundReconciliationError(
        "refund_incomplete",
        "The PaymentIntent still has a nonterminal Refund and is not safe to retry",
        { eventId, eventType, sessionId },
      );
    }
    const succeededCents = Math.max(summary.succeededCents, knownSucceededCents);
    const remainingCents = amountCents - succeededCents;
    if (remainingCents <= 0) {
      await markCheckoutRefunded(supabase, sessionId, eventId);
      if (mustCleanupCustomer) {
        await completeLateCustomerCleanup(supabase, stripe, sessionId);
      }
      return;
    }
    let createdRefund: StripeRefundLike;
    try {
      createdRefund = await stripe.refunds.create(
        { payment_intent: paymentIntentId, amount: remainingCents },
        { idempotencyKey: `checkout-deletion:${sessionId}:attempt:${attempt}` },
      );
    } catch (error) {
      if (!isStripeAlreadyRefundedError(error)) {
        throw error;
      }
      const summary = await inspectPaymentIntentRefunds(stripe, paymentIntentId);
      if (summary.succeededCents < amountCents) {
        throw error;
      }
      await recordObservedSucceededRefunds(
        supabase,
        sessionId,
        eventId,
        paymentIntentId,
        summary.succeededRefunds,
      );
      await markCheckoutRefunded(supabase, sessionId, eventId);
      if (mustCleanupCustomer) {
        await completeLateCustomerCleanup(supabase, stripe, sessionId);
      }
      return;
    }
    refundId = validateNonEmptyString(createdRefund.id, "refund id");
    const recorded = await (supabase.rpc("checkout_lifecycle_record_refund_attempt", {
      checkout_session_id: sessionId,
      event_id: eventId,
      refund_id: refundId,
      attempt,
      amount_cents: remainingCents,
    }) as PromiseLike<SupabaseQueryResult<unknown>>);
    if (recorded.error !== null) {
      throw databaseError("Failed to record Checkout Session refund attempt", recorded.error);
    }
  } else {
    throw databaseError("Invalid Checkout Session refund preparation response", {
      message: "checkout_lifecycle_prepare_refund_attempt returned an unknown action",
    });
  }

  const refund = await stripe.refunds.retrieve(refundId);
  const refundStatus = validateNonEmptyString(refund.status, "refund status");
  const reconciliation = await reconcileRefundLifecycleEvent(supabase, {
    refund_id: refundId,
    event_id: eventId,
    refund_status: refundStatus,
    refund_amount: refund.amount,
    payment_intent_id: paymentIntentId,
  });
  if (refundStatus === "failed" || refundStatus === "canceled") {
    if (reconciliation.status !== "retry_required") {
      throw databaseError("Invalid terminal Stripe Refund reconciliation", {
        message: `Expected retry_required, received ${String(reconciliation.status)}`,
      });
    }
    throw refundReconciliationError(
      "refund_terminal_failure",
      `The deletion-race refund reached terminal status ${refundStatus}`,
      { eventId, eventType, sessionId },
    );
  }
  if (refundStatus !== "succeeded") {
    if (reconciliation.status !== "pending") {
      throw databaseError("Invalid pending Stripe Refund reconciliation", {
        message: `Expected pending, received ${String(reconciliation.status)}`,
      });
    }
    throw refundReconciliationError(
      "refund_incomplete",
      "The deletion-race refund has not succeeded",
      { eventId, eventType, sessionId },
    );
  }
  if (reconciliation.status !== "succeeded") {
    throw databaseError("Invalid succeeded Stripe Refund reconciliation", {
      message: `Expected succeeded, received ${String(reconciliation.status)}`,
    });
  }
  const otherRefunds = await inspectPaymentIntentRefunds(stripe, paymentIntentId, refundId);
  await recordObservedSucceededRefunds(
    supabase,
    sessionId,
    eventId,
    paymentIntentId,
    otherRefunds.succeededRefunds,
  );
  const cumulativeSucceededCents = Math.max(
    otherRefunds.succeededCents + refund.amount,
    knownSucceededCents + refund.amount,
  );
  if (cumulativeSucceededCents < amountCents) {
    await recordCheckoutRefundFailure(supabase, sessionId, eventId, refundId, "partial");
    return performDeletionRefund({
      supabase,
      stripe,
      sessionId,
      eventId,
      eventType,
      paymentIntentId,
      amountCents,
      cleanupLateCustomer: mustCleanupCustomer,
      knownSucceededCents: cumulativeSucceededCents,
    });
  }
  await markCheckoutRefunded(supabase, sessionId, eventId);
  if (mustCleanupCustomer) {
    await completeLateCustomerCleanup(supabase, stripe, sessionId);
  }
}

async function reconcileCheckoutCompletion(
  supabase: SupabaseClientLike,
  args: CheckoutCompletionReconciliationArgs,
): Promise<CheckoutCompletionReconciliation> {
  const { data, error } = await (supabase.rpc(
    "checkout_lifecycle_reconcile_completion",
    args,
  ) as PromiseLike<SupabaseQueryResult<string>>);
  if (error !== null) {
    throw databaseError("Failed to reconcile Checkout Session completion", error);
  }
  if (
    data === "credited" ||
    data === "refund" ||
    data === "refunded" ||
    data === "refund_missing_user" ||
    data === "refunded_cleanup_pending" ||
    data === "duplicate"
  ) {
    return data;
  }

  throw databaseError("Invalid Checkout Session reconciliation response", {
    message: "checkout_lifecycle_reconcile_completion returned an unknown result",
  });
}

async function markCheckoutRefunded(
  supabase: SupabaseClientLike,
  sessionId: string,
  eventId: string,
): Promise<void> {
  const { error } = await (supabase.rpc("checkout_lifecycle_mark_refunded", {
    checkout_session_id: sessionId,
    event_id: eventId,
  }) as PromiseLike<SupabaseQueryResult<unknown>>);
  if (error !== null) {
    throw databaseError("Failed to mark Checkout Session refunded", error);
  }
}

async function completeLateCustomerCleanup(
  supabase: SupabaseClientLike,
  stripe: Pick<StripeClientLike, "customers">,
  sessionId: string,
): Promise<void> {
  const cleanupResult = await (supabase.rpc("checkout_lifecycle_get_customer_cleanup", {
    checkout_session_id: sessionId,
  }) as PromiseLike<SupabaseQueryResult<unknown>>);
  if (cleanupResult.error !== null) {
    throw databaseError("Failed to read late Stripe customer cleanup", cleanupResult.error);
  }
  if (cleanupResult.data === null) {
    return;
  }
  if (isRecord(cleanupResult.data) && cleanupResult.data.pending === false) {
    return;
  }
  if (
    !isRecord(cleanupResult.data) ||
    cleanupResult.data.pending !== true ||
    (
      cleanupResult.data.customer_id !== null &&
      typeof cleanupResult.data.customer_id !== "string"
    )
  ) {
    throw databaseError("Invalid late Stripe customer cleanup response", {
      message: "checkout_lifecycle_get_customer_cleanup returned an invalid result",
    });
  }
  const customerId = cleanupResult.data.customer_id;
  if (customerId !== null) {
    try {
      await stripe.customers.del(customerId);
    } catch (error) {
      if (!isStripeResourceMissingError(error)) {
        throw error;
      }
    }
  }
  const { error } = await (supabase.rpc("checkout_lifecycle_complete_customer_cleanup", {
    checkout_session_id: sessionId,
  }) as PromiseLike<SupabaseQueryResult<unknown>>);
  if (error !== null) {
    throw databaseError("Failed to complete late Stripe customer cleanup", error);
  }
}

async function recordCheckoutRefundFailure(
  supabase: SupabaseClientLike,
  sessionId: string,
  eventId: string,
  refundId: string,
  failureStatus: "failed" | "canceled" | "partial",
): Promise<void> {
  const { error } = await (supabase.rpc("checkout_lifecycle_record_refund_failure", {
    checkout_session_id: sessionId,
    event_id: eventId,
    refund_id: refundId,
    failure_status: failureStatus,
  }) as PromiseLike<SupabaseQueryResult<unknown>>);
  if (error !== null) {
    throw databaseError("Failed to record terminal Checkout Session refund failure", error);
  }
}

async function recordObservedSucceededRefunds(
  supabase: SupabaseClientLike,
  sessionId: string,
  eventId: string,
  paymentIntentId: string,
  refunds: StripeRefundLike[],
): Promise<void> {
  for (const refund of refunds) {
    const { error } = await (supabase.rpc("checkout_lifecycle_record_observed_refund", {
      checkout_session_id: sessionId,
      event_id: eventId,
      refund_id: validateNonEmptyString(refund.id, "refund id"),
      amount_cents: validateCheckoutAmount(refund.amount),
      payment_intent_id: paymentIntentId,
    }) as PromiseLike<SupabaseQueryResult<unknown>>);
    if (error !== null) {
      throw databaseError("Failed to record observed succeeded Stripe Refund", error);
    }
  }
}

async function inspectPaymentIntentRefunds(
  stripe: Pick<StripeClientLike, "refunds">,
  paymentIntentId: string,
  excludeRefundId?: string,
): Promise<{
  succeededCents: number;
  succeededRefunds: StripeRefundLike[];
  hasNonterminal: boolean;
}> {
  let succeededCents = 0;
  const succeededRefunds: StripeRefundLike[] = [];
  let hasNonterminal = false;
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.refunds.list({
      payment_intent: paymentIntentId,
      limit: 100,
      ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
    });
    for (const refund of page.data) {
      if (refund.id === excludeRefundId) {
        continue;
      }
      if (refund.status === "succeeded" && Number.isSafeInteger(refund.amount) && refund.amount > 0) {
        succeededCents += refund.amount;
        succeededRefunds.push(refund);
      } else if (refund.status !== "failed" && refund.status !== "canceled") {
        hasNonterminal = true;
      }
    }
    if (!page.has_more) {
      return { succeededCents, succeededRefunds, hasNonterminal };
    }
    const lastRefund = page.data.at(-1);
    if (lastRefund === undefined) {
      return { succeededCents, succeededRefunds, hasNonterminal };
    }
    startingAfter = lastRefund.id;
  }
}

async function recordStripeEventBestEffort(
  supabase: SupabaseClientLike,
  event: StripeEventLike,
): Promise<void> {
  // The money-path effect already committed; recording the event is best-effort.
  // A 23505 unique-violation is the expected duplicate and is silently ignorable;
  // every other swallowed failure is logged so a lost idempotency record is visible.
  try {
    const { error } = await (supabase.from("stripe_events") as SupabaseQueryBuilderLike)
      .insert({
        event_id: event.id,
        type: event.type,
      });
    if (error !== null && error.code !== "23505") {
      logMoneyPathError({
        operation: "record_stripe_event",
        event_id: event.id,
        event_type: event.type,
        error_code: error.code ?? null,
      });
    }
  } catch (error) {
    logMoneyPathError({
      operation: "record_stripe_event",
      event_id: event.id,
      event_type: event.type,
      error_code: errorCode(error),
    });
  }
}

async function recordUnrecognizedStripeEvent(
  supabase: SupabaseClientLike,
  event: StripeEventLike,
): Promise<ProcessStripeEventResult> {
  const { error } = await (supabase.from("stripe_events") as SupabaseQueryBuilderLike)
    .insert({
      event_id: event.id,
      type: event.type,
    });
  if (error !== null) {
    if (isUniqueViolation(error)) {
      return { handled: false, duplicate: true };
    }

    throw databaseError("Failed to record Stripe event", error);
  }

  return { handled: false, duplicate: false };
}

function toCreditLedgerEntry(row: CreditLedgerRow): CreditLedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    amountCents: row.amount_cents,
    kind: row.kind,
    description: row.description,
    stripeEventId: row.stripe_event_id,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    metadata: toBillingMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

function isCheckoutMoneyEvent(type: string): boolean {
  return (
    type === "checkout.session.completed" ||
    type === "checkout.session.async_payment_succeeded"
  );
}

function assertStripeEvent(event: StripeEventLike): void {
  validateNonEmptyString(event.id, "event.id");
  validateNonEmptyString(event.type, "event.type");
  if (!isRecord(event.data) || !("object" in event.data)) {
    throw new BillingError("invalid_stripe_event", "Stripe event is missing data.object");
  }
}

function getObject<T>(event: StripeEventLike): T {
  if (!isRecord(event.data.object)) {
    throw new BillingError("invalid_stripe_event_object", "Stripe event object must be an object");
  }

  return event.data.object as T;
}

function readStripeObjectId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) {
    return value.id;
  }

  return null;
}

function validateUuid(value: unknown, field: string): string {
  const text = validateNonEmptyString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw new BillingError("invalid_user_id", `${field} must be a uuid`);
  }

  return text;
}

function validateNonEmptyString(value: unknown, field: string): string {

  if (typeof value !== "string" || value.length === 0) {
    throw new BillingError("invalid_string", `${field} must be a non-empty string`);
  }

  return value;
}

function isStripeAlreadyRefundedError(error: unknown): boolean {
  return isRecord(error) && error.code === "charge_already_refunded";
}

function isStripeResourceMissingError(error: unknown): boolean {
  return isRecord(error) && error.code === "resource_missing";
}

function validateCheckoutAmount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_CHECKOUT_AMOUNT_CENTS
  ) {
    throw new BillingError(
      "invalid_checkout_amount",
      "checkout session amount_total must be a positive integer at or below 100000",
    );
  }

  return value;
}

function validatePositiveInteger(value: unknown, field: string, code: BillingErrorCode): number {
  const amount = typeof value === "string" ? Number(value.trim()) : value;
  if (
    !Number.isSafeInteger(amount) ||
    typeof amount !== "number" ||
    amount <= 0 ||
    (typeof value === "string" && !/^\d+$/.test(value.trim()))
  ) {
    throw new BillingError(code, `${field} must be a positive integer`);
  }

  return amount;
}

function toBillingMetadata(value: unknown): BillingMetadata {
  if (!isRecord(value)) {
    return {};
  }

  return compactMetadata(value);
}

function compactMetadata(value: Record<string, unknown>): BillingMetadata {
  const metadata: BillingMetadata = {};
  for (const [key, item] of Object.entries(value)) {
    if (isBillingJson(item)) {
      metadata[key] = item;
    }
  }

  return metadata;
}

function isBillingJson(value: unknown): value is BillingJson {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isBillingJson);
  }

  if (isRecord(value)) {
    return Object.values(value).every(isBillingJson);
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueViolation(error: SupabaseErrorLike): boolean {
  return error.code === "23505" || /duplicate key/i.test(error.message);
}

function databaseError(message: string, cause: SupabaseErrorLike): BillingError {
  return new BillingError("database_error", message, { cause });
}

function refundReconciliationError(
  code: Extract<BillingErrorCode, "refund_incomplete" | "refund_terminal_failure">,
  message: string,
  context: { eventId: string; eventType: string; sessionId: string },
): BillingError {
  logMoneyPathError({
    operation: "refund_reconciliation",
    event_id: context.eventId,
    event_type: context.eventType,
    checkout_session_id: context.sessionId,
    error_code: code,
  });
  return new BillingError(code, message);
}

function logMoneyPathError(fields: {
  operation: string;
  event_id?: string;
  event_type?: string;
  checkout_session_id?: string;
  error_code?: string | null;
}): void {
  // Structured, secret-free money-path diagnostics: only ids and error codes are
  // emitted — never tokens, Stripe secrets, or request/response bodies.
  console.error(JSON.stringify({ scope: "billing", ...fields }));
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && error.code.length > 0) {
    return error.code;
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return "unknown";
}
