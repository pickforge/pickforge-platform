import { describe, expect, it, vi } from "vitest";
import {
  BillingError,
  createCreditCheckoutSession,
  getCreditBalanceCents,
  listLedgerEntries,
  processStripeEvent,
  verifyStripeEvent,
  type StripeClientLike,
  type StripeEventLike,
  type StripeRefundLike,
  type SupabaseClientLike,
  type SupabaseErrorLike,
  type SupabaseQueryBuilderLike,
  type SupabaseQueryResult,
} from "../src/index.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("@pickforge/billing", () => {
  it("verifies Stripe webhook events through the injected client", async () => {
    const event = checkoutSessionEvent();
    const stripe = fakeStripe({ event });

    await expect(
      verifyStripeEvent({
        payload: "{}",
        signature: "sig",
        secret: "secret",
        stripe,
      }),
    ).resolves.toBe(event);

    expect(stripe.webhooks.constructEventAsync).toHaveBeenCalledWith("{}", "sig", "secret");
  });

  it("ignores untracked Refunds before validating checkout-specific fields", async () => {
    const supabase = new MemorySupabase();

    await expect(processStripeEvent({
      supabase,
      stripe: fakeStripe(),
      event: refundEvent({
        refundId: "re_untracked",
        amount: 100_001,
        paymentIntent: null,
      }),
    })).resolves.toEqual({ handled: false, duplicate: false });
  });

  it("uses durable cleanup state even when reconciliation returns ordinary refund", async () => {
    const supabase = new MemorySupabase();
    supabase.fencedUsers.add(USER_ID);
    supabase.customerCleanupPending.add("cs_durable_cleanup");
    supabase.cleanupCustomerIds.set("cs_durable_cleanup", "cus_durable_cleanup");
    const stripe = fakeStripe();

    await expect(processStripeEvent({
      supabase,
      stripe,
      event: checkoutSessionEvent({ sessionId: "cs_durable_cleanup" }),
    })).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });

    expect(stripe.customers.del).toHaveBeenCalledWith("cus_durable_cleanup");
    expect(supabase.customerCleanupPending.has("cs_durable_cleanup")).toBe(false);
  });

  it("continues automatically when a signed succeeded Refund leaves a shortfall", async () => {
    const supabase = new MemorySupabase();
    supabase.lifecycleSessions.set("cs_signed_partial", "refund_pending");
    supabase.seedRefundAttempt("cs_signed_partial", {
      attempt: 1,
      refundId: "re_signed_partial",
      amountCents: 400,
      status: "pending",
    });
    const stripe = fakeStripe();
    const partial = { id: "re_signed_partial", amount: 400, status: "succeeded" };
    const remaining = { id: "re_signed_remaining", amount: 600, status: "succeeded" };
    stripe.refunds.list
      .mockResolvedValueOnce({ data: [partial], has_more: false })
      .mockResolvedValueOnce({ data: [partial], has_more: false })
      .mockResolvedValueOnce({ data: [partial, remaining], has_more: false });
    stripe.refunds.create.mockResolvedValue(remaining);
    stripe.refunds.retrieve.mockResolvedValue(remaining);

    await expect(processStripeEvent({
      supabase,
      stripe,
      event: refundEvent({
        refundId: "re_signed_partial",
        amount: 400,
        status: "succeeded",
      }),
    })).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_123", amount: 600 },
      { idempotencyKey: "checkout-deletion:cs_signed_partial:attempt:2" },
    );
    expect(supabase.lifecycleSessions.get("cs_signed_partial")).toBe("refunded");
  });

  it("replaces coverage when an earlier partial Refund reverses", async () => {
    const supabase = new MemorySupabase();
    supabase.lifecycleSessions.set("cs_superseded_reversal", "refunded");
    supabase.lifecycleAmounts.set("cs_superseded_reversal", 1000);
    supabase.seedRefundAttempt("cs_superseded_reversal", {
      attempt: 1,
      refundId: "re_partial_a",
      amountCents: 400,
      status: "succeeded",
    });
    supabase.seedRefundAttempt("cs_superseded_reversal", {
      attempt: 2,
      refundId: "re_partial_b",
      amountCents: 600,
      status: "succeeded",
    });
    const stripe = fakeStripe();
    const partialA = { id: "re_partial_a", amount: 400, status: "failed" };
    const partialB = { id: "re_partial_b", amount: 600, status: "succeeded" };
    const replacement = { id: "re_replacement_c", amount: 400, status: "succeeded" };
    stripe.refunds.list
      .mockResolvedValueOnce({ data: [partialA, partialB], has_more: false })
      .mockResolvedValueOnce({ data: [partialA, partialB], has_more: false })
      .mockResolvedValue({ data: [partialA, partialB, replacement], has_more: false });
    stripe.refunds.create.mockResolvedValue(replacement);
    stripe.refunds.retrieve.mockResolvedValue(replacement);
    const event = refundEvent({
      refundId: "re_partial_a",
      amount: 400,
      status: "failed",
      type: "refund.failed",
    });

    await expect(processStripeEvent({ supabase, stripe, event })).resolves.toMatchObject({
      reconciliation: "deletion_race_refunded",
    });

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_123", amount: 400 },
      { idempotencyKey: "checkout-deletion:cs_superseded_reversal:attempt:3" },
    );
    expect(supabase.lifecycleSessions.get("cs_superseded_reversal")).toBe("refunded");
    expect(supabase.refundHistory.get("cs_superseded_reversal")?.get(3)).toMatchObject({
      refundId: "re_replacement_c",
      amountCents: 400,
      status: "succeeded",
    });

    await expect(processStripeEvent({ supabase, stripe, event })).resolves.toEqual({
      handled: false,
      duplicate: false,
    });
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("reopens a formerly succeeded Refund that later fails and compensates again", async () => {
    const supabase = new MemorySupabase();
    supabase.deletedUsers.add(USER_ID);
    supabase.lifecycleSessions.set("cs_late_failure", "refunded");
    supabase.seedRefundAttempt("cs_late_failure", {
      attempt: 1,
      refundId: "re_late_failure",
      amountCents: 1000,
      status: "succeeded",
    });
    const stripe = fakeStripe();
    stripe.refunds.create.mockResolvedValue({
      id: "re_late_recovery",
      amount: 1000,
      status: "succeeded",
    });
    stripe.refunds.retrieve.mockResolvedValue({
      id: "re_late_recovery",
      amount: 1000,
      status: "succeeded",
    });

    await expect(processStripeEvent({
      supabase,
      stripe,
      event: refundEvent({
        refundId: "re_late_failure",
        status: "failed",
        type: "refund.failed",
      }),
    })).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_123", amount: 1000 },
      { idempotencyKey: "checkout-deletion:cs_late_failure:attempt:2" },
    );
    expect(supabase.lifecycleSessions.get("cs_late_failure")).toBe("refunded");
  });

  it("lets Stripe retry after a non-unique ledger failure and creates exactly one ledger row", async () => {
    const supabase = new MemorySupabase();
    supabase.failNextInsert("credit_ledger", transientDatabaseError());
    const event = checkoutSessionEvent();

    await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).rejects.toMatchObject({
      code: "database_error",
    } satisfies Partial<BillingError>);
    await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
      handled: true,
      duplicate: false,
    });

    expect(supabase.tables.credit_ledger).toHaveLength(1);
    expect(supabase.tables.stripe_events).toHaveLength(1);
  });

  it("does not mint credits for completed sessions that are not paid", async () => {
    const supabase = new MemorySupabase();

    await expect(
      processStripeEvent({ supabase, stripe: fakeStripe(), event: checkoutSessionEvent({ paymentStatus: "unpaid" }) }),
    ).resolves.toEqual({ handled: false, duplicate: false });

    expect(supabase.tables.credit_ledger).toHaveLength(0);
  });

  it("requires payment_intent on paid credit-pack Checkout Sessions", async () => {
    const supabase = new MemorySupabase();
    const stripe = fakeStripe();

    await expect(
      processStripeEvent({
        supabase,
        stripe,
        event: checkoutSessionEvent({ paymentIntent: undefined }),
      }),
    ).rejects.toMatchObject({ code: "invalid_string" });

    expect(supabase.tables.credit_ledger).toHaveLength(0);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["negative", -1],
    ["over cap", 100_001],
  ])("rejects %s checkout amount_total", async (_name, amountTotal) => {
    const supabase = new MemorySupabase();

    await expect(
      processStripeEvent({ supabase, stripe: fakeStripe(), event: checkoutSessionEvent({ amountTotal }) }),
    ).rejects.toMatchObject({
      code: "invalid_checkout_amount",
    } satisfies Partial<BillingError>);

    expect(supabase.tables.credit_ledger).toHaveLength(0);
    expect(supabase.tables.stripe_events).toHaveLength(0);
  });

  it("logs and swallows a non-unique post-effect stripe_events failure without losing or duplicating ledger rows", async () => {
    const supabase = new MemorySupabase();
    supabase.failNextInsert("stripe_events", transientDatabaseError());
    const event = checkoutSessionEvent();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
        handled: true,
        duplicate: false,
      });
      await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
        handled: false,
        duplicate: true,
      });

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(JSON.parse(consoleError.mock.calls[0]![0] as string)).toEqual({
        scope: "billing",
        operation: "record_stripe_event",
        event_id: "evt_checkout",
        event_type: "checkout.session.completed",
        error_code: "XX000",
      });
    } finally {
      consoleError.mockRestore();
    }

    expect(supabase.tables.credit_ledger).toHaveLength(1);
    expect(supabase.tables.stripe_events).toEqual([
      expect.objectContaining({
        event_id: "evt_checkout",
      }),
    ]);
  });

  it("silently ignores a 23505 unique-violation when recording the post-effect stripe_events row", async () => {
    const supabase = new MemorySupabase();
    supabase.failNextInsert("stripe_events", { code: "23505", message: "duplicate key value" });
    const event = checkoutSessionEvent();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
        handled: true,
        duplicate: false,
      });

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }

    expect(supabase.tables.credit_ledger).toHaveLength(1);
  });

  it("uses stripe_events as the dedupe record for unknown events", async () => {
    const supabase = new MemorySupabase();
    const event: StripeEventLike = {
      id: "evt_unknown",
      type: "customer.created",
      data: { object: { id: "cus_123" } },
    };

    await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
      handled: false,
      duplicate: false,
    });
    await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
      handled: false,
      duplicate: true,
    });

    expect(supabase.tables.stripe_events).toHaveLength(1);
    expect(supabase.tables.credit_ledger).toHaveLength(0);
  });

  it("creates payment checkout sessions with a persistent customer request and a deterministic idempotency key", async () => {
    const stripe = fakeStripe();

    await createCreditCheckoutSession({
      stripe,
      userId: USER_ID,
      priceId: "price_123",
      successUrl: "https://pickforge.dev/success",
      cancelUrl: "https://pickforge.dev/cancel",
      requestId: "req_first",
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      {
        mode: "payment",
        customer_creation: "always",
        client_reference_id: USER_ID,
        line_items: [{ price: "price_123", quantity: 1 }],
        success_url: "https://pickforge.dev/success",
        cancel_url: "https://pickforge.dev/cancel",
      },
      { idempotencyKey: `checkout-session:${USER_ID}:req_first` },
    );
  });

  it("reuses an existing Stripe customer for repeat credit purchases", async () => {
    const stripe = fakeStripe();

    await createCreditCheckoutSession({
      stripe,
      userId: USER_ID,
      priceId: "price_123",
      successUrl: "https://pickforge.dev/success",
      cancelUrl: "https://pickforge.dev/cancel",
      existingCustomerId: "cus_123",
      requestId: "req_repeat",
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      {
        mode: "payment",
        customer: "cus_123",
        client_reference_id: USER_ID,
        line_items: [{ price: "price_123", quantity: 1 }],
        success_url: "https://pickforge.dev/success",
        cancel_url: "https://pickforge.dev/cancel",
      },
      { idempotencyKey: `checkout-session:${USER_ID}:req_repeat` },
    );
  });

  it("reuses one idempotency key across retries of a purchase attempt but never across distinct purchases", async () => {
    const stripe = fakeStripe();

    await createCreditCheckoutSession({
      stripe,
      userId: USER_ID,
      priceId: "price_123",
      successUrl: "https://pickforge.dev/success",
      cancelUrl: "https://pickforge.dev/cancel",
      requestId: "attempt_a",
    });
    await createCreditCheckoutSession({
      stripe,
      userId: USER_ID,
      priceId: "price_123",
      successUrl: "https://pickforge.dev/success",
      cancelUrl: "https://pickforge.dev/cancel",
      requestId: "attempt_a",
    });
    await createCreditCheckoutSession({
      stripe,
      userId: USER_ID,
      priceId: "price_123",
      successUrl: "https://pickforge.dev/success",
      cancelUrl: "https://pickforge.dev/cancel",
      requestId: "attempt_b",
    });

    const keys = stripe.checkout.sessions.create.mock.calls.map(([, options]) => options.idempotencyKey);
    expect(keys).toEqual([
      `checkout-session:${USER_ID}:attempt_a`,
      `checkout-session:${USER_ID}:attempt_a`,
      `checkout-session:${USER_ID}:attempt_b`,
    ]);
  });

  it("generates a fresh non-colliding idempotency key when no requestId is supplied", async () => {
    const stripe = fakeStripe();

    await createCreditCheckoutSession({
      stripe,
      userId: USER_ID,
      priceId: "price_123",
      successUrl: "https://pickforge.dev/success",
      cancelUrl: "https://pickforge.dev/cancel",
    });
    await createCreditCheckoutSession({
      stripe,
      userId: USER_ID,
      priceId: "price_123",
      successUrl: "https://pickforge.dev/success",
      cancelUrl: "https://pickforge.dev/cancel",
    });

    const [firstKey, secondKey] = stripe.checkout.sessions.create.mock.calls.map(
      ([, options]) => options.idempotencyKey,
    );
    expect(firstKey).toMatch(new RegExp(`^checkout-session:${USER_ID}:[0-9a-f-]{36}$`));
    expect(secondKey).toMatch(new RegExp(`^checkout-session:${USER_ID}:[0-9a-f-]{36}$`));
    expect(firstKey).not.toBe(secondKey);
  });

  it("reads balances through the credit_balance_cents rpc", async () => {
    const supabase = new MemorySupabase();
    await processStripeEvent({ supabase, stripe: fakeStripe(), event: checkoutSessionEvent() });

    await expect(getCreditBalanceCents({ supabase, userId: USER_ID })).resolves.toBe(1000);
  });

  it("lists ledger entries newest first with an optional limit", async () => {
    const supabase = new MemorySupabase();
    await processStripeEvent({ supabase, stripe: fakeStripe(), event: checkoutSessionEvent({ id: "evt_old", sessionId: "cs_old", amountTotal: 1000 }) });
    await processStripeEvent({ supabase, stripe: fakeStripe(), event: checkoutSessionEvent({ id: "evt_new", sessionId: "cs_new", amountTotal: 2500 }) });

    await expect(listLedgerEntries({ supabase, userId: USER_ID, limit: 1 })).resolves.toEqual([
      expect.objectContaining({
        amountCents: 2500,
        kind: "purchase",
        stripeEventId: "evt_new",
      }),
    ]);
  });
});

