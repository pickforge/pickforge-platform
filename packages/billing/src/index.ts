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

export interface StripeClientLike {
  checkout: {
    sessions: {
      create<TSession = unknown>(params: StripeCheckoutSessionCreateParams): Promise<TSession>;
    };
  };
  refunds: {
    create(
      params: { payment_intent: string },
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
  stripe: Pick<StripeClientLike, "refunds">;
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
}: CreateCreditCheckoutSessionOptions): Promise<TSession> {
  const validUserId = validateUuid(userId, "userId");
  const validPriceId = validateNonEmptyString(priceId, "priceId");
  const validSuccessUrl = validateNonEmptyString(successUrl, "successUrl");
  const validCancelUrl = validateNonEmptyString(cancelUrl, "cancelUrl");
  const customer = typeof existingCustomerId === "string" && existingCustomerId.trim().length > 0 ? existingCustomerId : undefined;

  return stripe.checkout.sessions.create<TSession>({
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
  });
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
  if (reconciliation === "refund") {
    let createdRefund: StripeRefundLike;
    try {
      createdRefund = await stripe.refunds.create(
        { payment_intent: paymentIntentId },
        { idempotencyKey: `checkout-deletion:${sessionId}` },
      );
    } catch (error) {
      if (
        !isStripeAlreadyRefundedError(error) ||
        !(await isPaymentIntentFullyRefunded(stripe, paymentIntentId, amountCents))
      ) {
        throw error;
      }
      await markCheckoutRefunded(supabase, sessionId, event.id);
      return {
        handled: true,
        duplicate: false,
        reconciliation: "deletion_race_refunded",
      };
    }

    const refundId = validateNonEmptyString(createdRefund.id, "refund id");
    const refund = await stripe.refunds.retrieve(refundId);
    if (refund.status === "failed" || refund.status === "canceled") {
      await recordCheckoutRefundFailure(supabase, sessionId, event.id, refundId, refund.status);
      throw new BillingError(
        "refund_terminal_failure",
        `The deletion-race refund reached terminal status ${refund.status}`,
      );
    }
    if (refund.status !== "succeeded") {
      throw new BillingError(
        "refund_incomplete",
        "The deletion-race refund has not succeeded",
      );
    }
    await markCheckoutRefunded(supabase, sessionId, event.id);
    return {
      handled: true,
      duplicate: false,
      reconciliation: "deletion_race_refunded",
    };
  }

  return { handled: true, duplicate: false };
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

async function recordCheckoutRefundFailure(
  supabase: SupabaseClientLike,
  sessionId: string,
  eventId: string,
  refundId: string,
  failureStatus: "failed" | "canceled",
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

async function isPaymentIntentFullyRefunded(
  stripe: Pick<StripeClientLike, "refunds">,
  paymentIntentId: string,
  amountCents: number,
): Promise<boolean> {
  let refundedCents = 0;
  let startingAfter: string | undefined;

  for (;;) {
    const page = await stripe.refunds.list({
      payment_intent: paymentIntentId,
      limit: 100,
      ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
    });
    for (const refund of page.data) {
      if (refund.status === "succeeded" && Number.isSafeInteger(refund.amount) && refund.amount > 0) {
        refundedCents += refund.amount;
      }
    }
    if (refundedCents >= amountCents) {
      return true;
    }
    if (!page.has_more) {
      return false;
    }
    const lastRefund = page.data.at(-1);
    if (lastRefund === undefined) {
      return false;
    }
    startingAfter = lastRefund.id;
  }
}

async function recordStripeEventBestEffort(
  supabase: SupabaseClientLike,
  event: StripeEventLike,
): Promise<void> {
  try {
    await (supabase.from("stripe_events") as SupabaseQueryBuilderLike)
      .insert({
        event_id: event.id,
        type: event.type,
      });
  } catch {
    return;
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
