export type EdgeSharedErrorCode =
  | "database_error"
  | "entitlement_required"
  | "insufficient_credits"
  | "invalid_debit_amount"
  | "invalid_idempotency_key"
  | "invalid_rpc_result"
  | "invalid_string"
  | "invalid_stripe_webhook_config"
  | "unauthorized";

export type EdgeSharedJson =
  | string
  | number
  | boolean
  | null
  | EdgeSharedJson[]
  | { [key: string]: EdgeSharedJson };

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

export interface SupabaseAuthUserLike {
  id: string;
}

export interface SupabaseAuthLike {
  getUser(jwt: string): PromiseLike<SupabaseQueryResult<{ user: SupabaseAuthUserLike | null }>>;
}

export interface SupabaseQueryBuilderLike<T = unknown> extends PromiseLike<SupabaseQueryResult<T>> {
  select(columns?: string): SupabaseQueryBuilderLike<T>;
  eq(column: string, value: unknown): SupabaseQueryBuilderLike<T>;
  maybeSingle(): PromiseLike<SupabaseQueryResult<T | null>>;
}

export interface SupabaseClientLike {
  auth: SupabaseAuthLike;
  from<T = unknown>(table: string): SupabaseQueryBuilderLike<T>;
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<SupabaseQueryResult<T>>;
}

export class EdgeSharedError extends Error {
  readonly code: EdgeSharedErrorCode;
  readonly balance?: number;

  constructor(
    code: EdgeSharedErrorCode,
    message: string,
    options: { cause?: unknown; balance?: number } = {},
  ) {
    super(message);
    this.name = "EdgeSharedError";
    this.code = code;
    this.cause = options.cause;
    this.balance = options.balance;
  }
}

export interface GetUserFromRequestOptions {
  supabase: Pick<SupabaseClientLike, "auth">;
  req: Request;
}

export interface GetUserFromRequestResult {
  userId: string;
}

export interface RequireEntitlementOptions {
  supabase: Pick<SupabaseClientLike, "from">;
  userId: string;
  key: string;
}

export interface DebitCreditsOptions {
  supabase: Pick<SupabaseClientLike, "rpc">;
  userId: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
}

export type DebitCreditsResult =
  | {
      duplicate: true;
    }
  | {
      duplicate: false;
      balance: number;
    };

export type StripeWebhookPayload = string | Uint8Array | ArrayBuffer;

export interface StripeEventLike {
  id: string;
  type: string;
  data: {
    object: unknown;
  };
}

export interface VerifyStripeEventOptions<TStripe = unknown> {
  payload: StripeWebhookPayload;
  signature: string;
  secret: string;
  stripe: TStripe;
}

export interface ProcessStripeEventOptions<TSupabase = unknown> {
  supabase: TSupabase;
  event: StripeEventLike;
}

export interface StripeWebhookProcessResult {
  handled: boolean;
  duplicate: boolean;
}

export interface CreateStripeWebhookHandlerOptions<TStripe = unknown, TSupabase = unknown> {
  stripe: TStripe;
  supabase: TSupabase;
  webhookSecret: string;
  verifyStripeEvent(options: VerifyStripeEventOptions<TStripe>): Promise<StripeEventLike>;
  processStripeEvent(options: ProcessStripeEventOptions<TSupabase>): Promise<StripeWebhookProcessResult>;
}

interface EntitlementRow {
  value?: EdgeSharedJson;
  expires_at: string | null;
}

type DebitCreditsRpcResult =
  | {
      status: "duplicate";
    }
  | {
      status: "insufficient";
      balance: number;
    }
  | {
      status: "ok";
      balance: number;
    };

export function getBearerToken(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization === null) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();

  return token === undefined || token.length === 0 ? null : token;
}

export async function getUserFromRequest({
  supabase,
  req,
}: GetUserFromRequestOptions): Promise<GetUserFromRequestResult> {
  const token = getBearerToken(req);
  if (token === null) {
    throw new EdgeSharedError("unauthorized", "Request is missing a bearer token");
  }

  const { data, error } = await supabase.auth.getUser(token);
  const userId = data?.user?.id;
  if (error !== null || typeof userId !== "string" || userId.length === 0) {
    throw new EdgeSharedError("unauthorized", "Request is not authorized", {
      cause: error ?? undefined,
    });
  }

  return { userId };
}