function checkoutSessionEvent(
  overrides: Partial<{
    amountTotal: unknown;
    customer: unknown;
    id: string;
    paymentIntent: unknown;
    paymentStatus: string;
    sessionId: string;
    type: string;
  }> = {},
): StripeEventLike {
  const session: Record<string, unknown> = {
    id: overrides.sessionId ?? "cs_123",
    amount_total: "amountTotal" in overrides ? overrides.amountTotal : 1000,
    customer: "customer" in overrides ? overrides.customer : "cus_123",
    client_reference_id: USER_ID,
    payment_status: overrides.paymentStatus ?? "paid",
    payment_intent: "paymentIntent" in overrides ? overrides.paymentIntent : "pi_123",
  };

  return {
    id: overrides.id ?? "evt_checkout",
    type: overrides.type ?? "checkout.session.completed",
    data: {
      object: session,
    },
  };
}

function refundEvent(overrides: {
  refundId?: string;
  status?: string;
  amount?: number;
  paymentIntent?: unknown;
  type?: string;
} = {}): StripeEventLike {
  return {
    id: `evt_${overrides.refundId ?? "refund"}`,
    type: overrides.type ?? "refund.updated",
    data: {
      object: {
        id: overrides.refundId ?? "re_123",
        amount: overrides.amount ?? 1000,
        status: overrides.status ?? "succeeded",
        payment_intent: "paymentIntent" in overrides ? overrides.paymentIntent : "pi_123",
      },
    },
  };
}

