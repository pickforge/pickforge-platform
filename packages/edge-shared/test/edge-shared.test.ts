import { describe, expect, it, vi } from "vitest";
import {
  EdgeSharedError,
  createStripeWebhookHandler,
  debitCredits,
  getBearerToken,
  getUserFromRequest,
  jsonResponse,
  newIdempotencyKey,
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
});

interface EntitlementRow {
  user_id: string;
  key: string;
  value?: EdgeSharedJson;
  expires_at: string | null;
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