export async function requireEntitlement({
  supabase,
  userId,
  key,
}: RequireEntitlementOptions): Promise<EdgeSharedJson> {
  const validUserId = validateNonEmptyString(userId, "userId", "invalid_string");
  const validKey = validateNonEmptyString(key, "key", "invalid_string");
  const { data, error } = await supabase
    .from<EntitlementRow>("entitlements")
    .select("value,expires_at")
    .eq("user_id", validUserId)
    .eq("key", validKey)
    .maybeSingle();
  if (error !== null) {
    throw databaseError("Failed to read entitlement", error);
  }
  if (data === null || isExpired(data.expires_at)) {
    throw new EdgeSharedError("entitlement_required", "Required entitlement is missing or expired");
  }

  return data.value === undefined ? true : data.value;
}

export async function debitCredits({
  supabase,
  userId,
  amountCents,
  reason,
  idempotencyKey,
}: DebitCreditsOptions): Promise<DebitCreditsResult> {
  const validUserId = validateNonEmptyString(userId, "userId", "invalid_string");
  const validAmount = validatePositiveInteger(amountCents, "amountCents");
  const validReason = validateNonEmptyString(reason, "reason", "invalid_string");
  const validIdempotencyKey = validateNonEmptyString(
    idempotencyKey,
    "idempotencyKey",
    "invalid_idempotency_key",
  );

  const { data, error } = await supabase.rpc<DebitCreditsRpcResult>("debit_credits", {
    target_user: validUserId,
    debit_cents: validAmount,
    reason: validReason,
    idem_key: validIdempotencyKey,
  });
  if (error !== null) {
    throw databaseError("Failed to debit credits", error);
  }

  if (!isRecord(data) || typeof data.status !== "string") {
    throw invalidRpcResult();
  }

  if (data.status === "duplicate") {
    return { duplicate: true };
  }

  if (data.status === "insufficient") {
    const balance = readBalance(data);
    throw new EdgeSharedError("insufficient_credits", "Not enough credits", { balance });
  }

  if (data.status === "ok") {
    return { duplicate: false, balance: readBalance(data) };
  }

  throw invalidRpcResult();
}

export function newIdempotencyKey(scope: string, uniquePart: string): string {
  return `${validateNonEmptyString(scope, "scope", "invalid_idempotency_key")}:${validateNonEmptyString(
    uniquePart,
    "uniquePart",
    "invalid_idempotency_key",
  )}`;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

export function createStripeWebhookHandler<TStripe = unknown, TSupabase = unknown>({
  stripe,
  supabase,
  webhookSecret,
  verifyStripeEvent,
  processStripeEvent,
}: CreateStripeWebhookHandlerOptions<TStripe, TSupabase>): (req: Request) => Promise<Response> {
  const validWebhookSecret = validateNonEmptyString(
    webhookSecret,
    "webhookSecret",
    "invalid_stripe_webhook_config",
  );

  return async (req: Request): Promise<Response> => {
    const signature = req.headers.get("stripe-signature");
    if (signature === null || signature.trim().length === 0) {
      return jsonResponse(400, { error: "missing_stripe_signature" });
    }

    let event: StripeEventLike;
    try {
      event = await verifyStripeEvent({
        payload: await req.text(),
        signature,
        secret: validWebhookSecret,
        stripe,
      });
    } catch (error) {
      return jsonResponse(400, { error: "invalid_stripe_signature" });
    }

    try {
      return jsonResponse(200, await processStripeEvent({ supabase, event }));
    } catch (error) {
      return jsonResponse(500, { error: "webhook_processing_failed" });
    }
  };
}

function validateNonEmptyString(
  value: unknown,
  field: string,
  code: Extract<EdgeSharedErrorCode, "invalid_idempotency_key" | "invalid_string" | "invalid_stripe_webhook_config">,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EdgeSharedError(code, `${field} must be a non-empty string`);
  }

  return value;
}

function validatePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new EdgeSharedError("invalid_debit_amount", `${field} must be a positive integer`);
  }

  return value;
}

function readBalance(value: Record<string, unknown>): number {
  const balance = value.balance;
  if (typeof balance !== "number" || !Number.isSafeInteger(balance)) {
    throw invalidRpcResult();
  }

  return balance;
}

function isExpired(expiresAt: string | null): boolean {
  if (expiresAt === null) {
    return false;
  }

  const expiresAtMs = Date.parse(expiresAt);

  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRpcResult(): EdgeSharedError {
  return new EdgeSharedError("invalid_rpc_result", "Supabase returned an invalid debit response");
}

function databaseError(message: string, cause: SupabaseErrorLike): EdgeSharedError {
  return new EdgeSharedError("database_error", message, { cause });
}