function fakeStripe(options: { event?: StripeEventLike } = {}) {
  return {
    checkout: {
      sessions: {
        create: vi.fn(async (params, _options: { idempotencyKey: string }) => ({
          id: "cs_created",
          ...params,
        })),
      },
    },
    customers: {
      del: vi.fn(async () => ({})),
    },
    refunds: {
      create: vi.fn(async () => ({ id: "re_123", amount: 1000, status: "succeeded" })),
      retrieve: vi.fn(async (refundId: string) => ({ id: refundId, amount: 1000, status: "succeeded" })),
      list: vi.fn(async () => ({ data: [] as StripeRefundLike[], has_more: false })),
    },
    webhooks: {
      constructEventAsync: vi.fn(async () => options.event ?? checkoutSessionEvent()),
    },
  } satisfies StripeClientLike;
}

interface Tables {
  billing_customers: Array<Record<string, unknown>>;
  credit_ledger: Array<Record<string, unknown>>;
  stripe_events: Array<Record<string, unknown>>;
}

interface RefundAttemptState {
  attempt: number;
  refundId: string;
  amountCents: number;
  status: "pending" | "succeeded" | "failed" | "canceled";
}

class MemorySupabase implements SupabaseClientLike {
  readonly tables: Tables = {
    billing_customers: [],
    credit_ledger: [],
    stripe_events: [],
  };
  readonly fencedUsers = new Set<string>();
  readonly finalizedUsers = new Set<string>();
  readonly deletedUsers = new Set<string>();
  readonly lifecycleSessions = new Map<
    string,
    "open" | "expired" | "payment_failed" | "completed" | "refund_pending" | "refunded"
  >();
  readonly lifecycleCustomerIds = new Map<string, string>();
  readonly customerCleanupPending = new Set<string>();
  readonly cleanupCustomerIds = new Map<string, string | null>();
  readonly refundFailures = new Map<string, { refundId: string; status: string }>();
  readonly refundAttempts = new Map<string, number>();
  readonly refundHistory = new Map<string, Map<number, RefundAttemptState>>();
  readonly lifecycleAmounts = new Map<string, number>();
  readonly lifecyclePaymentIntents = new Map<string, string>();
  readonly refundIds = new Map<string, string>();

