import { describe, expect, it, vi } from "vitest";
import {
  EdgeSharedError,
  assertRouteRequest,
  corsPreflightResponse,
  createDeleteAccountHandler,
  createExportAccountHandler,
  createOperatorRouterHandler,
  createCallerSupabaseFactory,
  createRegisteredCheckoutSession,
  createRequiredEnv,
  createStripeWebhookHandler,
  debitCredits,
  getBearerToken,
  expireCheckoutSession,
  getUserFromRequest,
  isCheckoutDeletionFenced,
  jsonResponse,
  markCheckoutSessionExpired,
  newIdempotencyKey,
  registerCheckoutSession,
  withCors,
  operatorRouterSystemPrompt,
  requireEntitlement,
  type EdgeSharedJson,
  type StripeCheckoutClientLike,
  type StripeCheckoutSessionLike,
  type StripeCheckoutSessionStatus,
  type StripeCustomerClientLike,
  type SupabaseClientLike,
  type SupabaseErrorLike,
  type SupabaseQueryBuilderLike,
  type SupabaseQueryResult,
} from "../src/index.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";

describe("@pickforge/edge-shared", () => {
  it("does not offer selectWidget over hosted routing", () => {
    expect(operatorRouterSystemPrompt).not.toContain("selectWidget");
    expect(operatorRouterSystemPrompt).toContain("Semantic widget selection is not available over hosted routing");
  });

  it("parses bearer tokens from Authorization headers", () => {
    expect(getBearerToken(new Request("https://edge.test", { headers: { Authorization: "Bearer jwt_123" } }))).toBe(
      "jwt_123",
    );
    expect(getBearerToken(new Request("https://edge.test", { headers: { Authorization: "bearer jwt_456" } }))).toBe(
      "jwt_456",
    );
    expect(getBearerToken(new Request("https://edge.test"))).toBeNull();
    expect(getBearerToken(new Request("https://edge.test", { headers: { Authorization: "Basic abc" } }))).toBeNull();
    expect(getBearerToken(new Request("https://edge.test", { headers: { Authorization: "Bearer " } }))).toBeNull();
  });

  it("reads the authenticated user from the bearer token", async () => {
    const supabase = new MemorySupabase();
    const req = new Request("https://edge.test", { headers: { Authorization: "Bearer token_123" } });

    await expect(getUserFromRequest({ supabase, req })).resolves.toEqual({ userId: USER_ID });
    expect(supabase.auth.getUser).toHaveBeenCalledWith("token_123");
  });

  it("throws unauthorized when the bearer token is absent or invalid", async () => {
    const supabase = new MemorySupabase();
    await expect(getUserFromRequest({ supabase, req: new Request("https://edge.test") })).rejects.toMatchObject({
      code: "unauthorized",
    } satisfies Partial<EdgeSharedError>);

    supabase.authResult = {
      data: { user: null },
      error: { message: "invalid jwt" },
    };
    await expect(
      getUserFromRequest({
        supabase,
        req: new Request("https://edge.test", { headers: { Authorization: "Bearer bad_token" } }),
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    } satisfies Partial<EdgeSharedError>);
  });

  it("returns a present, unexpired entitlement value", async () => {
    const supabase = new MemorySupabase();
    supabase.entitlements.push({
      user_id: USER_ID,
      key: "pro",
      value: { tier: "pro" },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(requireEntitlement({ supabase, userId: USER_ID, key: "pro" })).resolves.toEqual({ tier: "pro" });
  });

  it("throws entitlement_required when an entitlement is absent or expired", async () => {
    const supabase = new MemorySupabase();

    await expect(requireEntitlement({ supabase, userId: USER_ID, key: "pro" })).rejects.toMatchObject({
      code: "entitlement_required",
    } satisfies Partial<EdgeSharedError>);

    supabase.entitlements.push({
      user_id: USER_ID,
      key: "pro",
      value: true,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await expect(requireEntitlement({ supabase, userId: USER_ID, key: "pro" })).rejects.toMatchObject({
      code: "entitlement_required",
    } satisfies Partial<EdgeSharedError>);
  });

  it("maps a successful debit rpc response", async () => {
    const supabase = new MemorySupabase();
    supabase.debitResult = { status: "ok", balance: 850 };

    await expect(
      debitCredits({
        supabase,
        userId: USER_ID,
        amountCents: 150,
        reason: "render",
        idempotencyKey: "render:job_123",
      }),
    ).resolves.toEqual({ duplicate: false, balance: 850 });
    expect(supabase.rpcCalls).toEqual([
      {
        fn: "debit_credits",
        args: {
          target_user: USER_ID,
          debit_cents: 150,
          reason: "render",
          idem_key: "render:job_123",
          usage_metadata: {},
        },
      },
    ]);
  });

  it("maps duplicate and insufficient debit rpc responses", async () => {
    const duplicateSupabase = new MemorySupabase();
    duplicateSupabase.debitResult = { status: "duplicate" };
    await expect(
      debitCredits({
        supabase: duplicateSupabase,
        userId: USER_ID,
        amountCents: 150,
        reason: "render",
        idempotencyKey: "render:job_123",
      }),
    ).resolves.toEqual({ duplicate: true });

    const insufficientSupabase = new MemorySupabase();
    insufficientSupabase.debitResult = { status: "insufficient", balance: 25 };
    await expect(
      debitCredits({
        supabase: insufficientSupabase,
        userId: USER_ID,
        amountCents: 150,
        reason: "render",
        idempotencyKey: "render:job_123",
      }),
    ).rejects.toMatchObject({
      code: "insufficient_credits",
      balance: 25,
    } satisfies Partial<EdgeSharedError>);
  });

  it("allows the same idempotency key for different users", async () => {
    const supabase = scopedDebitSupabase({
      [USER_ID]: 1000,
      [OTHER_USER_ID]: 500,
    });

    await expect(
      debitCredits({
        supabase,
        userId: USER_ID,
        amountCents: 150,
        reason: "render",
        idempotencyKey: "render:shared_job",
      }),
    ).resolves.toEqual({ duplicate: false, balance: 850 });
    await expect(
      debitCredits({
        supabase,
        userId: OTHER_USER_ID,
        amountCents: 150,
        reason: "render",
        idempotencyKey: "render:shared_job",
      }),
    ).resolves.toEqual({ duplicate: false, balance: 350 });
    await expect(
      debitCredits({
        supabase,
        userId: USER_ID,
        amountCents: 150,
        reason: "render",
        idempotencyKey: "render:shared_job",
      }),
    ).resolves.toEqual({ duplicate: true });
  });

  it("maps debit rpc failures and malformed responses", async () => {
    const failedSupabase = new MemorySupabase();
    failedSupabase.rpcError = { message: "database unavailable" };
    await expect(
      debitCredits({
        supabase: failedSupabase,
        userId: USER_ID,
        amountCents: 150,
        reason: "render",
        idempotencyKey: "render:job_123",
      }),
    ).rejects.toMatchObject({
      code: "database_error",
    } satisfies Partial<EdgeSharedError>);

    const malformedSupabase = new MemorySupabase();
    malformedSupabase.debitResult = { status: "other" };
    await expect(
      debitCredits({
        supabase: malformedSupabase,
        userId: USER_ID,
        amountCents: 150,
        reason: "render",
        idempotencyKey: "render:job_123",
      }),
    ).rejects.toMatchObject({
      code: "invalid_rpc_result",
    } satisfies Partial<EdgeSharedError>);
  });

  it("builds deterministic idempotency keys", () => {
    expect(newIdempotencyKey("render", "job_123")).toBe("render:job_123");
    expect(() => newIdempotencyKey("", "job_123")).toThrow(EdgeSharedError);
    expect(() => newIdempotencyKey("render", " ")).toThrow(EdgeSharedError);
  });

  it("creates json responses", async () => {
    const response = jsonResponse(202, { ok: true });

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("creates CORS preflight responses", () => {
    const response = corsPreflightResponse();

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "apikey, x-client-info, authorization, content-type, x-idempotency-key",
    );
  });

  it("registers a first Checkout Session before returning its URL", async () => {
    const order: string[] = [];
    const stripe = checkoutStripe({
      expire: vi.fn(async () => {
        order.push("expire");
        return { id: "cs_first", status: "expired" as const };
      }),
    });
    const registerSession = vi.fn(async () => {
      order.push("register");
      return false;
    });

    await expect(
      createRegisteredCheckoutSession({
        stripe,
        userId: USER_ID,
        isDeletionFenced: async () => false,
        createSession: async () => {
          order.push("create");
          return { id: "cs_first", url: "https://checkout.stripe.test/first" };
        },
        registerSession,
        markSessionExpired: async () => {},
      }),
    ).resolves.toEqual({ id: "cs_first", url: "https://checkout.stripe.test/first" });

    expect(order).toEqual(["create", "register"]);
    expect(registerSession).toHaveBeenCalledWith(USER_ID, "cs_first");
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it("rejects a fenced checkout before creating a Stripe Session", async () => {
    const createSession = vi.fn(async () => ({
      id: "cs_never",
      url: "https://checkout.stripe.test/never",
    }));

    await expect(
      createRegisteredCheckoutSession({
        stripe: checkoutStripe(),
        userId: USER_ID,
        isDeletionFenced: async () => true,
        createSession,
        registerSession: async () => false,
        markSessionExpired: async () => {},
      }),
    ).rejects.toMatchObject({ code: "deletion_in_progress" });

    expect(createSession).not.toHaveBeenCalled();
  });

  it("expires a created Session when registration fails, without returning its URL", async () => {
    const stripe = checkoutStripe();

    await expect(
      createRegisteredCheckoutSession({
        stripe,
        userId: USER_ID,
        isDeletionFenced: async () => false,
        createSession: async () => ({
          id: "cs_unregistered",
          url: "https://checkout.stripe.test/unregistered",
        }),
        registerSession: async () => {
          throw new Error("database unavailable");
        },
        markSessionExpired: async () => {},
      }),
    ).rejects.toThrow("database unavailable");

    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_unregistered");
  });

  it("expires a created Session whose URL cannot be returned", async () => {
    const stripe = checkoutStripe();

    await expect(
      createRegisteredCheckoutSession({
        stripe,
        userId: USER_ID,
        isDeletionFenced: async () => false,
        createSession: async () => ({ id: "cs_without_url", url: null }),
        registerSession: vi.fn(),
        markSessionExpired: async () => {},
      }),
    ).rejects.toMatchObject({ code: "invalid_string" });

    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_without_url");
  });

  it("registers then expires when deletion fences the user during Stripe creation", async () => {
    let fenced = false;
    const stripe = checkoutStripe();
    const registerSession = vi.fn(async () => fenced);
    const markSessionExpired = vi.fn(async () => {});

    await expect(
      createRegisteredCheckoutSession({
        stripe,
        userId: USER_ID,
        isDeletionFenced: async () => fenced,
        createSession: async () => {
          fenced = true;
          return { id: "cs_raced", url: "https://checkout.stripe.test/raced" };
        },
        registerSession,
        markSessionExpired,
      }),
    ).rejects.toMatchObject({ code: "deletion_in_progress" });

    expect(registerSession).toHaveBeenCalledWith(USER_ID, "cs_raced");
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_raced");
    expect(markSessionExpired).toHaveBeenCalledWith("cs_raced");
  });

  it("reads the account deletion fence used to gate new Checkout Session registration", async () => {
    const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      expect(fn).toBe("checkout_lifecycle_is_deletion_fenced");
      expect(args).toEqual({ target_user: USER_ID });
      return { data: true, error: null };
    });

    await expect(isCheckoutDeletionFenced({ rpc }, USER_ID)).resolves.toBe(true);
  });

  it("raises a database_error when the deletion fence RPC fails or returns a non-boolean", async () => {
    await expect(
      isCheckoutDeletionFenced({ rpc: async () => ({ data: null, error: { message: "down" } }) }, USER_ID),
    ).rejects.toMatchObject({ code: "database_error" } satisfies Partial<EdgeSharedError>);

    await expect(
      isCheckoutDeletionFenced({ rpc: async () => ({ data: "nope", error: null }) }, USER_ID),
    ).rejects.toMatchObject({ code: "database_error" } satisfies Partial<EdgeSharedError>);
  });

  it("registers a Checkout Session against the durable lifecycle", async () => {
    const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      expect(fn).toBe("checkout_lifecycle_register_session");
      expect(args).toEqual({ target_user: USER_ID, checkout_session_id: "cs_registered" });
      return { data: false, error: null };
    });

    await expect(registerCheckoutSession({ rpc }, USER_ID, "cs_registered")).resolves.toBe(false);
  });

  it("raises a database_error when Checkout Session registration fails or returns a non-boolean", async () => {
    await expect(
      registerCheckoutSession(
        { rpc: async () => ({ data: null, error: { message: "down" } }) },
        USER_ID,
        "cs_x",
      ),
    ).rejects.toMatchObject({ code: "database_error" } satisfies Partial<EdgeSharedError>);

    await expect(
      registerCheckoutSession({ rpc: async () => ({ data: 1, error: null }) }, USER_ID, "cs_x"),
    ).rejects.toMatchObject({ code: "database_error" } satisfies Partial<EdgeSharedError>);
  });

  it("marks a Checkout Session expired against the durable lifecycle", async () => {
    const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      expect(fn).toBe("checkout_lifecycle_mark_expired");
      expect(args).toEqual({ checkout_session_id: "cs_expired" });
      return { data: null, error: null };
    });

    await expect(markCheckoutSessionExpired({ rpc }, "cs_expired")).resolves.toBeUndefined();
  });

  it("raises a database_error when marking a Checkout Session expired fails", async () => {
    await expect(
      markCheckoutSessionExpired(
        { rpc: async () => ({ data: null, error: { message: "down" } }) },
        "cs_expired",
      ),
    ).rejects.toMatchObject({ code: "database_error" } satisfies Partial<EdgeSharedError>);
  });

  it("recognizes a completed Session without trying to expire it", async () => {
    const stripe = checkoutStripe();
    stripe.checkout.sessions.retrieve = vi.fn(async () => ({
      id: "cs_complete",
      status: "complete" as const,
    }));

    await expect(expireCheckoutSession(stripe, "cs_complete")).resolves.toBe("complete");

    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it("fences first and expires a registered first-checkout Session before auth deletion", async () => {
    const admin = accountAdmin({}, {}, {
      sessions: [{ stripe_checkout_session_id: "cs_first", state: "open" }],
    });
    const stripe = deletionStripe({
      sessions: [{ id: "cs_first", status: "open" }],
    });
    const handler = createDeleteAccountHandler({
      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(admin.rpcCalls[0]).toEqual({
      fn: "checkout_lifecycle_fence_deletion",
      args: { target_user: USER_ID },
    });
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_first");
    expect(
      admin.rpcCalls.findIndex(({ fn }) => fn === "checkout_lifecycle_delete_auth_user"),
    ).toBeGreaterThan(
      admin.rpcCalls.findIndex(({ fn }) => fn === "checkout_lifecycle_mark_expired"),
    );
  });

  it("collects every registry and customer-scoped page before expiring any Session", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `cs_customer_${String(index).padStart(3, "0")}`,
      status: "open" as const,
    }));
    const customerSessions = [...firstPage, { id: "cs_customer_100", status: "open" as const }];
    const admin = accountAdmin(
      {
        billing_customers: [{ user_id: USER_ID, stripe_customer_id: "cus_current" }],
      },
      {},
      {
        sessions: [{ stripe_checkout_session_id: "cs_registered", state: "open" }],
      },
    );
    const stripe = deletionStripe({
      sessions: [{ id: "cs_registered", status: "open" }, ...customerSessions],
      customerSessions: { cus_current: customerSessions.map((session) => session.id) },
    });
    const handler = createDeleteAccountHandler({
      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(200);
    expect(stripe.checkout.sessions.list).toHaveBeenCalledTimes(2);
    expect(stripe.checkout.sessions.list).toHaveBeenNthCalledWith(2, {
      customer: "cus_current",
      status: "open",
      limit: 100,
      starting_after: "cs_customer_099",
    });
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(102);
    expect(stripe.checkout.sessions.list.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      stripe.checkout.sessions.expire.mock.invocationCallOrder[0]!,
    );
    expect(stripe.customers.del.mock.invocationCallOrder[0]!).toBeGreaterThan(
      stripe.checkout.sessions.expire.mock.invocationCallOrder.at(-1)!,
    );
  });

  it.each([2, 3, 4])(
    "fails closed when an open Session appears during lifecycle re-list %i",
    async (listCall) => {
      const admin = accountAdmin({}, {}, {
        onListSessions: (call, sessions) => {
          if (call >= 2 && call < listCall) {
            sessions.push({
              stripe_checkout_session_id: `cs_stabilizer_${call}`,
              state: "expired",
            });
          }
          if (call === listCall) {
            sessions.push({
              stripe_checkout_session_id: `cs_late_${listCall}`,
              state: "open",
            });
          }
        },
      });
      const stripe = deletionStripe();
      const handler = createDeleteAccountHandler({
        admin,
        stripe,
        resolveUserId: vi.fn(async () => USER_ID),
      });

      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      let response: Response;
      try {
        response = await handler(new Request("https://edge.test", { method: "POST" }));

        expect(consoleError).toHaveBeenCalledWith(
          JSON.stringify({
            scope: "edge-shared",
            operation: "account_deletion_incomplete",
            error_code: "deletion_incomplete",
          }),
        );
      } finally {
        consoleError.mockRestore();
      }

      expect(response.status).toBe(503);
      expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
    },
  );

  it("merges a terminal Session discovered before auth deletion and deletes its customer", async () => {
    const admin = accountAdmin({}, {}, {
      onListSessions: (call, sessions) => {
        if (call === 2 || call === 3) {
          sessions.push({
            stripe_checkout_session_id: `cs_stabilizer_${call}`,
            state: "expired",
          });
        }
        if (call === 4) {
          sessions.push({
            stripe_checkout_session_id: "cs_late_refunded",
            state: "refunded",
            stripe_customer_id: "cus_late_refunded",
          });
        }
      },
    });
    const stripe = deletionStripe();
    const handler = createDeleteAccountHandler({
      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(200);
    expect(stripe.customers.del).toHaveBeenCalledWith("cus_late_refunded");
    expect(admin.rpcCalls).toContainEqual({ fn: "checkout_lifecycle_delete_auth_user", args: { target_user: USER_ID } });
  });

  it("fails closed when lifecycle discovery never reaches a fixpoint", async () => {
    const admin = accountAdmin({}, {}, {
      onListSessions: (call, sessions) => {
        if (call >= 2) {
          sessions.push({
            stripe_checkout_session_id: `cs_unbounded_${call}`,
            state: "expired",
          });
        }
      },
    });
    const handler = createDeleteAccountHandler({
      admin,
      stripe: deletionStripe(),
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(503);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("holds customer and auth deletion when the locked finalizer observes a late unsafe Session", async () => {
    const admin = accountAdmin({}, {}, {
      sessions: [{
        stripe_checkout_session_id: "cs_completed",
        state: "completed",
        stripe_customer_id: "cus_preserved",
      }],
      onFinalize: (sessions) => {
        sessions.push({
          stripe_checkout_session_id: "cs_late_refund",
          state: "refund_pending",
          stripe_customer_id: "cus_preserved",
        });
      },
    });
    const stripe = deletionStripe({
      sessions: [{ id: "cs_completed", status: "complete" }],
    });
    const handler = createDeleteAccountHandler({
      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(503);
    expect(stripe.customers.del).not.toHaveBeenCalled();
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("atomically blocks auth deletion when completion starts after the final snapshot", async () => {
    const admin = accountAdmin({}, {}, {
      sessions: [{
        stripe_checkout_session_id: "cs_terminal",
        state: "completed",
        stripe_customer_id: "cus_terminal",
      }],
      onAtomicDelete: (sessions) => {
        sessions.push({
          stripe_checkout_session_id: "cs_atomic_race",
          state: "refund_pending",
          stripe_customer_id: "cus_atomic_race",
        });
      },
    });
    const handler = createDeleteAccountHandler({
      admin,
      stripe: deletionStripe(),
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(503);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("keeps refunded customer cleanup pending until it is durably cleared", async () => {
    const admin = accountAdmin({}, {}, {
      sessions: [{
        stripe_checkout_session_id: "cs_cleanup_pending",
        state: "refunded",
        stripe_customer_id: "cus_cleanup_pending",
        customer_cleanup_pending: true,
      }],
    });
    const stripe = deletionStripe();
    const handler = createDeleteAccountHandler({
      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(503);
    expect(stripe.customers.del).not.toHaveBeenCalled();
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("deletes a refunded customer discovered inside the locked finalizer snapshot", async () => {
    const admin = accountAdmin({}, {}, {
      onFinalize: (sessions) => {
        sessions.push({
          stripe_checkout_session_id: "cs_locked_refunded",
          state: "refunded",
          stripe_customer_id: "cus_locked_refunded",
        });
      },
    });
    const stripe = deletionStripe();
    const handler = createDeleteAccountHandler({

      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(200);
    expect(stripe.customers.del).toHaveBeenCalledWith("cus_locked_refunded");
    expect(admin.rpcCalls).toContainEqual({ fn: "checkout_lifecycle_delete_auth_user", args: { target_user: USER_ID } });
  });

  it("deletes safely with a pre-lifecycle credited Session backfilled as completed", async () => {
    const admin = accountAdmin({}, {}, {
      sessions: [{
        stripe_checkout_session_id: "cs_pre_lifecycle_credited",
        state: "completed",
        stripe_customer_id: "cus_pre_lifecycle_credited",
      }],
    });
    const stripe = deletionStripe({
      sessions: [{ id: "cs_pre_lifecycle_credited", status: "complete" }],
    });
    const handler = createDeleteAccountHandler({
      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(200);
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(stripe.customers.del).toHaveBeenCalledWith("cus_pre_lifecycle_credited");
    expect(admin.rpcCalls).toContainEqual({ fn: "checkout_lifecycle_delete_auth_user", args: { target_user: USER_ID } });
  });

  it("rechecks and deletes a customer terminalized after the first frozen snapshot", async () => {
    let lateTerminalized = false;
    const admin = accountAdmin({}, {}, {
      sessions: [{
        stripe_checkout_session_id: "cs_initial_terminal",
        state: "completed",
        stripe_customer_id: "cus_initial",
      }],
      onListSessions: (_call, sessions) => {
        if (
          lateTerminalized &&
          !sessions.some((session) =>
            session.stripe_checkout_session_id === "cs_late_terminal"
          )
        ) {
          sessions.push({
            stripe_checkout_session_id: "cs_late_terminal",
            state: "refunded",
            stripe_customer_id: "cus_late",
          });
        }
      },
    });
    const stripe = deletionStripe({
      deleteCustomer: async (customerId) => {
        if (customerId === "cus_initial") {
          lateTerminalized = true;
        }
        return {};
      },
    });
    const handler = createDeleteAccountHandler({
      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(200);
    expect(stripe.customers.del).toHaveBeenCalledWith("cus_initial");
    expect(stripe.customers.del).toHaveBeenCalledWith("cus_late");
    expect(admin.rpcCalls).toContainEqual({ fn: "checkout_lifecycle_delete_auth_user", args: { target_user: USER_ID } });
  });

  it("keeps deletion retryable when expiry fails after earlier Sessions were expired", async () => {
    const admin = accountAdmin({}, {}, {
      sessions: [
        { stripe_checkout_session_id: "cs_one", state: "open" },
        { stripe_checkout_session_id: "cs_two", state: "open" },
      ],
    });
    let failSecond = true;
    const stripe = deletionStripe({
      sessions: [
        { id: "cs_one", status: "open" },
        { id: "cs_two", status: "open" },
      ],
      expire: async (sessionId, statuses) => {
        if (sessionId === "cs_two" && failSecond) {
          throw new Error("Stripe unavailable");
        }
        statuses.set(sessionId, "expired");
        return { id: sessionId, status: "expired" };
      },
    });
    const handler = createDeleteAccountHandler({
      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const failed = await handler(new Request("https://edge.test", { method: "POST" }));
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ error: "deletion_incomplete" });
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();

    failSecond = false;
    const retried = await handler(new Request("https://edge.test", { method: "POST" }));
    expect(retried.status).toBe(200);
    expect(admin.rpcCalls).toContainEqual({ fn: "checkout_lifecycle_delete_auth_user", args: { target_user: USER_ID } });
  });

  it("classifies expired and reconciled-completed races but blocks unreconciled completion", async () => {
    const safeAdmin = accountAdmin({}, {}, {
      sessions: [
        { stripe_checkout_session_id: "cs_expired", state: "open" },
        { stripe_checkout_session_id: "cs_complete", state: "completed" },
        { stripe_checkout_session_id: "cs_payment_failed", state: "payment_failed" },
        {
          stripe_checkout_session_id: "cs_refunded",
          state: "refunded",
          stripe_customer_id: "cus_refunded",
        },
      ],
    });
    const safeStripe = deletionStripe({
      sessions: [
        { id: "cs_expired", status: "expired" },
        { id: "cs_complete", status: "complete" },
        { id: "cs_refunded", status: "complete" },
        { id: "cs_payment_failed", status: "complete" },
      ],
    });
    const safeHandler = createDeleteAccountHandler({
      admin: safeAdmin,
      stripe: safeStripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    await expect(safeHandler(new Request("https://edge.test", { method: "POST" }))).resolves.toMatchObject({
      status: 200,
    });
    expect(safeAdmin.rpcCalls).toContainEqual({ fn: "checkout_lifecycle_delete_auth_user", args: { target_user: USER_ID } });
    expect(safeStripe.customers.del).toHaveBeenCalledWith("cus_refunded");

    const unsafeAdmin = accountAdmin({}, {}, {
      sessions: [{ stripe_checkout_session_id: "cs_unreconciled", state: "open" }],
    });
    const unsafeHandler = createDeleteAccountHandler({
      admin: unsafeAdmin,
      stripe: deletionStripe({
        sessions: [{ id: "cs_unreconciled", status: "complete" }],
      }),
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const unsafe = await unsafeHandler(new Request("https://edge.test", { method: "POST" }));
    expect(unsafe.status).toBe(503);
    expect(unsafeAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("keeps auth and Stripe customer state while a fenced completion refund is pending", async () => {
    const admin = accountAdmin({}, {}, {
      sessions: [{
        stripe_checkout_session_id: "cs_refund_pending",
        state: "refund_pending",
        stripe_customer_id: "cus_refund_pending",
      }],
    });
    const stripe = deletionStripe({
      sessions: [{ id: "cs_refund_pending", status: "complete" }],
    });
    const handler = createDeleteAccountHandler({
      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(503);
    expect(stripe.customers.del).not.toHaveBeenCalled();
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("preserves auth state when Stripe customer cleanup fails and tolerates missing resources", async () => {
    const rows = {
      billing_customers: [{ user_id: USER_ID, stripe_customer_id: "cus_current" }],
    };
    const failingAdmin = accountAdmin(rows);
    const failingHandler = createDeleteAccountHandler({
      admin: failingAdmin,
      stripe: deletionStripe({
        deleteCustomer: async () => {
          throw new Error("Stripe unavailable");
        },
      }),
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const failed = await failingHandler(new Request("https://edge.test", { method: "POST" }));
    expect(failed.status).toBe(503);
    expect(failingAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();

    const missingAdmin = accountAdmin(rows);
    const missingHandler = createDeleteAccountHandler({
      admin: missingAdmin,
      stripe: deletionStripe({
        deleteCustomer: async () => {
          throw { code: "resource_missing" };
        },
      }),
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const missing = await missingHandler(new Request("https://edge.test", { method: "POST" }));
    expect(missing.status).toBe(200);
    expect(missingAdmin.rpcCalls).toContainEqual({ fn: "checkout_lifecycle_delete_auth_user", args: { target_user: USER_ID } });
  });

  it("returns 500 when the atomic auth-deletion RPC fails", async () => {
    const failedDeleteAdmin = accountAdmin({}, {}, {
      errors: {
        checkout_lifecycle_delete_auth_user: { message: "Database unavailable" },
      },
    });
    const failedDeleteHandler = createDeleteAccountHandler({
      admin: failedDeleteAdmin,
      stripe: deletionStripe(),
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const failedDeleteResponse = await failedDeleteHandler(new Request("https://edge.test", { method: "POST" }));
    expect(failedDeleteResponse.status).toBe(500);
    expect(failedDeleteAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("returns unauthorized for account deletion without an authenticated user", async () => {
    const handler = createDeleteAccountHandler({
      admin: accountAdmin(),
      stripe: deletionStripe(),
      resolveUserId: async () => {
        throw new EdgeSharedError("unauthorized", "Unauthorized");
      },
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it("exports every portable account data section", async () => {
    const handler = createExportAccountHandler({
      admin: accountAdmin({
        profiles: [{ id: USER_ID, email: "dev@pickforge.test", display_name: "Dev", avatar_url: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" }],
        entitlements: [{ user_id: USER_ID, id: "ent_123", key: "pro", value: true, granted_at: "2026-01-01T00:00:00.000Z", expires_at: null, source: "stripe" }],
        credit_ledger: [{ user_id: USER_ID, id: "ledger_123", amount_cents: 500, kind: "credit", description: "Pack", stripe_event_id: "evt_123", stripe_checkout_session_id: "cs_123", metadata: { pack: "p10" }, created_at: "2026-01-01T00:00:00.000Z", idempotency_key: "stripe:evt_123" }],
        settings_sync: [
          { user_id: USER_ID, field_group: "preferences", payload: { theme: "dark" }, updated_at: "2026-01-01T00:00:00.000Z", deleted_at: null },
          { user_id: USER_ID, field_group: "archive", payload: {}, updated_at: "2026-01-01T00:00:00.000Z", deleted_at: "2026-01-02T00:00:00.000Z" },
        ],
        billing_customers: [{ user_id: USER_ID, stripe_customer_id: "cus_123" }],
      }),
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 1,
      profile: { id: USER_ID, email: "dev@pickforge.test" },
      entitlements: [{ id: "ent_123", key: "pro" }],
      creditLedger: [{ id: "ledger_123", amount_cents: 500 }],
      syncedSettings: [{ field_group: "preferences" }],
      billing: { hasStripeCustomer: true, stripeCustomerId: "cus_123" },
    });
  });

  it("exports empty account sections and returns unauthorized without an authenticated user", async () => {
    const emptyHandler = createExportAccountHandler({
      admin: accountAdmin(),
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const emptyResponse = await emptyHandler(new Request("https://edge.test", { method: "POST" }));
    await expect(emptyResponse.json()).resolves.toMatchObject({
      profile: null,
      entitlements: [],
      creditLedger: [],
      syncedSettings: [],
      billing: { hasStripeCustomer: false, stripeCustomerId: null },
    });

    const unauthorizedHandler = createExportAccountHandler({
      admin: accountAdmin(),
      resolveUserId: async () => {
        throw new EdgeSharedError("unauthorized", "Unauthorized");
      },
    });
    const unauthorizedResponse = await unauthorizedHandler(new Request("https://edge.test", { method: "POST" }));
    expect(unauthorizedResponse.status).toBe(401);
    await expect(unauthorizedResponse.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("returns 500 for account data read failures", async () => {
    const handler = createDeleteAccountHandler({
      admin: accountAdmin({}, { billing_customers: { message: "Database unavailable" } }),
      stripe: deletionStripe(),
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal_error" });
  });

  it("exports every credit ledger page", async () => {
    const creditLedger = Array.from({ length: 1001 }, (_, index) => ({
      user_id: USER_ID,
      id: `ledger_${index}`,
      amount_cents: index,
      kind: "credit",
      description: null,
      stripe_event_id: null,
      stripe_checkout_session_id: null,
      metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
      idempotency_key: `ledger:${index}`,
    }));
    const handler = createExportAccountHandler({
      admin: accountAdmin({ credit_ledger: creditLedger }),
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));
    const body = (await response.json()) as { creditLedger: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.creditLedger).toHaveLength(1001);
    expect(body.creditLedger.at(-1)).toEqual(expect.objectContaining({ id: "ledger_1000" }));
  });

  it("handles verified Stripe webhook requests", async () => {
    const stripe = {};
    const supabase = {};
    const event = { id: "evt_123", type: "checkout.session.completed", data: { object: { id: "cs_123" } } };
    const verifyStripeEvent = vi.fn(async () => event);
    const processStripeEvent = vi.fn(async () => ({ handled: true, duplicate: false }));
    const handler = createStripeWebhookHandler({
      stripe,
      supabase,
      webhookSecret: "whsec_123",
      verifyStripeEvent,
      processStripeEvent,
    });

    const response = await handler(
      new Request("https://edge.test", {
        method: "POST",
        headers: { "stripe-signature": "sig_123" },
        body: "{\"id\":\"evt_123\"}",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ handled: true, duplicate: false });
    expect(verifyStripeEvent).toHaveBeenCalledWith({
      payload: "{\"id\":\"evt_123\"}",
      signature: "sig_123",
      secret: "whsec_123",
      stripe,
    });
    expect(processStripeEvent).toHaveBeenCalledWith({ stripe, supabase, event });
  });

  it("returns 400 for missing or invalid Stripe signatures", async () => {
    const verifyStripeEvent = vi.fn(async () => {
      throw new Error("bad signature");
    });
    const processStripeEvent = vi.fn(async () => ({ handled: true, duplicate: false }));
    const handler = createStripeWebhookHandler({
      stripe: {},
      supabase: {},
      webhookSecret: "whsec_123",
      verifyStripeEvent,
      processStripeEvent,
    });

    const missing = await handler(new Request("https://edge.test", { method: "POST", body: "{}" }));
    expect(missing.status).toBe(400);
    expect(verifyStripeEvent).not.toHaveBeenCalled();

    const invalid = await handler(
      new Request("https://edge.test", {
        method: "POST",
        headers: { "stripe-signature": "sig_123" },
        body: "{}",
      }),
    );
    expect(invalid.status).toBe(400);
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it("returns 500 when Stripe event processing fails", async () => {
    const handler = createStripeWebhookHandler({
      stripe: {},
      supabase: {},
      webhookSecret: "whsec_123",
      verifyStripeEvent: vi.fn(async () => ({
        id: "evt_123",
        type: "checkout.session.completed",
        data: { object: { id: "cs_123" } },
      })),
      processStripeEvent: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let response: Response;
    try {
      response = await handler(
        new Request("https://edge.test", {
          method: "POST",
          headers: { "stripe-signature": "sig_123" },
          body: "{}",
        }),
      );

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(JSON.parse(consoleError.mock.calls[0]![0] as string)).toEqual({
        scope: "edge-shared",
        operation: "stripe_webhook_processing_failed",
        event_id: "evt_123",
        event_type: "checkout.session.completed",
        error_code: "Error",
      });
    } finally {
      consoleError.mockRestore();
    }

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "webhook_processing_failed" });
  });

  it.each([
    "open /home/dev/project",
    "open \"/home/dev/x\"",
    "open C:\\Users\\dev\\project",
    "open \\\\server\\share",
    "open foo\\bar\\baz",
    "open https://db.internal.corp/path",
    "connect localhost:3000",
    "connect buildserver:8080",
    "connect db.internal.corp",
    "open build.local",
    "connect 100.64.1.2",
    "use abcdefghijklmnopqrstuvwxyz0123456789",
    "connect ssh://buildserver",
    "connect localhost",
    "connect [fd00::1]",
  ])("rejects forbidden attached context identifiers: %s", (projectName) => {
    expectBoundaryViolation(() => assertRouteRequest({ commandText: "open Billing", context: { projectName } }));
  });

  it("allows user-authored command identifiers", () => {
    expect(
      assertRouteRequest({ commandText: "create codex chat using gpt-5.4-mini about api.example.com from /home/dev" }),
    ).toEqual({ commandText: "create codex chat using gpt-5.4-mini about api.example.com from /home/dev" });
  });

  it("strictly parses the route request allowlist", () => {
    expect(
      assertRouteRequest({
        commandText: "open project Billing",
        context: { projectName: "Billing", chatNames: ["CI"], widgetLabels: ["Run"] },
      }),
    ).toEqual({
      commandText: "open project Billing",
      context: { projectName: "Billing", chatNames: ["CI"], widgetLabels: ["Run"] },
    });
    expectBoundaryViolation(() => assertRouteRequest({ commandText: "open Billing", source: "secret" }));
    expectBoundaryViolation(() => assertRouteRequest({ commandText: "open Billing", context: { path: "Billing" } }));
    expectBoundaryViolation(() =>
      assertRouteRequest({ commandText: "open Billing", context: { chatNames: ["buildserver:8080"] } }),
    );
    expect(assertRouteRequest({ commandText: "start a review swarm for the auth diff" })).toEqual({
      commandText: "start a review swarm for the auth diff",
    });
  });

  it("routes a valid command then claims, completes, and debits with a namespaced key", async () => {
    const supabase = new MemorySupabase();
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    const chatComplete = vi.fn(async () => ({
      text: "{\"action\":{\"action\":\"openProject\"},\"confidence\":0.9}",
      usage: { input: 42, output: 13 },
    }));
    const handler = createOperatorRouterHandler({
      supabase,
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete,
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    const response = await handler(
      new Request("https://edge.test", {
        method: "POST",
        headers: { Authorization: "Bearer token", "x-idempotency-key": "router:attempt-1" },
        body: JSON.stringify({ commandText: "open project Billing", context: { projectName: "Billing" } }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      proposalJson: "{\"action\":{\"action\":\"openProject\"},\"confidence\":0.9}",
      usage: { input: 42, output: 13 },
      costCents: 2,
    });
    expect(chatComplete).toHaveBeenCalledOnce();
    const scopedKey = `router:${USER_ID}:router:attempt-1`;
    expect(serviceSupabase.rpcCalls.map((call) => call.fn)).toEqual([
      "router_attempt_claim",
      "router_attempt_complete",
      "debit_credits",
    ]);
    expect(serviceSupabase.rpcCalls[2]).toMatchObject({
      args: {
        target_user: USER_ID,
        idem_key: scopedKey,
        reason: "Operator routing",
        usage_metadata: {
          proposalJson: "{\"action\":{\"action\":\"openProject\"},\"confidence\":0.9}",
          usage: { input: 42, output: 13 },
        },
      },
    });
  });

  it("returns insufficient credits without claiming or calling the model", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase();
    const chatComplete = vi.fn();
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 1),
      chatComplete,
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    const response = await handler(routeRequest("open project Billing"));
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({ error: "insufficient_credits", balance: 1 });
    expect(chatComplete).not.toHaveBeenCalled();
    expect(serviceSupabase.rpcCalls).toHaveLength(0);
  });

  it("returns a stored proposal without calling the model for a replay of an already-debited (legacy) route", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    serviceSupabase.seedLegacyLedgerRoute(USER_ID, `router:${USER_ID}:router:attempt-1`, {
      proposalJson: "{\"stored\":true}",
      usage: { input: 3, output: 2 },
    });
    const chatComplete = vi.fn(async () => ({ text: "{}", usage: { input: 1, output: 1 } }));
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete,
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    const response = await handler(routeRequest("open project Billing"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      proposalJson: "{\"stored\":true}",
      usage: { input: 3, output: 2 },
      costCents: 2,
    });
    expect(chatComplete).not.toHaveBeenCalled();
    expect(serviceSupabase.rpcCalls).toHaveLength(0);
  });

  it("rejects forbidden attached context before claiming, debiting, or calling the model", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    const chatComplete = vi.fn();
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete,
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    const response = await handler(
      routeRequest("open project Billing", { projectName: "/home/dev/project" }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "boundary_violation" });
    expect(chatComplete).not.toHaveBeenCalled();
    expect(serviceSupabase.rpcCalls).toHaveLength(0);
  });

  it("does not debit a failed provider attempt and lets an immediate retry reclaim it", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    const chatComplete = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ text: "{}", usage: { input: 1, output: 1 } });
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete,
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    await expect(handler(routeRequest("open project Billing"))).resolves.toMatchObject({ status: 500 });
    expect(serviceSupabase.rpcCalls.map((call) => call.fn)).toEqual([
      "router_attempt_claim",
      "router_attempt_fail",
    ]);
    await expect(handler(routeRequest("open project Billing"))).resolves.toMatchObject({ status: 200 });
    expect(serviceSupabase.rpcCalls.map((call) => call.fn)).toEqual([
      "router_attempt_claim",
      "router_attempt_fail",
      "router_attempt_claim",
      "router_attempt_complete",
      "debit_credits",
    ]);
    expect(chatComplete).toHaveBeenCalledTimes(2);
  });

  it("returns attempt_in_progress without invoking the provider or debiting while a claim is live", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    serviceSupabase.seedClaim(USER_ID, `router:${USER_ID}:router:attempt-1`);
    const chatComplete = vi.fn();
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete,
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    const response = await handler(routeRequest("open project Billing"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "attempt_in_progress" });
    expect(chatComplete).not.toHaveBeenCalled();
    expect(serviceSupabase.rpcCalls.map((call) => call.fn)).toEqual(["router_attempt_claim"]);
  });

  it("recovers a stale (lease-expired) claim and invokes the provider exactly once", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    serviceSupabase.seedClaim(USER_ID, `router:${USER_ID}:router:attempt-1`, 31_000);
    const chatComplete = vi.fn(async () => ({ text: "{\"recovered\":true}", usage: { input: 1, output: 1 } }));
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete,
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
      attemptLeaseSeconds: 30,
    });

    const response = await handler(routeRequest("open project Billing"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      proposalJson: "{\"recovered\":true}",
      usage: { input: 1, output: 1 },
      costCents: 2,
    });
    expect(chatComplete).toHaveBeenCalledOnce();
  });

  it("retries only the debit, without re-invoking the provider, after a debit fails post-completion", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    serviceSupabase.failNextDebitWithoutCommitting();
    const chatComplete = vi.fn(async () => ({ text: "{\"once\":true}", usage: { input: 4, output: 6 } }));
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete,
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    await expect(handler(routeRequest("open project Billing"))).resolves.toMatchObject({ status: 500 });
    expect(chatComplete).toHaveBeenCalledOnce();
    expect(serviceSupabase.rpcCalls.map((call) => call.fn)).toEqual([
      "router_attempt_claim",
      "router_attempt_complete",
      "debit_credits",
    ]);

    const response = await handler(routeRequest("open project Billing"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      proposalJson: "{\"once\":true}",
      usage: { input: 4, output: 6 },
      costCents: 2,
    });
    // The provider was invoked only once across both calls: the retry's claim
    // finds the attempt already completed and skips straight to the debit.
    expect(chatComplete).toHaveBeenCalledOnce();
    expect(serviceSupabase.rpcCalls.map((call) => call.fn)).toEqual([
      "router_attempt_claim",
      "router_attempt_complete",
      "debit_credits",
      "router_attempt_claim",
      "debit_credits",
    ]);
  });

  it("returns the stored result after a concurrent duplicate debit", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    const winner = { proposalJson: "{\"stored\":true}", usage: { input: 5, output: 3 } };
    serviceSupabase.forceDuplicateDebitOnce(winner);
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete: vi.fn(async () => ({ text: "{\"fresh\":true}", usage: { input: 1, output: 1 } })),
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    const response = await handler(routeRequest("open project Billing"));
    await expect(response.json()).resolves.toEqual({ ...winner, costCents: 2 });
  });

  it("returns the stored proposal when a committed debit loses its response", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    const scopedKey = `router:${USER_ID}:router:attempt-1`;
    serviceSupabase.loseNextDebitResponseAfterCommitting();

    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete: vi.fn(async () => ({ text: "{\"stored\":true}", usage: { input: 5, output: 3 } })),
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    const response = await handler(routeRequest("open project Billing"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      proposalJson: "{\"stored\":true}",
      usage: { input: 5, output: 3 },
      costCents: 2,
    });
    expect(serviceSupabase.readLedgerRoute(USER_ID, scopedKey)).not.toBeNull();
  });

  it.each([
    { commandText: "x".repeat(4001) },
    { commandText: "open Billing", context: { projectName: "x".repeat(201) } },
    { commandText: "open Billing", context: { chatNames: Array.from({ length: 101 }, () => "CI") } },
    { commandText: "open Billing", context: { widgetLabels: ["/etc"] } },
    { commandText: "open Billing", context: { chatNames: ["../secrets"] } },
    { commandText: "open Billing", context: { projectName: "./.env" } },
    { commandText: "open Billing", context: { projectName: "~/.env" } },
    { commandText: "open Billing", context: { chatNames: ["../.ssh/id_rsa"] } },
    { commandText: "open Billing", context: { widgetLabels: ["/home/u/.aws/credentials"] } },
    { commandText: "open Billing", context: { projectName: "projects/app" } },
    { commandText: "open Billing", context: { projectName: "foo/bar" } },
    { commandText: "open Billing", context: { projectName: "Edit .env" } },
    { commandText: "open Billing", context: { projectName: "deploy .git" } },
  ])("rejects oversized or forbidden attached context data", (body) => {
    expectBoundaryViolation(() => assertRouteRequest(body));
  });

  it("allows ordinary attached context", () => {
    expect(assertRouteRequest({ commandText: "start a review and/or a scout", context: { projectName: "Billing" } })).toEqual({
      commandText: "start a review and/or a scout",
      context: { projectName: "Billing" },
    });
  });

  it("allows a normal attached label with punctuation", () => {
    expect(assertRouteRequest({ commandText: "open Billing", context: { projectName: "Sprint 3. Final" } })).toEqual({
      commandText: "open Billing",
      context: { projectName: "Sprint 3. Final" },
    });
  });

  it("returns rate_limited after ten routed attempts", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    const chatComplete = vi.fn(async () => ({ text: "{}", usage: { input: 1, output: 1 } }));
    let attempts = 0;
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => ++attempts <= 10),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete,
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(handler(routeRequest("open project Billing", undefined, `attempt-${attempt}`))).resolves.toMatchObject({
        status: 200,
      });
    }

    const response = await handler(routeRequest("open project Billing", undefined, "attempt-10"));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
    expect(chatComplete).toHaveBeenCalledTimes(10);
    expect(serviceSupabase.rpcCalls.filter((call) => call.fn === "debit_credits")).toHaveLength(10);
  });

  it("maps invalid JSON to a boundary violation", async () => {
    const serviceSupabase = new FakeRouterServiceSupabase({ [USER_ID]: 100 });
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      serviceSupabase,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      chatComplete: vi.fn(),
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    const response = await handler(
      new Request("https://edge.test", {
        method: "POST",
        headers: { Authorization: "Bearer token", "x-idempotency-key": "attempt-1" },
        body: "{",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "boundary_violation" });
    expect(serviceSupabase.rpcCalls).toHaveLength(0);
  });
});

describe("Deno Edge Function adapter helpers", () => {
  it("reads required env vars and throws on missing or empty values", () => {
    const env = new Map<string, string>([
      ["SUPABASE_URL", "https://project.supabase.co"],
      ["EMPTY", ""],
    ]);
    const requiredEnv = createRequiredEnv({ get: (name) => env.get(name) });

    expect(requiredEnv("SUPABASE_URL")).toBe("https://project.supabase.co");
    expect(() => requiredEnv("EMPTY")).toThrow("EMPTY is required");
    expect(() => requiredEnv("MISSING")).toThrow("MISSING is required");
  });

  it("builds a caller-scoped Supabase client that forwards the Authorization header", () => {
    const createClient = vi.fn((url: string, key: string, options: unknown) => ({ url, key, options }));
    const createCallerSupabase = createCallerSupabaseFactory({
      createClient,
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon-key",
    });

    const client = createCallerSupabase(
      new Request("https://edge.test", { headers: { Authorization: "Bearer caller-token" } }),
    );

    expect(client).toEqual({
      url: "https://project.supabase.co",
      key: "anon-key",
      options: {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: "Bearer caller-token" } },
      },
    });
  });

  it("defaults the forwarded Authorization header to an empty string when absent", () => {
    const createClient = vi.fn((_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) => options);
    const createCallerSupabase = createCallerSupabaseFactory({
      createClient,
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon-key",
    });

    const options = createCallerSupabase(new Request("https://edge.test"));

    expect(options.global.headers.Authorization).toBe("");
  });

  it("merges CORS headers onto a handler response without altering its body", async () => {
    const merged = await withCors(jsonResponse(201, { ok: true }));

    expect(merged.status).toBe(201);
    expect(merged.headers.get("access-control-allow-origin")).toBe("*");
    expect(merged.headers.get("content-type")).toBe("application/json");
    await expect(merged.json()).resolves.toEqual({ ok: true });
  });
});

interface EntitlementRow {
  user_id: string;
  key: string;
  value?: EdgeSharedJson;
  expires_at: string | null;
}

interface CheckoutStripeOptions {
  expire?: StripeCheckoutClientLike["checkout"]["sessions"]["expire"];
  retrieve?: StripeCheckoutClientLike["checkout"]["sessions"]["retrieve"];
}

function checkoutStripe(options: CheckoutStripeOptions = {}) {
  return {
    checkout: {
      sessions: {
        expire: vi.fn(options.expire ?? (async (sessionId) => ({ id: sessionId, status: "expired" as const }))),
        retrieve: vi.fn(options.retrieve ?? (async (sessionId) => ({ id: sessionId, status: "open" as const }))),
        list: vi.fn(async () => ({ data: [], has_more: false })),
      },
    },
  } satisfies StripeCheckoutClientLike;
}

interface DeletionStripeOptions {
  sessions?: StripeCheckoutSessionLike[];
  customerSessions?: Record<string, string[]>;
  expire?: (
    sessionId: string,
    statuses: Map<string, StripeCheckoutSessionStatus>,
  ) => Promise<StripeCheckoutSessionLike>;
  deleteCustomer?: (customerId: string) => Promise<unknown>;
}

function deletionStripe(options: DeletionStripeOptions = {}) {
  const statuses = new Map<string, StripeCheckoutSessionStatus>();
  for (const session of options.sessions ?? []) {
    if (session.status !== null) {
      statuses.set(session.id, session.status);
    }
  }

  const expire = vi.fn(async (sessionId: string): Promise<StripeCheckoutSessionLike> => {
    if (options.expire !== undefined) {
      return options.expire(sessionId, statuses);
    }
    if (statuses.get(sessionId) !== "open") {
      throw new Error("Checkout Session is not open");
    }
    statuses.set(sessionId, "expired");
    return { id: sessionId, status: "expired" };
  });
  const retrieve = vi.fn(async (sessionId: string): Promise<StripeCheckoutSessionLike> => {
    const status = statuses.get(sessionId);
    if (status === undefined) {
      throw { code: "resource_missing" };
    }
    return { id: sessionId, status };
  });
  const list = vi.fn(async (params: {
    customer: string;
    status: "open";
    limit: number;
    starting_after?: string;
  }) => {
    const openIds = (options.customerSessions?.[params.customer] ?? []).filter(
      (sessionId) => statuses.get(sessionId) === "open",
    );
    const startingIndex =
      params.starting_after === undefined ? 0 : openIds.indexOf(params.starting_after) + 1;
    const data = openIds.slice(startingIndex, startingIndex + params.limit).map((sessionId) => ({
      id: sessionId,
      status: statuses.get(sessionId) ?? null,
    }));
    return {
      data,
      has_more: startingIndex + data.length < openIds.length,
    };
  });
  const del = vi.fn(options.deleteCustomer ?? (async () => ({})));

  return {
    checkout: { sessions: { expire, retrieve, list } },
    customers: { del },
  } satisfies StripeCustomerClientLike;
}

interface AccountLifecycleSession {
  stripe_checkout_session_id: string;
  state: string;
  stripe_customer_id?: string | null;
  customer_cleanup_pending?: boolean;
}

interface AccountLifecycleOptions {
  sessions?: AccountLifecycleSession[];
  errors?: Record<string, SupabaseErrorLike>;
  onListSessions?: (call: number, sessions: AccountLifecycleSession[]) => void;
  onFinalize?: (sessions: AccountLifecycleSession[]) => void;
  onAtomicDelete?: (sessions: AccountLifecycleSession[]) => void;
}

function accountAdmin(
  rows: Record<string, unknown[]> = {},
  errors: Record<string, SupabaseErrorLike> = {},
  lifecycle: AccountLifecycleOptions = {},
) {
  const rpcCalls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  const lifecycleSessions = (lifecycle.sessions ?? []).map((session) => ({ ...session }));
  let listCalls = 0;
  const deleteUser = vi.fn<(userId: string) => Promise<{ error: SupabaseErrorLike | null }>>(
    async (_userId) => ({ error: null }),
  );
  return {
    rpcCalls,
    auth: {
      admin: {
        deleteUser,
      },
    },
    from<T = unknown>(table: string): AccountQuery<T> {
      return new AccountQuery<T>(rows[table] ?? [], errors[table] ?? null);
    },
    // eslint-disable-next-line complexity -- TODO(#57): split the legacy lifecycle fake dispatcher.
    async rpc<T = unknown>(
      fn: string,
      args?: Record<string, unknown>,
    ): Promise<SupabaseQueryResult<T>> {
      rpcCalls.push({ fn, args });
      const injectedError = lifecycle.errors?.[fn];
      if (injectedError !== undefined) {
        return { data: null, error: injectedError };
      }
      if (fn === "checkout_lifecycle_fence_deletion") {
        return { data: null, error: null };
      }
      if (fn === "checkout_lifecycle_mark_expired") {
        const session = lifecycleSessions.find(
          (item) => item.stripe_checkout_session_id === args?.checkout_session_id,
        );
        if (session?.state === "open") {
          session.state = "expired";
        }
        return { data: null, error: null };
      }
      if (fn === "checkout_lifecycle_finalize_deletion") {
        lifecycle.onFinalize?.(lifecycleSessions);
        const unsafe = lifecycleSessions.some(
          (session) =>
            session.state === "open" ||
            session.state === "refund_pending" ||
            session.customer_cleanup_pending === true,
        );
        const customerIds = [
          ...new Set(
            lifecycleSessions
              .map((session) => session.stripe_customer_id)
              .filter((customerId): customerId is string => typeof customerId === "string"),
          ),
        ];
        return {
          data: (unsafe
            ? { status: "unsafe" }
            : { status: "finalized", customer_ids: customerIds }) as T,
          error: null,
        };
      }
      if (fn === "checkout_lifecycle_delete_auth_user") {
        lifecycle.onAtomicDelete?.(lifecycleSessions);
        const unsafe = lifecycleSessions.some(
          (session) =>
            session.state === "open" ||
            session.state === "refund_pending" ||
            session.customer_cleanup_pending === true,
        );
        if (unsafe) {
          return { data: "unsafe" as T, error: null };
        }
        return { data: "deleted" as T, error: null };
      }
      if (fn === "checkout_lifecycle_list_sessions") {
        const start = Number(args?.page_start ?? 0);
        const size = Number(args?.page_size ?? 1000);
        lifecycle.onListSessions?.(++listCalls, lifecycleSessions);
        const page = lifecycleSessions.slice(start, start + size);
        return { data: page as T, error: null };
      }
      return { data: null, error: { message: `Unknown rpc: ${fn}` } };
    },
  };
}

class AccountQuery<T> implements SupabaseQueryBuilderLike<T> {
  private readonly filters: Array<{ column: string; value: unknown }> = [];
  private rangeStart: number | undefined;
  private rangeEnd: number | undefined;

  constructor(
    private readonly rows: unknown[],
    private readonly error: SupabaseErrorLike | null,
  ) {}

  select(): SupabaseQueryBuilderLike<T> {
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryBuilderLike<T> {
    this.filters.push({ column, value });
    return this;
  }

  is(column: string, value: null): SupabaseQueryBuilderLike<T> {
    this.filters.push({ column, value });
    return this;
  }

  order(_column: string, _options?: { ascending?: boolean }): SupabaseQueryBuilderLike<T> {
    return this;
  }

  range(from: number, to: number): SupabaseQueryBuilderLike<T> {
    this.rangeStart = from;
    this.rangeEnd = to;
    return this;
  }

  async maybeSingle(): Promise<SupabaseQueryResult<T | null>> {
    return { data: (this.filteredRows()[0] ?? null) as T | null, error: this.error };
  }

  then<TResult1 = SupabaseQueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.filteredRows() as T, error: this.error }).then(onfulfilled, onrejected);
  }

  private filteredRows(): unknown[] {
    const filtered = this.rows.filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        this.filters.every((filter) => (row as Record<string, unknown>)[filter.column] === filter.value),
    );
    return this.rangeStart === undefined || this.rangeEnd === undefined
      ? filtered
      : filtered.slice(this.rangeStart, this.rangeEnd + 1);
  }
}

class MemorySupabase implements SupabaseClientLike {
  readonly entitlements: EntitlementRow[] = [];
  readonly rpcCalls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  authResult: SupabaseQueryResult<{ user: { id: string } | null }> = {
    data: { user: { id: USER_ID } },
    error: null,
  };
  debitResult: unknown = { status: "ok", balance: 0 };
  rpcError: SupabaseErrorLike | null = null;
  readonly auth = {
    getUser: vi.fn(async (_token: string) => this.authResult),
  };

  from<T = unknown>(table: string): SupabaseQueryBuilderLike<T> {
    if (table !== "entitlements") {
      throw new Error(`Unknown table: ${table}`);
    }

    return new MemoryQuery<T>(this);
  }

  async rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<SupabaseQueryResult<T>> {
    this.rpcCalls.push({ fn, args });
    if (fn !== "debit_credits") {
      return { data: null, error: { message: `Unknown rpc: ${fn}` } };
    }
    if (this.rpcError !== null) {
      return { data: null, error: this.rpcError };
    }

    return { data: this.debitResult as T, error: null };
  }
}

class MemoryQuery<T> implements SupabaseQueryBuilderLike<T> {
  private readonly filters: Array<{ column: string; value: unknown }> = [];

  constructor(private readonly supabase: MemorySupabase) {}

  select(): SupabaseQueryBuilderLike<T> {
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryBuilderLike<T> {
    this.filters.push({ column, value });
    return this;
  }

  is(column: string, value: null): SupabaseQueryBuilderLike<T> {
    return this.eq(column, value);
  }

  order(_column: string, _options?: { ascending?: boolean }): SupabaseQueryBuilderLike<T> {
    return this;
  }

  range(_from: number, _to: number): SupabaseQueryBuilderLike<T> {
    return this;
  }

  async maybeSingle(): Promise<SupabaseQueryResult<T | null>> {
    const rows = this.rows();

    return {
      data: (rows[0] ?? null) as T | null,
      error: null,
    };
  }

  then<TResult1 = SupabaseQueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({
      data: this.rows() as T,
      error: null,
    }).then(onfulfilled, onrejected);
  }

  private rows(): EntitlementRow[] {
    return this.supabase.entitlements.filter((row) =>
      this.filters.every((filter) => row[filter.column as keyof EntitlementRow] === filter.value),
    );
  }
}

interface FakeRouterAttemptRow {
  status: "claimed" | "completed" | "failed";
  proposalJson?: string;
  usageInput?: number;
  usageOutput?: number;
  claimedAtMs: number;
}

/**
 * Reimplements the router_attempt_claim / router_attempt_complete /
 * router_attempt_fail / debit_credits RPC contracts (and a minimal
 * credit_ledger table) in memory, exactly like `scopedDebitSupabase` already
 * does for `debit_credits` alone. The real durable decisions are proven
 * separately against Postgres by
 * packages/edge-shared/test/router-attempt.contract.test.ts; this fake only
 * needs to honor the same contract so createOperatorRouterHandler's own
 * choreography (claim -> provider -> complete -> debit, and every recovery
 * path) can be exercised fast and deterministically.
 */
class FakeRouterServiceSupabase implements Pick<SupabaseClientLike, "from" | "rpc"> {
  readonly rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  nowMs = 0;
  private forcedDuplicateOnce: StoredRouteProposalLike | null = null;
  private failNextDebitWithoutWriting = false;
  private loseNextDebitResponseAfterCommit = false;
  private readonly attempts = new Map<string, FakeRouterAttemptRow>();
  private readonly ledger = new Map<string, unknown>();
  private readonly balances: Map<string, number>;

  constructor(initialBalances: Record<string, number> = {}) {
    this.balances = new Map(Object.entries(initialBalances));
  }

  seedLegacyLedgerRoute(userId: string, idempotencyKey: string, route: StoredRouteProposalLike): void {
    this.ledger.set(`${userId}:${idempotencyKey}`, route);
  }

  seedClaim(userId: string, idempotencyKey: string, ageMs = 0): void {
    this.attempts.set(`${userId}:${idempotencyKey}`, { status: "claimed", claimedAtMs: this.nowMs - ageMs });
  }

  forceDuplicateDebitOnce(route: StoredRouteProposalLike): void {
    this.forcedDuplicateOnce = route;
  }

  failNextDebitWithoutCommitting(): void {
    this.failNextDebitWithoutWriting = true;
  }

  loseNextDebitResponseAfterCommitting(): void {
    this.loseNextDebitResponseAfterCommit = true;
  }

  from<T = unknown>(table: string): SupabaseQueryBuilderLike<T> {
    if (table !== "credit_ledger") {
      throw new Error(`Unknown table: ${table}`);
    }

    return new FakeLedgerQuery<T>(this);
  }

  async rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<SupabaseQueryResult<T>> {
    this.rpcCalls.push({ fn, args });
    if (fn === "router_attempt_claim") return this.claim(args) as SupabaseQueryResult<T>;
    if (fn === "router_attempt_complete") return this.complete(args) as SupabaseQueryResult<T>;
    if (fn === "router_attempt_fail") return this.fail(args) as SupabaseQueryResult<T>;
    if (fn === "debit_credits") return this.debit(args) as SupabaseQueryResult<T>;

    return { data: null, error: { message: `Unknown rpc: ${fn}` } };
  }

  readLedgerRoute(userId: string, idempotencyKey: string): unknown {
    return this.ledger.get(`${userId}:${idempotencyKey}`) ?? null;
  }

  private claim(args: Record<string, unknown>): SupabaseQueryResult<unknown> {
    const key = attemptKey(args);
    const leaseMs = Number(args.lease_seconds ?? 30) * 1000;
    const existing = this.attempts.get(key);
    if (existing === undefined) {
      this.attempts.set(key, { status: "claimed", claimedAtMs: this.nowMs });
      return { data: { outcome: "claimed" }, error: null };
    }
    if (existing.status === "completed") {
      return { data: completedPayload(existing), error: null };
    }
    if (existing.status === "failed" || this.nowMs - existing.claimedAtMs >= leaseMs) {
      existing.status = "claimed";
      existing.claimedAtMs = this.nowMs;
      existing.proposalJson = undefined;
      existing.usageInput = undefined;
      existing.usageOutput = undefined;
      return { data: { outcome: "claimed" }, error: null };
    }

    return { data: { outcome: "in_progress" }, error: null };
  }

  private complete(args: Record<string, unknown>): SupabaseQueryResult<unknown> {
    const key = attemptKey(args);
    const existing = this.attempts.get(key);
    if (existing === undefined) {
      return { data: null, error: { message: "router attempt is not claimed" } };
    }
    if (existing.status !== "completed") {
      existing.status = "completed";
      existing.proposalJson = String(args.new_proposal_json);
      existing.usageInput = Number(args.new_usage_input);
      existing.usageOutput = Number(args.new_usage_output);
    }

    return { data: completedPayload(existing), error: null };
  }

  private fail(args: Record<string, unknown>): SupabaseQueryResult<unknown> {
    const key = attemptKey(args);
    const existing = this.attempts.get(key);
    if (existing !== undefined && existing.status === "claimed") {
      existing.status = "failed";
    }

    return { data: null, error: null };
  }

  private debit(args: Record<string, unknown>): SupabaseQueryResult<unknown> {
    const key = attemptKey({ target_user: args.target_user, idem_key: args.idem_key });
    if (this.forcedDuplicateOnce !== null) {
      const route = this.forcedDuplicateOnce;
      this.forcedDuplicateOnce = null;
      if (!this.ledger.has(key)) {
        this.ledger.set(key, route);
      }
      return { data: { status: "duplicate" }, error: null };
    }
    if (this.failNextDebitWithoutWriting) {
      this.failNextDebitWithoutWriting = false;
      return { data: null, error: { message: "database unavailable" } };
    }
    if (this.ledger.has(key)) {
      return { data: { status: "duplicate" }, error: null };
    }

    const userId = String(args.target_user);
    const debitCents = Number(args.debit_cents);
    const balance = this.balances.get(userId) ?? 0;
    if (balance < debitCents) {
      return { data: { status: "insufficient", balance }, error: null };
    }

    const nextBalance = balance - debitCents;
    this.balances.set(userId, nextBalance);
    this.ledger.set(key, args.usage_metadata);

    if (this.loseNextDebitResponseAfterCommit) {
      this.loseNextDebitResponseAfterCommit = false;
      return { data: null, error: { message: "response lost" } };
    }

    return { data: { status: "ok", balance: nextBalance }, error: null };
  }
}

interface StoredRouteProposalLike {
  proposalJson: string;
  usage: { input: number; output: number };
}

function attemptKey(args: Record<string, unknown>): string {
  return `${String(args.target_user)}:${String(args.idem_key)}`;
}

function completedPayload(row: FakeRouterAttemptRow): Record<string, unknown> {
  return {
    outcome: "completed",
    proposal_json: row.proposalJson,
    usage_input: row.usageInput,
    usage_output: row.usageOutput,
  };
}

class FakeLedgerQuery<T> implements SupabaseQueryBuilderLike<T> {
  private readonly filters: Record<string, unknown> = {};

  constructor(private readonly supabase: FakeRouterServiceSupabase) {}

  select(): SupabaseQueryBuilderLike<T> {
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryBuilderLike<T> {
    this.filters[column] = value;
    return this;
  }

  is(column: string, value: unknown): SupabaseQueryBuilderLike<T> {
    return this.eq(column, value);
  }

  order(): SupabaseQueryBuilderLike<T> {
    return this;
  }

  range(): SupabaseQueryBuilderLike<T> {
    return this;
  }

  async maybeSingle(): Promise<SupabaseQueryResult<T | null>> {
    const userId = String(this.filters.user_id);
    const idempotencyKey = String(this.filters.idempotency_key);
    const metadata = this.supabase.readLedgerRoute(userId, idempotencyKey);

    return { data: metadata === null ? null : ({ metadata } as T), error: null };
  }

  then<TResult1 = SupabaseQueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.maybeSingle().then(
      onfulfilled as (value: SupabaseQueryResult<T | null>) => TResult1 | PromiseLike<TResult1>,
      onrejected,
    );
  }
}

function scopedDebitSupabase(initialBalances: Record<string, number>): Pick<SupabaseClientLike, "rpc"> {
  const balances = new Map(Object.entries(initialBalances));
  const debits = new Set<string>();

  return {
    async rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<SupabaseQueryResult<T>> {
      if (fn !== "debit_credits") {
        return { data: null, error: { message: `Unknown rpc: ${fn}` } };
      }

      const userId = String(args?.target_user);
      const idempotencyKey = String(args?.idem_key);
      const debitCents = Number(args?.debit_cents);
      const debitKey = `${userId}:${idempotencyKey}`;
      if (debits.has(debitKey)) {
        return { data: { status: "duplicate" } as T, error: null };
      }

      const balance = balances.get(userId) ?? 0;
      if (balance < debitCents) {
        return { data: { status: "insufficient", balance } as T, error: null };
      }

      const nextBalance = balance - debitCents;
      balances.set(userId, nextBalance);
      debits.add(debitKey);

      return { data: { status: "ok", balance: nextBalance } as T, error: null };
    },
  };
}

function routeRequest(
  commandText: string,
  context?: { projectName?: string; chatNames?: string[]; widgetLabels?: string[] },
  idempotencyKey = "router:attempt-1",
): Request {
  return new Request("https://edge.test", {
    method: "POST",
    headers: { Authorization: "Bearer token", "x-idempotency-key": idempotencyKey },
    body: JSON.stringify(context === undefined ? { commandText } : { commandText, context }),
  });
}

function expectBoundaryViolation(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code: "boundary_violation" });
    return;
  }

  throw new Error("Expected a boundary violation");
}
