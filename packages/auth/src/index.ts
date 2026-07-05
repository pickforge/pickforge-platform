import {
  createClient,
  type AuthChangeEvent,
  type Provider,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";

export type PickforgeOAuthProvider = "google" | "github";

export type PickforgeJson =
  | string
  | number
  | boolean
  | null
  | PickforgeJson[]
  | { [key: string]: PickforgeJson };

export interface PickforgeStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface PickforgeRedirectListenerAdapter {
  listen(listener: (url: string) => void | Promise<void>): void | (() => void | Promise<void>);
}

export interface PickforgeAuthConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  redirectUri: string;
  storage: PickforgeStorageAdapter;
  openExternalUrl(url: string): void | Promise<void>;
  redirectListener?: PickforgeRedirectListenerAdapter;
  entitlementCacheTtlMs?: number;
}

export interface PickforgeAuthStateChange {
  event: AuthChangeEvent;
  session: Session | null;
}

export interface PickforgeEntitlement {
  key: string;
  value: PickforgeJson;
  expiresAt: string | null;
  grantedAt: string;
}

export interface GetEntitlementsOptions {
  forceRefresh?: boolean;
}

export interface StartOAuthResult {
  url: string;
}

export interface PickforgeAuthClient {
  startOAuth(provider: PickforgeOAuthProvider): Promise<StartOAuthResult>;
  handleRedirect(url: string): Promise<Session>;
  getSession(): Promise<Session | null>;
  refreshSession(): Promise<Session | null>;
  signOut(): Promise<void>;
  getEntitlements(options?: GetEntitlementsOptions): Promise<PickforgeEntitlement[]>;
  onAuthStateChange(listener: (change: PickforgeAuthStateChange) => void): () => void;
}

interface EntitlementRow {
  key: string;
  value: PickforgeJson | null;
  expires_at: string | null;
  granted_at: string;
}

interface EntitlementCache {
  expiresAtMs: number;
  userId: string;
  entitlements: PickforgeEntitlement[];
}

const DEFAULT_ENTITLEMENT_CACHE_TTL_MS = 5 * 60 * 1000;

export function createPickforgeAuthClient(config: PickforgeAuthConfig): PickforgeAuthClient {
  validateConfig(config);

  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
      persistSession: true,
      storage: config.storage,
    },
  });
  const cacheTtlMs = config.entitlementCacheTtlMs ?? DEFAULT_ENTITLEMENT_CACHE_TTL_MS;
  let entitlementCache: EntitlementCache | null = null;

  const clearEntitlementCache = (): void => {
    entitlementCache = null;
  };

  const client: PickforgeAuthClient = {
    async startOAuth(provider) {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: provider satisfies Provider,
        options: {
          redirectTo: config.redirectUri,
          skipBrowserRedirect: true,
        },
      });
      if (error !== null) {
        throw error;
      }
      if (typeof data.url !== "string" || data.url.length === 0) {
        throw new Error("Supabase did not return an OAuth URL");
      }
      await config.openExternalUrl(data.url);
      return { url: data.url };
    },

    async handleRedirect(url) {
      const parsed = parseRedirectUrl(url);
      const { data, error } = await supabase.auth.exchangeCodeForSession(parsed.code);
      if (error !== null) {
        throw error;
      }
      if (data.session === null) {
        throw new Error("Supabase did not return a session");
      }
      clearEntitlementCache();
      return data.session;
    },

    async getSession() {
      const { data, error } = await supabase.auth.getSession();
      if (error !== null) {
        throw error;
      }
      return data.session;
    },

    async refreshSession() {
      const { data, error } = await supabase.auth.refreshSession();
      if (error !== null) {
        throw error;
      }
      clearEntitlementCache();
      return data.session;
    },

    async signOut() {
      const { error } = await supabase.auth.signOut();
      if (error !== null) {
        throw error;
      }
      clearEntitlementCache();
    },

    async getEntitlements(options = {}) {
      const session = await client.getSession();
      const userId = session?.user.id;
      if (userId === undefined) {
        clearEntitlementCache();
        return [];
      }

      const now = Date.now();
      if (
        options.forceRefresh !== true &&
        entitlementCache !== null &&
        entitlementCache.userId === userId &&
        entitlementCache.expiresAtMs > now
      ) {
        return entitlementCache.entitlements;
      }

      const { data, error } = await supabase
        .from("entitlements")
        .select("key,value,expires_at,granted_at")
        .eq("user_id", userId)
        .order("key", { ascending: true });
      if (error !== null) {
        throw error;
      }

      const entitlements = (data ?? [])
        .map(toEntitlement)
        .filter((entitlement) => entitlement.expiresAt === null || Date.parse(entitlement.expiresAt) > now);
      entitlementCache = {
        entitlements,
        expiresAtMs: now + cacheTtlMs,
        userId,
      };
      return entitlements;
    },

    onAuthStateChange(listener) {
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
          clearEntitlementCache();
        }
        listener({ event, session });
      });
      return () => data.subscription.unsubscribe();
    },
  };

  config.redirectListener?.listen((url) => {
    void client.handleRedirect(url);
  });

  return client;
}

function toEntitlement(row: EntitlementRow): PickforgeEntitlement {
  return {
    key: row.key,
    value: row.value ?? true,
    expiresAt: row.expires_at,
    grantedAt: row.granted_at,
  };
}

function parseRedirectUrl(url: string): { code: string } {
  const parsed = new URL(url);
  const error = parsed.searchParams.get("error") ?? parsed.searchParams.get("error_description");
  if (error !== null) {
    throw new Error(`OAuth redirect failed: ${error}`);
  }
  const code = parsed.searchParams.get("code");
  if (code === null || code.length === 0) {
    throw new Error("OAuth redirect URL is missing a code");
  }
  return { code };
}

function validateConfig(config: PickforgeAuthConfig): void {
  if (!isNonEmptyString(config.supabaseUrl)) {
    throw new Error("supabaseUrl is required");
  }
  if (!isNonEmptyString(config.supabaseAnonKey)) {
    throw new Error("supabaseAnonKey is required");
  }
  if (!isNonEmptyString(config.redirectUri)) {
    throw new Error("redirectUri is required");
  }
  if (config.storage === undefined) {
    throw new Error("storage is required");
  }
  if (typeof config.openExternalUrl !== "function") {
    throw new Error("openExternalUrl is required");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