  private readonly insertFailures: Record<keyof Tables, SupabaseErrorLike[]> = {
    billing_customers: [],
    credit_ledger: [],
    stripe_events: [],
  };

  private idCounter = 0;

  from<T = unknown>(table: string): SupabaseQueryBuilderLike<T> {
    if (!isKnownTable(table)) {
      throw new Error(`Unknown table: ${table}`);
    }

    return new MemoryQuery<T>(this, table);
  }

  seedRefundAttempt(sessionId: string, attempt: RefundAttemptState): void {
    const history = this.refundHistory.get(sessionId) ?? new Map<number, RefundAttemptState>();
    history.set(attempt.attempt, attempt);
    this.refundHistory.set(sessionId, history);
    this.refundAttempts.set(sessionId, Math.max(this.refundAttempts.get(sessionId) ?? 0, attempt.attempt));
    this.refundIds.set(sessionId, attempt.refundId);
  }

  private findRefundAttempt(refundId: string): { sessionId: string; attempt: RefundAttemptState } | null {
    for (const [sessionId, history] of this.refundHistory) {
      for (const attempt of history.values()) {
        if (attempt.refundId === refundId) {
          return { sessionId, attempt };
        }
      }
    }
    return null;
  }

  // eslint-disable-next-line complexity -- TODO(#57): split the legacy lifecycle fake dispatcher.
  async rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<SupabaseQueryResult<T>> {
    if (fn === "checkout_lifecycle_reconcile_completion") {
      const sessionId = String(args?.checkout_session_id);
      const userId = String(args?.target_user);
      this.lifecycleAmounts.set(sessionId, Number(args?.amount_total_cents));
      this.lifecyclePaymentIntents.set(sessionId, String(args?.stripe_payment_intent_id));
      const existing = this.lifecycleSessions.get(sessionId);
      if (existing === "completed") {
        return { data: "duplicate" as T, error: null };
      }
      if (existing === "refunded") {
        return {
          data: (this.customerCleanupPending.has(sessionId)
            ? "refunded_cleanup_pending"
            : "refunded") as T,
          error: null,
        };
      }
      if (existing === "payment_failed" || existing === "expired") {
        return { data: "duplicate" as T, error: null };
      }
      const creditedPurchase = this.tables.credit_ledger.find(
        (row) =>
          row.kind === "purchase" &&
          row.stripe_checkout_session_id === sessionId,
      );
      if (creditedPurchase !== undefined) {
        if (creditedPurchase.user_id !== userId) {
          return {
            data: null,
            error: { code: "23514", message: "Checkout Session credit belongs to another user" },
          };
        }
        this.lifecycleSessions.set(sessionId, "completed");
        return { data: "duplicate" as T, error: null };
      }
      if (this.deletedUsers.has(userId)) {
        this.lifecycleSessions.set(sessionId, "refund_pending");
        this.customerCleanupPending.add(sessionId);
        this.cleanupCustomerIds.set(
          sessionId,
          typeof args?.stripe_customer_id === "string" ? args.stripe_customer_id : null,
        );
        return { data: "refund_missing_user" as T, error: null };
      }
      if (this.fencedUsers.has(userId)) {
        this.lifecycleSessions.set(sessionId, "refund_pending");
        if (this.finalizedUsers.has(userId)) {
          this.customerCleanupPending.add(sessionId);
          this.cleanupCustomerIds.set(
            sessionId,
            typeof args?.stripe_customer_id === "string" ? args.stripe_customer_id : null,
          );
          this.finalizedUsers.delete(userId);
          return { data: "refund_missing_user" as T, error: null };
        }
        return { data: "refund" as T, error: null };
      }

      const customerId = args?.stripe_customer_id;
      if (typeof customerId === "string") {
        const customerResult = this.upsertRow(
          "billing_customers",
          {
            user_id: userId,
            stripe_customer_id: customerId,
            updated_at: new Date().toISOString(),
          },
          "user_id",
        );
        if (customerResult.error !== null) {
          return { data: null, error: customerResult.error };
        }
      }

      const ledgerResult = this.insertRow("credit_ledger", {
        user_id: userId,
        amount_cents: args?.amount_total_cents,
        kind: "purchase",
        description: "Credit purchase",
        stripe_event_id: args?.event_id,
        stripe_checkout_session_id: sessionId,
        metadata: {
          amount_total: args?.amount_total_cents,
          stripe_customer_id: customerId,
          stripe_checkout_session_id: sessionId,
          stripe_event_type: args?.event_type,
          stripe_payment_intent_id: args?.stripe_payment_intent_id,
        },
      });
      if (ledgerResult.error !== null && ledgerResult.error.code !== "23505") {
        return { data: null, error: ledgerResult.error };
      }

      this.lifecycleSessions.set(sessionId, "completed");
      return {
        data: (ledgerResult.error === null ? "credited" : "duplicate") as T,
        error: null,
      };
    }
    if (fn === "checkout_lifecycle_mark_async_payment_failed") {
      const sessionId = String(args?.checkout_session_id);
      const state = this.lifecycleSessions.get(sessionId);
      if (state === undefined) {
        return { data: "missing" as T, error: null };
      }
      if (state !== "open") {
        return { data: "duplicate" as T, error: null };
      }
      this.lifecycleSessions.set(sessionId, "payment_failed");
      if (typeof args?.stripe_customer_id === "string") {
        this.lifecycleCustomerIds.set(sessionId, args.stripe_customer_id);
      }
      return { data: "terminalized" as T, error: null };
    }
    if (fn === "checkout_lifecycle_mark_refunded") {
      const sessionId = String(args?.checkout_session_id);
      const succeededCents = [...(this.refundHistory.get(sessionId)?.values() ?? [])]
        .filter((attempt) => attempt.status === "succeeded")
        .reduce((sum, attempt) => sum + attempt.amountCents, 0);
      if (succeededCents < (this.lifecycleAmounts.get(sessionId) ?? 1000)) {
        return {
          data: null,
          error: {
            code: "23514",
            message: "Refund attempt history does not cover the full Checkout Session amount",
          },
        };
      }
      this.lifecycleSessions.set(sessionId, "refunded");
      return { data: null, error: null };
    }
    if (fn === "checkout_lifecycle_record_observed_refund") {
      const sessionId = String(args?.checkout_session_id);
      const refundId = String(args?.refund_id);
      const amountCents = Number(args?.amount_cents);
      const found = this.findRefundAttempt(refundId);
      if (found !== null) {
        if (
          found.sessionId !== sessionId ||
          found.attempt.amountCents !== amountCents ||
          found.attempt.status === "failed" ||
          found.attempt.status === "canceled"
        ) {
          return {
            data: null,
            error: { code: "23514", message: "Observed Refund conflicts with durable history" },
          };
        }
        found.attempt.status = "succeeded";
        return { data: null, error: null };
      }
      const history = this.refundHistory.get(sessionId) ?? new Map<number, RefundAttemptState>();
      const historyMax = Math.max(0, ...history.keys());
      const attempt = Math.max(historyMax, this.refundAttempts.get(sessionId) ?? 0) + 1;
      history.set(attempt, { attempt, refundId, amountCents, status: "succeeded" });
      this.refundHistory.set(sessionId, history);
      return { data: null, error: null };
    }
    if (fn === "checkout_lifecycle_reconcile_refund_event") {
      const refundId = String(args?.refund_id);
      const found = this.findRefundAttempt(refundId);
      if (found === null) {
        return { data: { status: "ignored" } as T, error: null };
      }
      const { sessionId, attempt } = found;
      const paymentIntentId = String(args?.payment_intent_id);
      if (
        Number(args?.refund_amount) !== attempt.amountCents ||
        paymentIntentId !== (this.lifecyclePaymentIntents.get(sessionId) ?? "pi_123")
      ) {
        return { data: { status: "ignored" } as T, error: null };
      }
      const status = String(args?.refund_status);
      const cleanupPending = this.customerCleanupPending.has(sessionId);
      if (status === "succeeded") {
        if (attempt.status === "failed" || attempt.status === "canceled") {
          return { data: { status: "ignored" } as T, error: null };
        }
        attempt.status = "succeeded";
        this.refundFailures.delete(sessionId);
        return {
          data: {
            status: "succeeded",
            checkout_session_id: sessionId,
            payment_intent_id: paymentIntentId,
            amount_cents: this.lifecycleAmounts.get(sessionId) ?? 1000,
            customer_cleanup_pending: cleanupPending,
          } as T,
          error: null,
        };
      }
      if (status === "failed" || status === "canceled") {
        if (attempt.status === "failed" || attempt.status === "canceled") {
          if (this.lifecycleSessions.get(sessionId) !== "refund_pending") {
            return { data: { status: "ignored" } as T, error: null };
          }
        } else {
          attempt.status = status;
          this.lifecycleSessions.set(sessionId, "refund_pending");
          this.refundIds.set(sessionId, refundId);
          this.refundFailures.set(sessionId, { refundId, status });
        }
        return {
          data: {
            status: "retry_required",
            checkout_session_id: sessionId,
            payment_intent_id: paymentIntentId,
            amount_cents: this.lifecycleAmounts.get(sessionId) ?? 1000,
            customer_cleanup_pending: cleanupPending,
          } as T,
          error: null,
        };
      }
      return {
        data: {
          status: attempt.status === "succeeded" ? "succeeded" : "pending",
          checkout_session_id: sessionId,
          payment_intent_id: paymentIntentId,
          amount_cents: this.lifecycleAmounts.get(sessionId) ?? 1000,
          customer_cleanup_pending: cleanupPending,
        } as T,
        error: null,
      };
    }
    if (fn === "checkout_lifecycle_prepare_refund_attempt") {
      const sessionId = String(args?.checkout_session_id);
      if (this.lifecycleSessions.get(sessionId) !== "refund_pending") {
        return { data: null, error: null };
      }
      const failure = this.refundFailures.get(sessionId);
      if (this.refundIds.has(sessionId) && failure === undefined) {
        return {
          data: {
            action: "attached",
            attempt: this.refundAttempts.get(sessionId) ?? 1,
            refund_id: this.refundIds.get(sessionId),
            payment_intent_id: this.lifecyclePaymentIntents.get(sessionId) ?? "pi_123",
            amount_cents: this.lifecycleAmounts.get(sessionId) ?? 1000,
            customer_cleanup_pending: this.customerCleanupPending.has(sessionId),
          } as T,
          error: null,
        };
      }
      const history = this.refundHistory.get(sessionId);
      const historyMax = history === undefined ? 0 : Math.max(0, ...history.keys());
      const attempt = failure === undefined
        ? Math.max(this.refundAttempts.get(sessionId) ?? 0, 1)
        : Math.max(historyMax, this.refundAttempts.get(sessionId) ?? 1) + 1;
      this.refundAttempts.set(sessionId, attempt);
      this.refundFailures.delete(sessionId);
      return {
        data: {
          action: "create",
          attempt,
          payment_intent_id: this.lifecyclePaymentIntents.get(sessionId) ?? "pi_123",
          amount_cents: this.lifecycleAmounts.get(sessionId) ?? 1000,
          customer_cleanup_pending: this.customerCleanupPending.has(sessionId),
        } as T,
        error: null,
      };
    }
    if (fn === "checkout_lifecycle_record_refund_attempt") {
      const sessionId = String(args?.checkout_session_id);
      const attempt = Number(args?.attempt);
      const refundId = String(args?.refund_id);
      const amountCents = Number(args?.amount_cents);
      const existing = this.refundHistory.get(sessionId)?.get(attempt);
      if (
        existing !== undefined &&
        (existing.refundId !== refundId || existing.amountCents !== amountCents)
      ) {
        return {
          data: null,
          error: { code: "23514", message: "Refund attempt conflicts with durable history" },
        };
      }
      const duplicateOwner = this.findRefundAttempt(refundId);
      if (duplicateOwner !== null && duplicateOwner.sessionId !== sessionId) {
        return uniqueViolation<T>();
      }
      this.seedRefundAttempt(sessionId, {
        attempt,
        refundId,
        amountCents,
        status: existing?.status ?? "pending",
      });
      this.refundIds.set(sessionId, refundId);
      return { data: null, error: null };
    }
    if (fn === "checkout_lifecycle_get_customer_cleanup") {
      const sessionId = String(args?.checkout_session_id);
      return {
        data: {
          pending: this.customerCleanupPending.has(sessionId),
          customer_id: this.cleanupCustomerIds.get(sessionId) ?? null,
        } as T,
        error: null,
      };
    }
    if (fn === "checkout_lifecycle_complete_customer_cleanup") {
      this.customerCleanupPending.delete(String(args?.checkout_session_id));
      return { data: null, error: null };
    }
    if (fn === "checkout_lifecycle_record_refund_failure") {
      const sessionId = String(args?.checkout_session_id);
      const refundId = String(args?.refund_id);
      const status = String(args?.failure_status);
      const found = this.findRefundAttempt(refundId);
      if (found === null || found.sessionId !== sessionId) {
        return { data: null, error: { code: "P0002", message: "Refund attempt is not registered" } };
      }
      found.attempt.status = status === "partial"
        ? "succeeded"
        : status as "failed" | "canceled";
      this.refundFailures.set(sessionId, { refundId, status });
      this.refundIds.set(sessionId, refundId);
      return { data: null, error: null };
    }
    if (fn === "credit_balance_cents") {
      const total = this.tables.credit_ledger
        .filter((row) => row.user_id === args?.target_user)
        .reduce((sum, row) => sum + Number(row.amount_cents), 0);
      return {
        data: total as T,
        error: null,
      };
    }

    return {
      data: null,
      error: { message: `Unknown rpc: ${fn}` },
    };
  }

