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

  it("handles checkout.session.completed with customer upsert, purchase ledger row, and post-effect event record", async () => {
    const supabase = new MemorySupabase();

    await expect(
      processStripeEvent({ supabase, stripe: fakeStripe(), event: checkoutSessionEvent() }),
    ).resolves.toEqual({ handled: true, duplicate: false });

    expect(supabase.tables.billing_customers).toEqual([
      expect.objectContaining({
        stripe_customer_id: "cus_123",
        user_id: USER_ID,
      }),
    ]);
    expect(supabase.tables.credit_ledger).toEqual([
      expect.objectContaining({
        amount_cents: 1000,
        kind: "purchase",
        stripe_checkout_session_id: "cs_123",
        stripe_event_id: "evt_checkout",
        user_id: USER_ID,
      }),
    ]);
    expect(supabase.tables.stripe_events).toEqual([
      expect.objectContaining({
        event_id: "evt_checkout",
        type: "checkout.session.completed",
      }),
    ]);
  });

  it("idempotently refunds a completed Session for a fenced user without granting credits", async () => {
    const supabase = new MemorySupabase();
    supabase.fencedUsers.add(USER_ID);
    const stripe = fakeStripe();
    const event = checkoutSessionEvent({ sessionId: "cs_fenced" });

    await expect(
      processStripeEvent({ supabase, stripe, event }),
    ).resolves.toEqual({
      handled: true,
      duplicate: false,
      reconciliation: "deletion_race_refunded",
    });
    await expect(
      processStripeEvent({ supabase, stripe, event }),
    ).resolves.toEqual({
      handled: false,
      duplicate: true,
      reconciliation: "deletion_race_refunded",
    });

    expect(stripe.refunds.create).toHaveBeenCalledOnce();
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_123" },
      { idempotencyKey: "checkout-deletion:cs_fenced" },
    );
    expect(supabase.tables.credit_ledger).toHaveLength(0);
    expect(supabase.lifecycleSessions.get("cs_fenced")).toBe("refunded");
  });

  it("refunds and cleans a late customer after deletion finalization while auth still exists", async () => {
    const supabase = new MemorySupabase();
    supabase.fencedUsers.add(USER_ID);
    supabase.finalizedUsers.add(USER_ID);
    const stripe = fakeStripe();
    const event = checkoutSessionEvent({ sessionId: "cs_after_finalize" });

    await expect(processStripeEvent({ supabase, stripe, event })).resolves.toMatchObject({
      reconciliation: "deletion_race_refunded",
    });

    expect(stripe.refunds.create).toHaveBeenCalledOnce();
    expect(stripe.customers.del).toHaveBeenCalledWith("cus_123");
    expect(supabase.customerCleanupPending.has("cs_after_finalize")).toBe(false);
    expect(supabase.lifecycleSessions.get("cs_after_finalize")).toBe("refunded");
    expect(supabase.tables.credit_ledger).toHaveLength(0);
  });

  it("keeps a fenced completion retryable when Stripe refunding fails", async () => {
    const supabase = new MemorySupabase();
    supabase.fencedUsers.add(USER_ID);
    const stripe = fakeStripe();
    stripe.refunds.create.mockRejectedValueOnce(new Error("Stripe unavailable"));
    const event = checkoutSessionEvent({ sessionId: "cs_refund_retry" });

    await expect(
      processStripeEvent({ supabase, stripe, event }),
    ).rejects.toThrow("Stripe unavailable");
    expect(supabase.tables.credit_ledger).toHaveLength(0);
    expect(supabase.lifecycleSessions.get("cs_refund_retry")).toBe("refund_pending");

    await expect(
      processStripeEvent({ supabase, stripe, event }),
    ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });
    expect(stripe.refunds.create).toHaveBeenNthCalledWith(
      2,
      { payment_intent: "pi_123" },
      { idempotencyKey: "checkout-deletion:cs_refund_retry" },
    );
    expect(supabase.lifecycleSessions.get("cs_refund_retry")).toBe("refunded");
  });

  it("waits for an asynchronous Stripe refund to succeed before completing reconciliation", async () => {
    const supabase = new MemorySupabase();
    supabase.fencedUsers.add(USER_ID);
    const stripe = fakeStripe();
    stripe.refunds.create.mockResolvedValue({ id: "re_pending", amount: 1000, status: "pending" });
    stripe.refunds.retrieve
      .mockResolvedValueOnce({ id: "re_pending", amount: 1000, status: "pending" })
      .mockResolvedValueOnce({ id: "re_pending", amount: 1000, status: "succeeded" });
    const event = checkoutSessionEvent({ sessionId: "cs_async_refund" });

    await expect(
      processStripeEvent({ supabase, stripe, event }),
    ).rejects.toMatchObject({ code: "refund_incomplete" });
    expect(supabase.lifecycleSessions.get("cs_async_refund")).toBe("refund_pending");
    expect(supabase.tables.credit_ledger).toHaveLength(0);

    await expect(
      processStripeEvent({ supabase, stripe, event }),
    ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });
    expect(stripe.refunds.retrieve).toHaveBeenCalledTimes(2);
    expect(supabase.lifecycleSessions.get("cs_async_refund")).toBe("refunded");
  });

  it("accepts charge_already_refunded only after verifying a full succeeded refund", async () => {
    const supabase = new MemorySupabase();
    supabase.fencedUsers.add(USER_ID);
    const stripe = fakeStripe();
    stripe.refunds.create.mockRejectedValue({ code: "charge_already_refunded" });
    stripe.refunds.list.mockResolvedValue({
      data: [{ id: "re_existing", amount: 1000, status: "succeeded" }],
      has_more: false,
    });

    await expect(
      processStripeEvent({
        supabase,
        stripe,
        event: checkoutSessionEvent({ sessionId: "cs_already_refunded" }),
      }),
    ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });

    expect(stripe.refunds.retrieve).not.toHaveBeenCalled();
    expect(supabase.lifecycleSessions.get("cs_already_refunded")).toBe("refunded");
  });

  it("does not accept charge_already_refunded when only a partial refund succeeded", async () => {
    const supabase = new MemorySupabase();
    supabase.fencedUsers.add(USER_ID);
    const stripe = fakeStripe();
    stripe.refunds.create.mockRejectedValue({ code: "charge_already_refunded" });
    stripe.refunds.list.mockResolvedValue({
      data: [{ id: "re_partial", amount: 500, status: "succeeded" }],
      has_more: false,
    });

    await expect(
      processStripeEvent({
        supabase,
        stripe,
        event: checkoutSessionEvent({ sessionId: "cs_partially_refunded" }),
      }),
    ).rejects.toMatchObject({ code: "charge_already_refunded" });

    expect(supabase.lifecycleSessions.get("cs_partially_refunded")).toBe("refund_pending");
  });

  it.each(["failed", "canceled"] as const)(
    "durably records terminal refund status %s without releasing the deletion fence",
    async (status) => {
      const supabase = new MemorySupabase();
      supabase.fencedUsers.add(USER_ID);
      const stripe = fakeStripe();
      stripe.refunds.create.mockResolvedValue({ id: "re_terminal", amount: 1000, status });
      stripe.refunds.retrieve.mockResolvedValue({
        id: "re_terminal",
        amount: 1000,
        status,
      });

      await expect(
        processStripeEvent({
          supabase,
          stripe,
          event: checkoutSessionEvent({ sessionId: `cs_${status}` }),
        }),
      ).rejects.toMatchObject({ code: "refund_terminal_failure" });

      expect(supabase.lifecycleSessions.get(`cs_${status}`)).toBe("refund_pending");
      expect(supabase.refundFailures.get(`cs_${status}`)).toEqual({
        refundId: "re_terminal",
        status,
      });
      expect(supabase.tables.credit_ledger).toHaveLength(0);
    },
  );

  it("idempotently refunds a completion whose user is already missing", async () => {
    const supabase = new MemorySupabase();
    supabase.deletedUsers.add(USER_ID);
    const stripe = fakeStripe();

    await expect(
      processStripeEvent({
        supabase,
        stripe,
        event: checkoutSessionEvent({ sessionId: "cs_deleted" }),
      }),
    ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_123" },
      { idempotencyKey: "checkout-deletion:cs_deleted" },
    );
    expect(supabase.tables.billing_customers).toHaveLength(0);
    expect(stripe.customers.del).toHaveBeenCalledWith("cus_123");
    expect(supabase.customerCleanupPending.has("cs_deleted")).toBe(false);
    expect(supabase.tables.credit_ledger).toHaveLength(0);
    expect(supabase.lifecycleSessions.get("cs_deleted")).toBe("refunded");
  });

  it("retries missing-user customer cleanup without issuing a second refund", async () => {
    const supabase = new MemorySupabase();
    supabase.deletedUsers.add(USER_ID);
    const stripe = fakeStripe();
    stripe.customers.del.mockRejectedValueOnce(new Error("Stripe unavailable"));
    const event = checkoutSessionEvent({ sessionId: "cs_cleanup_retry" });

    await expect(processStripeEvent({ supabase, stripe, event })).rejects.toThrow(
      "Stripe unavailable",
    );
    expect(supabase.lifecycleSessions.get("cs_cleanup_retry")).toBe("refunded");
    expect(supabase.customerCleanupPending.has("cs_cleanup_retry")).toBe(true);

    const replayWithWrongCustomer = checkoutSessionEvent({
      id: "evt_cleanup_retry",
      sessionId: "cs_cleanup_retry",
      customer: "cus_wrong",
    });
    await expect(
      processStripeEvent({ supabase, stripe, event: replayWithWrongCustomer }),
    ).resolves.toMatchObject({
      reconciliation: "deletion_race_refunded",
    });
    expect(stripe.refunds.create).toHaveBeenCalledOnce();
    expect(stripe.customers.del).toHaveBeenCalledTimes(2);
    expect(stripe.customers.del).toHaveBeenNthCalledWith(2, "cus_123");
    expect(stripe.customers.del).not.toHaveBeenCalledWith("cus_wrong");
    expect(supabase.customerCleanupPending.has("cs_cleanup_retry")).toBe(false);
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

  it("treats a replayed completed event as duplicate through the ledger boundary", async () => {
    const supabase = new MemorySupabase();
    const event = checkoutSessionEvent();

    await processStripeEvent({ supabase, stripe: fakeStripe(), event });
    await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
      handled: false,
      duplicate: true,
    });

    expect(supabase.tables.credit_ledger).toHaveLength(1);
  });

  it("dedupes completed and async payment events for the same checkout session", async () => {
    const supabase = new MemorySupabase();

    await processStripeEvent({ supabase, stripe: fakeStripe(), event: checkoutSessionEvent() });
    await expect(
      processStripeEvent({ supabase, stripe: fakeStripe(), event: checkoutSessionEvent({
        id: "evt_async",
        type: "checkout.session.async_payment_succeeded",
      }) }),
    ).resolves.toEqual({ handled: false, duplicate: true });

    expect(supabase.tables.credit_ledger).toHaveLength(1);
    expect(supabase.tables.stripe_events).toHaveLength(2);
  });

  it("terminalizes checkout.session.async_payment_failed without granting credits", async () => {
    const supabase = new MemorySupabase();
    supabase.lifecycleSessions.set("cs_async_failed", "open");
    const event = checkoutSessionEvent({
      id: "evt_async_failed",
      sessionId: "cs_async_failed",
      type: "checkout.session.async_payment_failed",
    });

    await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
      handled: true,
      duplicate: false,
    });
    await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
      handled: false,
      duplicate: true,
    });

    expect(supabase.lifecycleSessions.get("cs_async_failed")).toBe("payment_failed");
    expect(supabase.lifecycleCustomerIds.get("cs_async_failed")).toBe("cus_123");
    expect(supabase.tables.credit_ledger).toHaveLength(0);
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

  it("mints paid sessions with a null customer without upserting billing_customers", async () => {
    const supabase = new MemorySupabase();

    await expect(
      processStripeEvent({ supabase, stripe: fakeStripe(), event: checkoutSessionEvent({ customer: null }) }),
    ).resolves.toEqual({ handled: true, duplicate: false });

    expect(supabase.tables.billing_customers).toHaveLength(0);
    expect(supabase.tables.credit_ledger).toEqual([
      expect.objectContaining({
        amount_cents: 1000,
        user_id: USER_ID,
      }),
    ]);
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

  it("does not lose or duplicate ledger rows when post-effect stripe_events recording fails", async () => {
    const supabase = new MemorySupabase();
    supabase.failNextInsert("stripe_events", transientDatabaseError());
    const event = checkoutSessionEvent();

    await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
      handled: true,
      duplicate: false,
    });
    await expect(processStripeEvent({ supabase, stripe: fakeStripe(), event })).resolves.toEqual({
      handled: false,
      duplicate: true,
    });

    expect(supabase.tables.credit_ledger).toHaveLength(1);
    expect(supabase.tables.stripe_events).toEqual([
      expect.objectContaining({
        event_id: "evt_checkout",
      }),
    ]);
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

  it("creates payment checkout sessions with a persistent customer request and no credit metadata", async () => {
    const stripe = fakeStripe();

    await createCreditCheckoutSession({
      stripe,
      userId: USER_ID,
      priceId: "price_123",
      successUrl: "https://pickforge.dev/success",
      cancelUrl: "https://pickforge.dev/cancel",
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "payment",
      customer_creation: "always",
      client_reference_id: USER_ID,
      line_items: [{ price: "price_123", quantity: 1 }],
      success_url: "https://pickforge.dev/success",
      cancel_url: "https://pickforge.dev/cancel",
    });
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
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "payment",
      customer: "cus_123",
      client_reference_id: USER_ID,
      line_items: [{ price: "price_123", quantity: 1 }],
      success_url: "https://pickforge.dev/success",
      cancel_url: "https://pickforge.dev/cancel",
    });
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

function fakeStripe(options: { event?: StripeEventLike } = {}) {
  return {
    checkout: {
      sessions: {
        create: vi.fn(async (params) => ({
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
    "open" | "payment_failed" | "completed" | "refund_pending" | "refunded"
  >();
  readonly lifecycleCustomerIds = new Map<string, string>();
  readonly customerCleanupPending = new Set<string>();
  readonly cleanupCustomerIds = new Map<string, string | null>();
  readonly refundFailures = new Map<string, { refundId: string; status: string }>();

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

  async rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<SupabaseQueryResult<T>> {
    if (fn === "checkout_lifecycle_reconcile_completion") {
      const sessionId = String(args?.checkout_session_id);
      const userId = String(args?.target_user);
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
      this.lifecycleSessions.set(String(args?.checkout_session_id), "refunded");
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
      this.refundFailures.set(String(args?.checkout_session_id), {
        refundId: String(args?.refund_id),
        status: String(args?.failure_status),
      });
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
