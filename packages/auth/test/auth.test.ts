import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPickforgeAuthClient, type PickforgeStorageAdapter } from "../src/index.js";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

const storage: PickforgeStorageAdapter = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};

describe("@pickforge/auth", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("starts OAuth with PKCE and opens the provider URL externally", async () => {
    const supabase = mockSupabase();
    const openExternalUrl = vi.fn();
    const client = createPickforgeAuthClient({
      openExternalUrl,
      redirectUri: "pickforge://auth/callback",
      storage,
      supabaseAnonKey: "anon",
      supabaseUrl: "https://project.supabase.co",
    });

    await expect(client.startOAuth("github")).resolves.toEqual({
      url: "https://auth.example/oauth",
    });

    expect(mocks.createClient).toHaveBeenCalledWith(
      "https://project.supabase.co",
      "anon",
      expect.objectContaining({
        auth: expect.objectContaining({
          detectSessionInUrl: false,
          flowType: "pkce",
          storage,
        }),
      }),
    );
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: {
        redirectTo: "pickforge://auth/callback",
        skipBrowserRedirect: true,
      },
    });
    expect(openExternalUrl).toHaveBeenCalledWith("https://auth.example/oauth");
  });

  it("exchanges a deep-link redirect code for a session", async () => {
    const session = sessionFor("user-1");
    const supabase = mockSupabase({ session });
    const client = createPickforgeAuthClient(baseConfig());

    await expect(client.handleRedirect("pickforge://auth/callback?code=abc123")).resolves.toBe(
      session,
    );
    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith("abc123");
  });

  it("signs out and clears the entitlement cache", async () => {
    const supabase = mockSupabase({
      entitlementRows: [
        {
          expires_at: null,
          granted_at: "2026-07-05T12:00:00Z",
          key: "forge_pass",
          value: true,
        },
      ],
      session: sessionFor("user-1"),
    });
    const client = createPickforgeAuthClient(baseConfig());

    await client.getEntitlements();
    await client.signOut();
    await client.getEntitlements();

    expect(supabase.auth.signOut).toHaveBeenCalledOnce();
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it("caches entitlements and refreshes after cache expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const supabase = mockSupabase({
      entitlementRows: [
        {
          expires_at: null,
          granted_at: "2026-07-05T12:00:00Z",
          key: "forge_pass",
          value: { plan: "pro" },
        },
        {
          expires_at: "2026-07-04T12:00:00Z",
          granted_at: "2026-07-01T12:00:00Z",
          key: "expired_pack",
          value: true,
        },
      ],
      session: sessionFor("user-1"),
    });
    const client = createPickforgeAuthClient({
      ...baseConfig(),
      entitlementCacheTtlMs: 100,
    });

    await expect(client.getEntitlements()).resolves.toEqual([
      {
        expiresAt: null,
        grantedAt: "2026-07-05T12:00:00Z",
        key: "forge_pass",
        value: { plan: "pro" },
      },
    ]);
    await client.getEntitlements();
    vi.advanceTimersByTime(101);
    await client.getEntitlements();

    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it("subscribes to auth state changes and returns an unsubscribe function", () => {
    const unsubscribe = vi.fn();
    mockSupabase({
      authStateSubscription: { unsubscribe },
    });
    const listener = vi.fn();
    const client = createPickforgeAuthClient(baseConfig());

    const stop = client.onAuthStateChange(listener);
    stop();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

function baseConfig() {
  return {
    openExternalUrl: vi.fn(),
    redirectUri: "pickforge://auth/callback",
    storage,
    supabaseAnonKey: "anon",
    supabaseUrl: "https://project.supabase.co",
  };
}

function sessionFor(userId: string) {
  return {
    access_token: "access",
    expires_at: 1_785_000_000,
    expires_in: 3600,
    refresh_token: "refresh",
    token_type: "bearer",
    user: {
      id: userId,
    },
  };
}

function mockSupabase(options: {
  authStateSubscription?: { unsubscribe: () => void };
  entitlementRows?: unknown[];
  session?: unknown;
} = {}) {
  const order = vi.fn(async () => ({ data: options.entitlementRows ?? [], error: null }));
  const eq = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ eq }));
  const supabase = {
    auth: {
      exchangeCodeForSession: vi.fn(async () => ({
        data: { session: options.session ?? sessionFor("user-1") },
        error: null,
      })),
      getSession: vi.fn(async () => ({
        data: { session: options.session ?? sessionFor("user-1") },
        error: null,
      })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: options.authStateSubscription ?? { unsubscribe: vi.fn() } },
      })),
      refreshSession: vi.fn(async () => ({
        data: { session: options.session ?? sessionFor("user-1") },
        error: null,
      })),
      signInWithOAuth: vi.fn(async () => ({
        data: { url: "https://auth.example/oauth" },
        error: null,
      })),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: vi.fn(() => ({ select })),
  };
  mocks.createClient.mockReturnValue(supabase);
  return supabase;
}