  failNextInsert(table: keyof Tables, error: SupabaseErrorLike): void {
    this.insertFailures[table].push(error);
  }

  insertRow(table: keyof Tables, value: Record<string, unknown>): SupabaseQueryResult<unknown> {
    const injectedError = this.insertFailures[table].shift();
    if (injectedError !== undefined) {
      return { data: null, error: injectedError };
    }

    if (table === "stripe_events" && this.hasRow(table, "event_id", value.event_id)) {
      return uniqueViolation();
    }
    if (
      table === "billing_customers" &&
      typeof value.stripe_customer_id === "string" &&
      this.hasRow(table, "stripe_customer_id", value.stripe_customer_id)
    ) {
      return uniqueViolation();
    }
    if (table === "credit_ledger") {
      if (
        typeof value.stripe_event_id === "string" &&
        this.hasRow(table, "stripe_event_id", value.stripe_event_id)
      ) {
        return uniqueViolation();
      }
      if (
        value.kind === "purchase" &&
        typeof value.stripe_checkout_session_id === "string" &&
        this.tables.credit_ledger.some(
          (row) =>
            row.kind === "purchase" &&
            row.stripe_checkout_session_id === value.stripe_checkout_session_id,
        )
      ) {
        return uniqueViolation();
      }
    }

    const row =
      table === "credit_ledger"
        ? {
            id: `ledger_${++this.idCounter}`,
            created_at: new Date(Date.UTC(2026, 6, 9, 1, this.idCounter)).toISOString(),
            ...value,
          }
        : value;
    this.tables[table].push(row);

    return { data: row, error: null };
  }

