import { describe, expect, it, vi } from "vitest";
import {
  EdgeSharedError,
  assertRouteRequest,
  corsPreflightResponse,
  createDeleteAccountHandler,
  createExportAccountHandler,
  createOperatorRouterHandler,
  createStripeWebhookHandler,
  debitCredits,
  getBearerToken,
  getUserFromRequest,
  jsonResponse,
  newIdempotencyKey,
  operatorRouterSystemPrompt,
  requireEntitlement,
  type EdgeSharedJson,
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

  it("deletes the Stripe customer before deleting the authenticated user", async () => {
    const admin = accountAdmin({ billing_customers: [{ user_id: USER_ID, stripe_customer_id: "cus_123" }] });
    const stripe = { customers: { del: vi.fn(async () => ({})) } };
    const handler = createDeleteAccountHandler({
      admin,
      stripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(stripe.customers.del).toHaveBeenCalledWith("cus_123");
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(USER_ID);
    expect(stripe.customers.del.mock.invocationCallOrder[0]!).toBeLessThan(admin.auth.admin.deleteUser.mock.invocationCallOrder[0]!);
  });

  it("deletes the user without a Stripe customer", async () => {
    const noCustomerAdmin = accountAdmin();
    const noCustomerStripe = { customers: { del: vi.fn(async () => ({})) } };
    const noCustomerHandler = createDeleteAccountHandler({
      admin: noCustomerAdmin,
      stripe: noCustomerStripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    await expect(noCustomerHandler(new Request("https://edge.test", { method: "POST" }))).resolves.toMatchObject({
      status: 200,
    });
    expect(noCustomerStripe.customers.del).not.toHaveBeenCalled();
    expect(noCustomerAdmin.auth.admin.deleteUser).toHaveBeenCalledWith(USER_ID);
  });

  it("preserves the account when Stripe deletion fails and retries safely after a missing customer", async () => {
    const failingStripeAdmin = accountAdmin({ billing_customers: [{ user_id: USER_ID, stripe_customer_id: "cus_456" }] });
    const failingStripe = { customers: { del: vi.fn(async () => Promise.reject(new Error("Stripe unavailable"))) } };
    const failingStripeHandler = createDeleteAccountHandler({
      admin: failingStripeAdmin,
      stripe: failingStripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const failedResponse = await failingStripeHandler(new Request("https://edge.test", { method: "POST" }));
    expect(failedResponse.status).toBe(503);
    await expect(failedResponse.json()).resolves.toEqual({ error: "deletion_incomplete" });
    expect(failingStripeAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();

    const missingStripeAdmin = accountAdmin({ billing_customers: [{ user_id: USER_ID, stripe_customer_id: "cus_789" }] });
    const missingStripe = {
      customers: { del: vi.fn(async () => Promise.reject({ code: "resource_missing" })) },
    };
    const missingStripeHandler = createDeleteAccountHandler({
      admin: missingStripeAdmin,
      stripe: missingStripe,
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const missingResponse = await missingStripeHandler(new Request("https://edge.test", { method: "POST" }));
    expect(missingResponse.status).toBe(200);
    await expect(missingResponse.json()).resolves.toEqual({ deleted: true });
    expect(missingStripeAdmin.auth.admin.deleteUser).toHaveBeenCalledWith(USER_ID);
  });

  it("treats a missing auth user as deleted and returns 500 for other deletion failures", async () => {
    const missingUserAdmin = accountAdmin();
    missingUserAdmin.auth.admin.deleteUser.mockResolvedValue({ error: { code: "user_not_found", message: "User not found" } });
    const missingUserHandler = createDeleteAccountHandler({
      admin: missingUserAdmin,
      stripe: { customers: { del: vi.fn() } },
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const missingUserResponse = await missingUserHandler(new Request("https://edge.test", { method: "POST" }));
    expect(missingUserResponse.status).toBe(200);
    await expect(missingUserResponse.json()).resolves.toEqual({ deleted: true });

    const failedDeleteAdmin = accountAdmin();
    failedDeleteAdmin.auth.admin.deleteUser.mockResolvedValue({ error: { message: "Database unavailable" } });
    const failedDeleteHandler = createDeleteAccountHandler({
      admin: failedDeleteAdmin,
      stripe: { customers: { del: vi.fn() } },
      resolveUserId: vi.fn(async () => USER_ID),
    });

    const failedDeleteResponse = await failedDeleteHandler(new Request("https://edge.test", { method: "POST" }));
    expect(failedDeleteResponse.status).toBe(500);
    await expect(failedDeleteResponse.json()).resolves.toEqual({ error: "internal_error" });
  });

  it("returns unauthorized for account deletion without an authenticated user", async () => {
    const handler = createDeleteAccountHandler({
      admin: accountAdmin(),
      stripe: { customers: { del: vi.fn() } },
      resolveUserId: async () => {
        throw new EdgeSharedError("unauthorized", "Unauthorized");
      },
    });

    const response = await handler(new Request("https://edge.test", { method: "POST" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
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
    expect(processStripeEvent).toHaveBeenCalledWith({ supabase, event });
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

    const response = await handler(
      new Request("https://edge.test", {
        method: "POST",
        headers: { "stripe-signature": "sig_123" },
        body: "{}",
      }),
    );

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

  it("routes a valid command then debits with a namespaced key", async () => {
    const supabase = new MemorySupabase();
    const debit = vi.fn(async () => ({ duplicate: false as const, balance: 98 }));
    const chatComplete = vi.fn(async () => ({
      text: "{\"action\":{\"action\":\"openProject\"},\"confidence\":0.9}",
      usage: { input: 42, output: 13 },
    }));
    const handler = createOperatorRouterHandler({
      supabase,
      findCompletedRoute: vi.fn(async () => null),
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      debit,
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
    expect(debit).toHaveBeenCalledWith({
      userId: USER_ID,
      amountCents: 2,
      reason: "Operator routing",
      idempotencyKey: `router:${USER_ID}:router:attempt-1`,
      metadata: {
        proposalJson: "{\"action\":{\"action\":\"openProject\"},\"confidence\":0.9}",
        usage: { input: 42, output: 13 },
      },
    });
    expect(chatComplete).toHaveBeenCalledOnce();
  });

  it("returns insufficient credits without calling the model", async () => {
    const supabase = new MemorySupabase();
    const chatComplete = vi.fn();
    const handler = createOperatorRouterHandler({
      supabase,
      findCompletedRoute: vi.fn(async () => null),
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 1),
      debit: vi.fn(),
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
  });

  it("returns a stored proposal without calling the model for a replay", async () => {
    const supabase = new MemorySupabase();
    const debit = vi.fn(async () => ({ duplicate: false as const, balance: 98 }));
    const chatComplete = vi.fn(async () => ({ text: "{}", usage: { input: 1, output: 1 } }));
    const handler = createOperatorRouterHandler({
      supabase,
      findCompletedRoute: vi.fn(async () => ({ proposalJson: "{\"stored\":true}", usage: { input: 3, output: 2 } })),
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      debit,
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
    expect(debit).not.toHaveBeenCalled();
  });

  it("rejects forbidden attached context before debiting or calling the model", async () => {
    const supabase = new MemorySupabase();
    const debit = vi.fn();
    const chatComplete = vi.fn();
    const handler = createOperatorRouterHandler({
      supabase,
      findCompletedRoute: vi.fn(async () => null),
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      debit,
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
    expect(debit).not.toHaveBeenCalled();
    expect(chatComplete).not.toHaveBeenCalled();
  });

  it("does not debit a failed route and allows a retry", async () => {
    const supabase = new MemorySupabase();
    const debit = vi.fn(async () => ({ duplicate: false as const, balance: 98 }));
    const chatComplete = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ text: "{}", usage: { input: 1, output: 1 } });
    const handler = createOperatorRouterHandler({
      supabase,
      findCompletedRoute: vi.fn(async () => null),
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      debit,
      chatComplete,
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    await expect(handler(routeRequest("open project Billing"))).resolves.toMatchObject({ status: 500 });
    expect(debit).not.toHaveBeenCalled();
    await expect(handler(routeRequest("open project Billing"))).resolves.toMatchObject({ status: 200 });
    expect(debit).toHaveBeenCalledOnce();
  });

  it("returns the stored result after a concurrent duplicate debit", async () => {
    const stored = { proposalJson: "{\"stored\":true}", usage: { input: 5, output: 3 } };
    const findCompletedRoute = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(stored);
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      findCompletedRoute,
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      debit: vi.fn(async () => ({ duplicate: true as const })),
      chatComplete: vi.fn(async () => ({ text: "{\"fresh\":true}", usage: { input: 1, output: 1 } })),
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    const response = await handler(routeRequest("open project Billing"));
    await expect(response.json()).resolves.toEqual({ ...stored, costCents: 2 });
    expect(findCompletedRoute).toHaveBeenCalledTimes(2);
  });

  it("returns the stored proposal when a committed debit loses its response", async () => {
    const stored = { proposalJson: "{\"stored\":true}", usage: { input: 5, output: 3 } };
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      findCompletedRoute: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(stored),
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      debit: vi.fn(async () => {
        throw new Error("response lost");
      }),
      chatComplete: vi.fn(async () => ({ text: "{\"fresh\":true}", usage: { input: 1, output: 1 } })),
      model: "gpt-5.4-mini",
      apiKey: "key",
      baseUrl: "https://api.openai.com/v1",
      creditCostCents: 2,
    });

    const response = await handler(routeRequest("open project Billing"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ...stored, costCents: 2 });
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
    const debit = vi.fn(async () => ({ duplicate: false as const, balance: 98 }));
    const chatComplete = vi.fn(async () => ({ text: "{}", usage: { input: 1, output: 1 } }));
    let attempts = 0;
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      findCompletedRoute: vi.fn(async () => null),
      consumeRateLimit: vi.fn(async () => ++attempts <= 10),
      getCreditBalance: vi.fn(async () => 100),
      debit,
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
    expect(debit).toHaveBeenCalledTimes(10);
    expect(chatComplete).toHaveBeenCalledTimes(10);
  });

  it("maps invalid JSON to a boundary violation", async () => {
    const handler = createOperatorRouterHandler({
      supabase: new MemorySupabase(),
      findCompletedRoute: vi.fn(async () => null),
      consumeRateLimit: vi.fn(async () => true),
      getCreditBalance: vi.fn(async () => 100),
      debit: vi.fn(),
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
  });
});

interface EntitlementRow {
  user_id: string;
  key: string;
  value?: EdgeSharedJson;
  expires_at: string | null;
}

function accountAdmin(rows: Record<string, unknown[]> = {}) {
  return {
    auth: {
      admin: {
        deleteUser: vi.fn<(userId: string) => Promise<{ error: SupabaseErrorLike | null }>>(
          async (_userId) => ({ error: null }),
        ),
      },
    },
    from<T = unknown>(table: string): AccountQuery<T> {
      return new AccountQuery<T>(rows[table] ?? []);
    },
  };
}

class AccountQuery<T> implements SupabaseQueryBuilderLike<T> {
  private readonly filters: Array<{ column: string; value: unknown }> = [];

  constructor(private readonly rows: unknown[]) {}

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

  async maybeSingle(): Promise<SupabaseQueryResult<T | null>> {
    return { data: (this.filteredRows()[0] ?? null) as T | null, error: null };
  }

  then<TResult1 = SupabaseQueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.filteredRows() as T, error: null }).then(onfulfilled, onrejected);
  }

  private filteredRows(): unknown[] {
    return this.rows.filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        this.filters.every((filter) => (row as Record<string, unknown>)[filter.column] === filter.value),
    );
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