  upsertRow(table: keyof Tables, value: Record<string, unknown>, onConflict?: string): SupabaseQueryResult<unknown> {
    const key = onConflict ?? "id";
    const existing = this.tables[table].find((row) => row[key] === value[key]);

    if (existing === undefined) {
      return this.insertRow(table, value);
    }

    Object.assign(existing, value);
    return { data: existing, error: null };
  }

  private hasRow(table: keyof Tables, column: string, value: unknown): boolean {
    return this.tables[table].some((row) => row[column] === value);
  }
}

class MemoryQuery<T> implements SupabaseQueryBuilderLike<T> {
  private action: "select" | "insert" | "upsert" = "select";
  private values: Record<string, unknown> | null = null;
  private filters: Array<{ column: string; value: unknown }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitCount: number | null = null;
  private onConflict: string | undefined;

  constructor(
    private readonly supabase: MemorySupabase,
    private readonly table: keyof Tables,
  ) {}

  select(): SupabaseQueryBuilderLike<T> {
    this.action = "select";
    return this;
  }

  insert(values: unknown): SupabaseQueryBuilderLike<T> {
    this.action = "insert";
    this.values = values as Record<string, unknown>;
    return this;
  }

  upsert(values: unknown, options?: { onConflict?: string }): SupabaseQueryBuilderLike<T> {
    this.action = "upsert";
    this.values = values as Record<string, unknown>;
    this.onConflict = options?.onConflict;
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryBuilderLike<T> {
    this.filters.push({ column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): SupabaseQueryBuilderLike<T> {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(count: number): SupabaseQueryBuilderLike<T> {
    this.limitCount = count;
    return this;
  }

  async maybeSingle(): Promise<SupabaseQueryResult<T | null>> {
    const result = await this.execute();
    const rows = Array.isArray(result.data) ? result.data : result.data === null ? [] : [result.data];

    return {
      data: (rows[0] ?? null) as T | null,
      error: result.error,
    };
  }

  then<TResult1 = SupabaseQueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<SupabaseQueryResult<T>> {
    if (this.action === "insert") {
      return this.supabase.insertRow(this.table, this.values ?? {}) as SupabaseQueryResult<T>;
    }

    if (this.action === "upsert") {
      return this.supabase.upsertRow(this.table, this.values ?? {}, this.onConflict) as SupabaseQueryResult<T>;
    }

    let rows = [...this.supabase.tables[this.table]];
    for (const filter of this.filters) {
      rows = rows.filter((row) => row[filter.column] === filter.value);
    }

    if (this.orderBy !== null) {
      rows.sort((left, right) => {
        const leftValue = String(left[this.orderBy?.column ?? ""]);
        const rightValue = String(right[this.orderBy?.column ?? ""]);
        return this.orderBy?.ascending === true
          ? leftValue.localeCompare(rightValue)
          : rightValue.localeCompare(leftValue);
      });
    }

    if (this.limitCount !== null) {
      rows = rows.slice(0, this.limitCount);
    }

    return {
      data: rows as T,
      error: null,
    };
  }
}

function isKnownTable(table: string): table is keyof Tables {
  return table === "billing_customers" || table === "credit_ledger" || table === "stripe_events";
}

function uniqueViolation<T = unknown>(): SupabaseQueryResult<T> {
  return {
    data: null,
    error: {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    } satisfies SupabaseErrorLike,
  };
}

function transientDatabaseError(): SupabaseErrorLike {
  return {
    code: "XX000",
    message: "temporary database failure",
  };
}
