export type EdgeSharedErrorCode =
  | "database_error"
  | "deletion_in_progress"
  | "deletion_incomplete"
  | "entitlement_required"
  | "insufficient_credits"
  | "invalid_debit_amount"
  | "invalid_idempotency_key"
  | "invalid_rpc_result"
  | "boundary_violation"
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
  is(column: string, value: null): SupabaseQueryBuilderLike<T>;
  order(column: string, options?: { ascending?: boolean }): SupabaseQueryBuilderLike<T>;
  range(from: number, to: number): SupabaseQueryBuilderLike<T>;
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
  metadata?: { [key: string]: EdgeSharedJson };
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

export interface ProcessStripeEventOptions<TStripe = unknown, TSupabase = unknown> {
  stripe: TStripe;
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
  processStripeEvent(options: ProcessStripeEventOptions<TStripe, TSupabase>): Promise<StripeWebhookProcessResult>;
}

export interface RouteRequestContext {
  projectName?: string;
  chatNames?: string[];
  widgetLabels?: string[];
}

export interface RouteRequest {
  commandText: string;
  context?: RouteRequestContext;
}

export interface ChatCompletionUsage {
  input: number;
  output: number;
}

export interface ChatCompletionResult {
  text: string;
  usage: ChatCompletionUsage;
}

export interface CreateOperatorRouterHandlerOptions {
  supabase: Pick<SupabaseClientLike, "auth">;
  serviceSupabase: Pick<SupabaseClientLike, "from" | "rpc">;
  getCreditBalance(userId: string): Promise<number>;
  consumeRateLimit(userId: string): Promise<boolean>;
  chatComplete(options: {
    model: string;
    apiKey: string;
    baseUrl: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<ChatCompletionResult>;
  model: string;
  apiKey: string;
  baseUrl: string;
  creditCostCents: number;
  systemPrompt?: string;
  /** How long a claim may go unconfirmed before another caller may recover it. Defaults to 30 seconds. */
  attemptLeaseSeconds?: number;
}

export interface AccountAdminClientLike {
  auth: {
    admin: {
      deleteUser(userId: string): PromiseLike<{ error: SupabaseErrorLike | null }>;
    };
  };
  from(table: string): unknown;
  rpc(fn: string, args?: Record<string, unknown>): unknown;
}

export type StripeCheckoutSessionStatus = "open" | "complete" | "expired";

export interface StripeCheckoutSessionLike {
  id: string;
  status: StripeCheckoutSessionStatus | null;
}

export interface StripeCheckoutSessionListParams {
  customer: string;
  status: "open";
  limit: number;
  starting_after?: string;
}

export interface StripeCheckoutSessionListResult {
  data: StripeCheckoutSessionLike[];
  has_more: boolean;
}

export interface StripeCheckoutClientLike {
  checkout: {
    sessions: {
      expire(sessionId: string): PromiseLike<StripeCheckoutSessionLike>;
      retrieve(sessionId: string): PromiseLike<StripeCheckoutSessionLike>;
      list(params: StripeCheckoutSessionListParams): PromiseLike<StripeCheckoutSessionListResult>;
    };
  };
}

export interface StripeCustomerClientLike extends StripeCheckoutClientLike {
  customers: {
    del(customerId: string): PromiseLike<unknown>;
  };
}

export interface RegisteredCheckoutSession {
  id: string;
  url: string;
}

export interface CreateRegisteredCheckoutSessionOptions {
  stripe: StripeCheckoutClientLike;
  userId: string;
  isDeletionFenced(userId: string): Promise<boolean>;
  createSession(): Promise<{ id: unknown; url: unknown }>;
  registerSession(userId: string, sessionId: string): Promise<boolean>;
  markSessionExpired(sessionId: string): Promise<void>;
}

export interface CreateDeleteAccountHandlerOptions {
  admin: AccountAdminClientLike;
  stripe: StripeCustomerClientLike;
  resolveUserId(req: Request): Promise<string>;
}

export interface CreateExportAccountHandlerOptions {
  admin: Pick<AccountAdminClientLike, "from">;
  resolveUserId(req: Request): Promise<string>;
}

interface BillingCustomerRow {
  stripe_customer_id: string | null;
}

interface AccountProfileRow {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountEntitlementRow {
  id: string;
  key: string;
  value: EdgeSharedJson;
  granted_at: string;
  expires_at: string | null;
  source: string;
}

interface AccountCreditLedgerRow {
  id: string;
  amount_cents: number;
  kind: string;
  description: string | null;
  stripe_event_id: string | null;
  stripe_checkout_session_id: string | null;
  metadata: EdgeSharedJson;
  created_at: string;
  idempotency_key: string;
}

interface StripeCustomerMetadataRow {
  metadata: EdgeSharedJson;
}

interface CheckoutLifecycleSessionRow {
  stripe_checkout_session_id: string;
  state: "open" | "expired" | "payment_failed" | "completed" | "refund_pending" | "refunded";
  stripe_customer_id: string | null;
}

interface AccountSyncedSettingRow {
  field_group: string;
  payload: EdgeSharedJson;
  updated_at: string;
}

export interface StoredRouteProposal {
  proposalJson: string;
  usage: ChatCompletionUsage;
}

/**
 * Outcome of durably claiming a router attempt (`router_attempt_claim`)
 * BEFORE any provider invocation happens:
 * - `claimed`: this caller now owns provider invocation for the key.
 * - `in_progress`: another live claim owns it right now; the caller must not
 *   invoke the provider or debit, and should tell the client to retry.
 * - `completed`: the provider already ran for this key (most likely a prior
 *   claim owner whose debit failed); the caller should retry only the debit
 *   step with `result` instead of re-invoking the provider.
 */
export type RouteAttemptClaim =
  | { outcome: "claimed" }
  | { outcome: "in_progress" }
  | { outcome: "completed"; result: StoredRouteProposal };

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
  metadata,
}: DebitCreditsOptions): Promise<DebitCreditsResult> {
  const validUserId = validateNonEmptyString(userId, "userId", "invalid_string");
  const validAmount = validatePositiveInteger(amountCents, "amountCents");
  const validReason = validateNonEmptyString(reason, "reason", "invalid_string");
  const validIdempotencyKey = validateNonEmptyString(
    idempotencyKey,
    "idempotencyKey",
    "invalid_idempotency_key",
  );
  const validMetadata = metadata === undefined ? {} : validateMetadata(metadata);

  const { data, error } = await supabase.rpc<DebitCreditsRpcResult>("debit_credits", {
    target_user: validUserId,
    debit_cents: validAmount,
    reason: validReason,
    idem_key: validIdempotencyKey,
    usage_metadata: validMetadata,
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

/**
 * Reads the confirmed-paid result for a router idempotency key from the
 * credit ledger. A ledger row existing here means the provider ran and the
 * debit committed — this is the money-path source of truth for "has this
 * key already been charged", independent of whether a `router_attempts`
 * claim row still exists (rows written before that table existed only ever
 * have a ledger row, and this keeps honoring them).
 */
export async function findDebitedRouteResult({
  supabase,
  userId,
  idempotencyKey,
}: {
  supabase: Pick<SupabaseClientLike, "from">;
  userId: string;
  idempotencyKey: string;
}): Promise<StoredRouteProposal | null> {
  const validUserId = validateNonEmptyString(userId, "userId", "invalid_string");
  const validIdempotencyKey = validateNonEmptyString(
    idempotencyKey,
    "idempotencyKey",
    "invalid_idempotency_key",
  );
  const { data, error } = await supabase
    .from<{ metadata: unknown }>("credit_ledger")
    .select("metadata")
    .eq("user_id", validUserId)
    .eq("idempotency_key", validIdempotencyKey)
    .maybeSingle();
  if (error !== null) {
    throw databaseError("Failed to read stored router result", error);
  }
  if (data === null) {
    return null;
  }

  return decodeLegacyLedgerRoute(data.metadata);
}

/**
 * Durably claims a router attempt BEFORE any provider invocation, so at most
 * one caller ever owns "go call the provider" for a given (userId,
 * idempotencyKey) at a time. See
 * supabase/migrations/20260722000000_router_attempt_claim.sql for the
 * durable decision this wraps, including in-progress recovery via
 * `leaseSeconds`.
 */
export async function claimRouteAttempt({
  supabase,
  userId,
  idempotencyKey,
  leaseSeconds = 30,
}: {
  supabase: Pick<SupabaseClientLike, "rpc">;
  userId: string;
  idempotencyKey: string;
  leaseSeconds?: number;
}): Promise<RouteAttemptClaim> {
  const validUserId = validateNonEmptyString(userId, "userId", "invalid_string");
  const validIdempotencyKey = validateNonEmptyString(
    idempotencyKey,
    "idempotencyKey",
    "invalid_idempotency_key",
  );
  const validLeaseSeconds = validatePositiveInteger(leaseSeconds, "leaseSeconds");

  const { data, error } = await supabase.rpc<Record<string, unknown>>("router_attempt_claim", {
    target_user: validUserId,
    idem_key: validIdempotencyKey,
    lease_seconds: validLeaseSeconds,
  });
  if (error !== null) {
    throw databaseError("Failed to claim router attempt", error);
  }
  if (!isRecord(data)) {
    throw invalidRpcResult();
  }
  if (data.outcome === "claimed") {
    return { outcome: "claimed" };
  }
  if (data.outcome === "in_progress") {
    return { outcome: "in_progress" };
  }
  if (data.outcome === "completed") {
    return { outcome: "completed", result: decodeRouteAttemptResult(data) };
  }

  throw invalidRpcResult();
}

/**
 * Records a claimed attempt's provider outcome, independent of whether the
 * following debit succeeds — so a retry that lost the debit can skip
 * straight to a debit retry with the same result instead of re-invoking the
 * provider. Idempotent: completing an already-completed attempt returns the
 * stored outcome instead of erroring.
 */
export async function completeRouteAttempt({
  supabase,
  userId,
  idempotencyKey,
  result,
}: {
  supabase: Pick<SupabaseClientLike, "rpc">;
  userId: string;
  idempotencyKey: string;
  result: StoredRouteProposal;
}): Promise<StoredRouteProposal> {
  const validUserId = validateNonEmptyString(userId, "userId", "invalid_string");
  const validIdempotencyKey = validateNonEmptyString(
    idempotencyKey,
    "idempotencyKey",
    "invalid_idempotency_key",
  );
  const validProposalJson = validateNonEmptyString(result.proposalJson, "proposalJson", "invalid_string");

  const { data, error } = await supabase.rpc<Record<string, unknown>>("router_attempt_complete", {
    target_user: validUserId,
    idem_key: validIdempotencyKey,
    new_proposal_json: validProposalJson,
    new_usage_input: result.usage.input,
    new_usage_output: result.usage.output,
  });
  if (error !== null) {
    throw databaseError("Failed to record router attempt outcome", error);
  }
  if (!isRecord(data) || data.outcome !== "completed") {
    throw invalidRpcResult();
  }

  return decodeRouteAttemptResult(data);
}

/**
 * Releases a claim immediately after a definitive provider failure, so a
 * retry does not have to wait out the claim's lease to try again.
 */
export async function failRouteAttempt({
  supabase,
  userId,
  idempotencyKey,
}: {
  supabase: Pick<SupabaseClientLike, "rpc">;
  userId: string;
  idempotencyKey: string;
}): Promise<void> {
  const validUserId = validateNonEmptyString(userId, "userId", "invalid_string");
  const validIdempotencyKey = validateNonEmptyString(
    idempotencyKey,
    "idempotencyKey",
    "invalid_idempotency_key",
  );

  const { error } = await supabase.rpc("router_attempt_fail", {
    target_user: validUserId,
    idem_key: validIdempotencyKey,
  });
  if (error !== null) {
    throw databaseError("Failed to mark router attempt failed", error);
  }
}

export function newIdempotencyKey(scope: string, uniquePart: string): string {
  return `${validateNonEmptyString(scope, "scope", "invalid_idempotency_key")}:${validateNonEmptyString(
    uniquePart,
    "uniquePart",
    "invalid_idempotency_key",
  )}`;
}

export const operatorRouterSystemPrompt = [
  "Return one JSON object for one PickForge developer command.",
  "Use only these v2 action payloads:",
  "- openProject: {\"action\":\"openProject\"}; put the natural project name in projectRef.",
  "- openChat: {\"action\":\"openChat\",\"chat\":string|null}; optional projectRef may disambiguate.",
  "- createChat: {\"action\":\"createChat\",\"provider\":\"claude\"|\"codex\",\"model\":string|null}.",
  "- sendPrompt: {\"action\":\"sendPrompt\",\"prompt\":string,\"chat\":string|null}; never invent project paths.",
  "- startSwarm: {\"action\":\"startSwarm\",\"mode\":\"scout\"|\"review\",\"count\":1-5,\"goal\":string,\"provider\":\"claude\"|\"codex\"|\"mixed\"}.",
  "- swarmStatus: {\"action\":\"swarmStatus\"}.",
  "- interruptRun: {\"action\":\"interruptRun\",\"run\":string|null}.",
  "- steerRun: {\"action\":\"steerRun\",\"run\":string|null,\"instruction\":string}.",
  "- launchEmulator: {\"action\":\"launchEmulator\",\"device\":string|null}.",
  "- launchRun: {\"action\":\"launchRun\",\"target\":string|null}.",
  "- reloadRun: {\"action\":\"reloadRun\"}.",
  "- stopRun: {\"action\":\"stopRun\"}.",
  "- hotRestart: {\"action\":\"hotRestart\"}.",
  "- enterSelectMode: {\"action\":\"enterSelectMode\"}.",
  "- takeScreenshot: {\"action\":\"takeScreenshot\"}.",
  "Semantic widget selection is not available over hosted routing; treat any request to select or click an on-screen element as unclear.",
  "The router only proposes; local code handles ids, provenance, approval, cost, audit, and execution.",
  "Confidence is 0..1 and advisory. Use projectRef only as an opaque natural-language hint.",
  "If the command cannot map safely to one action, return {\"unclear\":true,\"reason\":\"short reason\"}.",
  "Output only JSON, no markdown.",
].join("\n");

export function assertRouteRequest(body: unknown): RouteRequest {
  if (!isRecord(body) || !hasOnlyKeys(body, ["commandText", "context"])) {
    throw boundaryViolation();
  }

  const commandText = readCommandText(body.commandText);
  const context = body.context === undefined ? undefined : readRouteContext(body.context);

  return context === undefined ? { commandText } : { commandText, context };
}

export function createOperatorRouterHandler({
  supabase,
  serviceSupabase,
  getCreditBalance,
  consumeRateLimit,
  chatComplete,
  model,
  apiKey,
  baseUrl,
  creditCostCents,
  systemPrompt = operatorRouterSystemPrompt,
  attemptLeaseSeconds = 30,
}: CreateOperatorRouterHandlerOptions): (req: Request) => Promise<Response> {
  const validModel = validateNonEmptyString(model, "model", "invalid_string");
  const validApiKey = validateNonEmptyString(apiKey, "apiKey", "invalid_string");
  const validBaseUrl = validateNonEmptyString(baseUrl, "baseUrl", "invalid_string");
  const validCreditCostCents = validatePositiveInteger(creditCostCents, "creditCostCents");

  return async (req: Request): Promise<Response> => {
    try {
      const { userId } = await getUserFromRequest({ supabase, req });
      const routeRequest = await readRouteRequest(req);
      const idempotencyKey = validateNonEmptyString(
        req.headers.get("x-idempotency-key"),
        "x-idempotency-key",
        "invalid_idempotency_key",
      );
      const scopedIdempotencyKey = newIdempotencyKey("router", `${userId}:${idempotencyKey}`);

      const debitedRoute = await findDebitedRouteResult({
        supabase: serviceSupabase,
        userId,
        idempotencyKey: scopedIdempotencyKey,
      });
      if (debitedRoute !== null) {
        return routeResponse(debitedRoute, validCreditCostCents);
      }
      if (!(await consumeRateLimit(userId))) {
        return jsonResponse(429, { error: "rate_limited" });
      }
      const balance = await getCreditBalance(userId);
      if (!Number.isSafeInteger(balance)) {
        throw new EdgeSharedError("invalid_rpc_result", "Supabase returned an invalid credit balance");
      }
      if (balance < validCreditCostCents) {
        throw new EdgeSharedError("insufficient_credits", "Not enough credits", { balance });
      }

      // Durably claim BEFORE any provider invocation: at most one caller ever
      // owns "go call the provider" for this key at a time.
      const claim = await claimRouteAttempt({
        supabase: serviceSupabase,
        userId,
        idempotencyKey: scopedIdempotencyKey,
        leaseSeconds: attemptLeaseSeconds,
      });
      if (claim.outcome === "in_progress") {
        return jsonResponse(409, { error: "attempt_in_progress" });
      }

      let route: StoredRouteProposal;
      if (claim.outcome === "completed") {
        // A prior claim owner already ran the provider for this key (most
        // likely this caller's own retry after a debit failure): skip
        // straight to a debit retry with the stored result.
        route = claim.result;
      } else {
        let completion: ChatCompletionResult;
        try {
          completion = await chatComplete({
            model: validModel,
            apiKey: validApiKey,
            baseUrl: validBaseUrl,
            systemPrompt,
            userPrompt: JSON.stringify(routeRequest),
          });
        } catch (error) {
          // A definitive provider failure releases the claim immediately so a
          // retry does not have to wait out the lease.
          await failRouteAttempt({
            supabase: serviceSupabase,
            userId,
            idempotencyKey: scopedIdempotencyKey,
          }).catch(() => {
            // The original provider error remains the actionable failure; the
            // lease will still make the claim recoverable if this also fails.
          });
          throw error;
        }

        route = await completeRouteAttempt({
          supabase: serviceSupabase,
          userId,
          idempotencyKey: scopedIdempotencyKey,
          result: {
            proposalJson: completion.text,
            usage: { input: completion.usage.input, output: completion.usage.output },
          },
        });
      }

      let debitResult: DebitCreditsResult;
      try {
        debitResult = await debitCredits({
          supabase: serviceSupabase,
          userId,
          amountCents: validCreditCostCents,
          reason: "Operator routing",
          idempotencyKey: scopedIdempotencyKey,
          metadata: { proposalJson: route.proposalJson, usage: { input: route.usage.input, output: route.usage.output } },
        });
      } catch (error) {
        const recovered = await findDebitedRouteResult({
          supabase: serviceSupabase,
          userId,
          idempotencyKey: scopedIdempotencyKey,
        });
        if (recovered !== null) {
          return routeResponse(recovered, validCreditCostCents);
        }

        throw error;
      }
      if (debitResult.duplicate) {
        const storedRoute = await findDebitedRouteResult({
          supabase: serviceSupabase,
          userId,
          idempotencyKey: scopedIdempotencyKey,
        });
        if (storedRoute === null) {
          throw new EdgeSharedError("invalid_rpc_result", "Stored router result is missing");
        }

        return routeResponse(storedRoute, validCreditCostCents);
      }

      return routeResponse(route, validCreditCostCents);
    } catch (error) {
      if (error instanceof EdgeSharedError) {
        return jsonResponse(routerErrorStatus(error.code), {
          error: error.code,
          ...(error.balance === undefined ? {} : { balance: error.balance }),
        });
      }

      return jsonResponse(500, { error: "internal_error" });
    }
  };
}

export async function createRegisteredCheckoutSession({
  stripe,
  userId,
  isDeletionFenced,
  createSession,
  registerSession,
  markSessionExpired,
}: CreateRegisteredCheckoutSessionOptions): Promise<RegisteredCheckoutSession> {
  if (await isDeletionFenced(userId)) {
    throw new EdgeSharedError("deletion_in_progress", "Account deletion is in progress");
  }

  const session = await createSession();
  const sessionId = validateNonEmptyString(session.id, "checkout session id", "invalid_string");
  let sessionUrl: string;
  let deletionFenced: boolean;
  try {
    sessionUrl = validateNonEmptyString(session.url, "checkout session url", "invalid_string");
    deletionFenced = await registerSession(userId, sessionId);
  } catch (error) {
    try {
      const disposition = await expireCheckoutSession(stripe, sessionId);
      if (disposition === "expired" || disposition === "missing") {
        await markSessionExpired(sessionId);
      }
    } catch {
      // The original registration error remains the actionable failure; the Checkout URL is never returned.
    }
    throw error;
  }

  if (deletionFenced) {
    const disposition = await expireCheckoutSession(stripe, sessionId);
    if (disposition === "expired" || disposition === "missing") {
      await markSessionExpired(sessionId);
    }
    throw new EdgeSharedError("deletion_in_progress", "Account deletion started during checkout");
  }

  return { id: sessionId, url: sessionUrl };
}

export async function expireCheckoutSession(
  stripe: StripeCheckoutClientLike,
  sessionId: string,
): Promise<Exclude<StripeCheckoutSessionStatus, "open"> | "missing"> {
  let session: StripeCheckoutSessionLike;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (retrieveError) {
    if (isStripeResourceMissingError(retrieveError)) {
      return "missing";
    }
    throw retrieveError;
  }
  if (session.status === "expired" || session.status === "complete") {
    return session.status;
  }

  try {
    await stripe.checkout.sessions.expire(sessionId);
    return "expired";
  } catch (expireError) {
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.status === "expired" || session.status === "complete") {
        return session.status;
      }
    } catch (retrieveError) {
      if (isStripeResourceMissingError(retrieveError)) {
        return "missing";
      }
      throw retrieveError;
    }
    throw expireError;
  }
}

export function createDeleteAccountHandler({
  admin,
  stripe,
  resolveUserId,
}: CreateDeleteAccountHandlerOptions): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      const userId = await resolveUserId(req);
      await fenceAccountDeletion(admin, userId);

      const [
        { data: billingCustomer, error: billingCustomerError },
        ledgerRows,
        registeredSessions,
      ] = await Promise.all([
        accountTable<BillingCustomerRow>(admin, "billing_customers")
          .select("stripe_customer_id")
          .eq("user_id", userId)
          .maybeSingle(),
        readCreditLedgerPages<StripeCustomerMetadataRow>(admin, userId, "metadata"),
        readCheckoutLifecycleSessions(admin, userId),
      ]);
      if (billingCustomerError !== null) {
        throw databaseError("Failed to read billing customer", billingCustomerError);
      }

      const customerIds = new Set<string>();
      const deletedCustomerIds = new Set<string>();
      addStripeCustomerId(customerIds, billingCustomer?.stripe_customer_id);
      for (const row of ledgerRows) {
        addStripeCustomerId(customerIds, isRecord(row.metadata) ? row.metadata.stripe_customer_id : undefined);
      }

      const sessionStates = new Map<string, CheckoutLifecycleSessionRow["state"]>();
      const sessionIds = new Set<string>();
      for (const session of registeredSessions) {
        sessionStates.set(session.stripe_checkout_session_id, session.state);
        addStripeCustomerId(customerIds, session.stripe_customer_id);
        sessionIds.add(session.stripe_checkout_session_id);
      }

      // Stripe list pagination is mutable: collect every page before expiring any Session.
      for (const customerId of customerIds) {
        for (const sessionId of await collectOpenCheckoutSessionIds(stripe, customerId)) {
          sessionIds.add(sessionId);
        }
      }

      for (const sessionId of sessionIds) {
        let disposition: Exclude<StripeCheckoutSessionStatus, "open"> | "missing";
        try {
          disposition = await expireCheckoutSession(stripe, sessionId);
        } catch (error) {
          throw new EdgeSharedError("deletion_incomplete", "Failed to expire Checkout Session", {
            cause: error,
          });
        }

        const registeredState = sessionStates.get(sessionId);
        if (
          disposition === "complete" &&
          registeredState !== "completed" &&
          registeredState !== "refunded" &&
          registeredState !== "payment_failed"
        ) {
          throw new EdgeSharedError(
            "deletion_incomplete",
            "Completed Checkout Session is awaiting credit or refund reconciliation",
          );
        }

        if (
          registeredState === "open" &&
          (disposition === "expired" || disposition === "missing")
        ) {
          await markCheckoutSessionExpired(admin, sessionId);
          sessionStates.set(sessionId, "expired");
        }
      }

      // Two settle→finalize→delete passes: deleting a customer can terminalize a
      // late refund/session (see the "rechecks and deletes a customer terminalized
      // after the first frozen snapshot" contract test), so a second pass re-reads
      // the lifecycle and cleans up anything the first pass's deletions revealed.
      await runDeletionSettlementPass(admin, stripe, userId, sessionIds, customerIds, deletedCustomerIds);
      await runDeletionSettlementPass(admin, stripe, userId, sessionIds, customerIds, deletedCustomerIds);

      await deleteAuthUserAtomically(admin, userId);

      return jsonResponse(200, { deleted: true });
    } catch (error) {
      return accountErrorResponse(error);
    }
  };
}

export function createExportAccountHandler({
  admin,
  resolveUserId,
}: CreateExportAccountHandlerOptions): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      const userId = await resolveUserId(req);
      const [profileResult, entitlementsResult, creditLedger, syncedSettingsResult, billingResult] = await Promise.all([
        accountTable<AccountProfileRow>(admin, "profiles")
          .select("id,email,display_name,avatar_url,created_at,updated_at")
          .eq("id", userId)
          .maybeSingle(),
        accountTable<AccountEntitlementRow>(admin, "entitlements")
          .select("id,key,value,granted_at,expires_at,source")
          .eq("user_id", userId),
        readCreditLedgerExport(admin, userId),
        accountTable<AccountSyncedSettingRow>(admin, "settings_sync")
          .select("field_group,payload,updated_at")
          .eq("user_id", userId)
          .is("deleted_at", null),
        accountTable<BillingCustomerRow>(admin, "billing_customers")
          .select("stripe_customer_id")
          .eq("user_id", userId)
          .maybeSingle(),
      ]);

      for (const result of [profileResult, entitlementsResult, syncedSettingsResult, billingResult]) {
        if (result.error !== null) {
          throw databaseError("Failed to export account data", result.error);
        }
      }

      const stripeCustomerId = billingResult.data?.stripe_customer_id ?? null;
      return jsonResponse(200, {
        version: 1,
        exportedAt: new Date().toISOString(),
        profile: profileResult.data,
        entitlements: entitlementsResult.data ?? [],
        creditLedger,
        syncedSettings: syncedSettingsResult.data ?? [],
        billing: {
          hasStripeCustomer: stripeCustomerId !== null,
          stripeCustomerId,
        },
      });
    } catch (error) {
      return accountErrorResponse(error);
    }
  };
}

export function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

export function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "apikey, x-client-info, authorization, content-type, x-idempotency-key",
  };
}

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// --- Deno Edge Function adapter helpers -------------------------------------
// Hoisted from the individual supabase/functions to remove duplicated boilerplate.
// Kept runtime-agnostic (no Deno globals, no @supabase/supabase-js import) via
// dependency injection so the package stays UI-free and Node/Bun-testable.

export interface CallerSupabaseClientOptions {
  auth: { autoRefreshToken: false; persistSession: false };
  global: { headers: { Authorization: string } };
}

export interface CreateCallerSupabaseFactoryOptions<TClient> {
  createClient: (
    supabaseUrl: string,
    supabaseKey: string,
    options: CallerSupabaseClientOptions,
  ) => TClient;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

/**
 * Builds a required-env reader over an injected env source (e.g. `Deno.env`),
 * throwing when a variable is unset or empty.
 */
export function createRequiredEnv(
  env: { get(name: string): string | undefined },
): (name: string) => string {
  return (name: string): string => {
    const value = env.get(name);
    if (value === undefined || value.length === 0) {
      throw new Error(`${name} is required`);
    }

    return value;
  };
}

/**
 * Builds a per-request caller-scoped Supabase client factory that forwards the
 * inbound Authorization header, without persisting sessions.
 */
export function createCallerSupabaseFactory<TClient>({
  createClient,
  supabaseUrl,
  supabaseAnonKey,
}: CreateCallerSupabaseFactoryOptions<TClient>): (req: Request) => TClient {
  return (req: Request): TClient =>
    createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: req.headers.get("authorization") ?? "" } },
    });
}

/** Merges CORS headers onto a handler response without mutating its body. */
export async function withCors(response: Response | Promise<Response>): Promise<Response> {
  const resolved = await response;
  const headers = new Headers(resolved.headers);
  for (const [name, value] of Object.entries(corsHeaders())) {
    headers.set(name, value);
  }

  return new Response(resolved.body, { status: resolved.status, headers });
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
      return jsonResponse(200, await processStripeEvent({ stripe, supabase, event }));
    } catch (error) {
      // A refund_terminal_failure (money stuck) must never surface as an anonymous
      // 500: emit structured, secret-free diagnostics keyed by the Stripe event.
      logMoneyPathError({
        operation: "stripe_webhook_processing_failed",
        event_id: event.id,
        event_type: event.type,
        error_code: errorCode(error),
      });
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

function readRouteContext(value: unknown): RouteRequestContext {
  if (!isRecord(value) || !hasOnlyKeys(value, ["projectName", "chatNames", "widgetLabels"])) {
    throw boundaryViolation();
  }

  const projectName = value.projectName === undefined ? undefined : readRouteString(value.projectName, 200);
  const chatNames = value.chatNames === undefined ? undefined : readRouteStringList(value.chatNames);
  const widgetLabels = value.widgetLabels === undefined ? undefined : readRouteStringList(value.widgetLabels);

  return {
    ...(projectName === undefined ? {} : { projectName }),
    ...(chatNames === undefined ? {} : { chatNames }),
    ...(widgetLabels === undefined ? {} : { widgetLabels }),
  };
}

function readRouteStringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw boundaryViolation();
  }

  return value.map((item) => readRouteString(item, 200));
}

function readRouteString(value: unknown, maxLength = 4000): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    containsForbiddenIdentifier(value)
  ) {
    throw boundaryViolation();
  }

  return value;
}

function readCommandText(value: unknown): string {
  // operator.md permits user-authored command text; only attached local context is a hard boundary.
  if (typeof value !== "string" || value.length > 4000) {
    throw boundaryViolation();
  }

  return value;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function containsForbiddenIdentifier(value: string): boolean {
  return (
    /\b[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /(?:^|[\s"'])~\//.test(value) ||
    /(?:^|[\s"'])\.\//.test(value) ||
    /(?:^|[^\w/])\/[a-z0-9_.-]+/i.test(value) ||
    /\.\.\//.test(value) ||
    /\b(?:home|etc|usr|var|tmp|opt|root|mnt|workspace|projects)\/[a-z0-9_.-]+/i.test(value) ||
    /\b(?!and\/or\b)[a-z0-9_.-]+\/[a-z0-9_.-]+\b/i.test(value) ||
    /(?:^|\/)\.[^/\s]+/.test(value) ||
    /(?:^|[^a-z0-9_])\.(?:env|git|ssh|aws|npmrc|netrc)\b/i.test(value) ||
    /[a-z]:[\\/]/i.test(value) ||
    /\\\\/.test(value) ||
    /\b[a-z0-9_.-]+\\[a-z0-9_.-]+\\/i.test(value) ||
    /\b[a-z0-9-]+(?::\d{1,5})\b/i.test(value) ||
    /\blocalhost\b/i.test(value) ||
    /\[[0-9a-f:.]+\]/i.test(value) ||
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i.test(value) ||
    /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/.test(value) ||
    /\b[a-z0-9][a-z0-9_-]{31,}\b/i.test(value)
  );
}

function validateMetadata(value: unknown): { [key: string]: EdgeSharedJson } {
  if (!isRecord(value)) {
    throw new EdgeSharedError("invalid_string", "metadata must be an object");
  }

  return value as { [key: string]: EdgeSharedJson };
}

function routeResponse(route: StoredRouteProposal | ChatCompletionResult, costCents: number): Response {
  const proposalJson = "proposalJson" in route ? route.proposalJson : route.text;

  return jsonResponse(200, { proposalJson, usage: route.usage, costCents });
}

function decodeRouteAttemptResult(value: Record<string, unknown>): StoredRouteProposal {
  const proposalJson = value.proposal_json;
  const usageInput = value.usage_input;
  const usageOutput = value.usage_output;
  if (
    typeof proposalJson !== "string" ||
    !Number.isSafeInteger(usageInput) ||
    !Number.isSafeInteger(usageOutput)
  ) {
    throw invalidRpcResult();
  }

  return { proposalJson, usage: { input: usageInput as number, output: usageOutput as number } };
}

function decodeLegacyLedgerRoute(metadata: unknown): StoredRouteProposal | null {
  if (!isRecord(metadata)) {
    return null;
  }

  const proposalJson = metadata.proposalJson;
  const usage = isRecord(metadata.usage) ? metadata.usage : undefined;
  if (
    usage === undefined ||
    typeof proposalJson !== "string" ||
    !Number.isSafeInteger(usage.input) ||
    !Number.isSafeInteger(usage.output)
  ) {
    return null;
  }

  return { proposalJson, usage: { input: usage.input as number, output: usage.output as number } };
}

async function readRouteRequest(req: Request): Promise<RouteRequest> {
  try {
    return assertRouteRequest(await req.json());
  } catch (error) {
    if (error instanceof EdgeSharedError) {
      throw error;
    }

    throw boundaryViolation();
  }
}

function boundaryViolation(): EdgeSharedError {
  return new EdgeSharedError("boundary_violation", "Request contains data outside the routing boundary");
}

function routerErrorStatus(code: EdgeSharedErrorCode): number {
  if (code === "unauthorized") {
    return 401;
  }

  if (code === "insufficient_credits") {
    return 402;
  }

  return code === "database_error" ? 500 : 400;
}

function validatePositiveInteger(
  value: unknown,
  field: string,
  code: EdgeSharedErrorCode = "invalid_debit_amount",
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new EdgeSharedError(code, `${field} must be a positive integer`);
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

function logMoneyPathError(fields: {
  operation: string;
  event_id?: string;
  event_type?: string;
  checkout_session_id?: string;
  error_code?: string | null;
}): void {
  // Structured, secret-free diagnostics: only ids and error codes are emitted —
  // never tokens, Stripe secrets, or request/response bodies.
  console.error(JSON.stringify({ scope: "edge-shared", ...fields }));
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

function accountErrorResponse(error: unknown): Response {
  if (error instanceof EdgeSharedError) {
    if (error.code === "unauthorized") return jsonResponse(401, { error: error.code });
    if (error.code === "deletion_incomplete") {
      // Deletion blocked on pending refund/cleanup reconciliation — money-adjacent.
      logMoneyPathError({ operation: "account_deletion_incomplete", error_code: error.code });
      return jsonResponse(503, { error: error.code });
    }
    if (error.code === "database_error") {
      logMoneyPathError({ operation: "account_database_error", error_code: error.code });
      return jsonResponse(500, { error: "internal_error" });
    }
    return jsonResponse(400, { error: error.code });
  }

  logMoneyPathError({ operation: "account_internal_error", error_code: errorCode(error) });
  return jsonResponse(500, { error: "internal_error" });
}


function isStripeResourceMissingError(error: unknown): boolean {
  return isRecord(error) && error.code === "resource_missing";
}

function accountTable<T>(
  admin: Pick<AccountAdminClientLike, "from">,
  table: string,
): SupabaseQueryBuilderLike<T> {
  return admin.from(table) as SupabaseQueryBuilderLike<T>;
}

function accountRpc<T = unknown>(
  admin: Pick<AccountAdminClientLike, "rpc">,
  fn: string,
  args?: Record<string, unknown>,
): PromiseLike<SupabaseQueryResult<T>> {
  return admin.rpc(fn, args) as PromiseLike<SupabaseQueryResult<T>>;
}

async function fenceAccountDeletion(admin: AccountAdminClientLike, userId: string): Promise<void> {
  const { error } = await accountRpc(admin, "checkout_lifecycle_fence_deletion", {
    target_user: userId,
  });
  if (error !== null) {
    throw databaseError("Failed to fence account deletion", error);
  }
}

/**
 * Reads whether an account deletion fence is already in effect for a user.
 * The sole production caller registers a new Checkout Session (see
 * `createRegisteredCheckoutSession`'s `isDeletionFenced` callback); colocated
 * here so the RPC name and its result contract have one owner.
 */
export async function isCheckoutDeletionFenced(
  admin: Pick<AccountAdminClientLike, "rpc">,
  userId: string,
): Promise<boolean> {
  const { data, error } = await accountRpc<boolean>(admin, "checkout_lifecycle_is_deletion_fenced", {
    target_user: userId,
  });
  if (error !== null || typeof data !== "boolean") {
    throw databaseError("Failed to read account deletion fence", error ?? invalidRpcResultCause());
  }
  return data;
}

/**
 * Registers a newly created Checkout Session against the durable lifecycle,
 * returning whether an account-deletion fence raced the registration. See
 * `isCheckoutDeletionFenced` for why this lives next to that check.
 */
export async function registerCheckoutSession(
  admin: Pick<AccountAdminClientLike, "rpc">,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const { data, error } = await accountRpc<boolean>(admin, "checkout_lifecycle_register_session", {
    target_user: userId,
    checkout_session_id: sessionId,
  });
  if (error !== null || typeof data !== "boolean") {
    throw databaseError("Failed to register Checkout Session", error ?? invalidRpcResultCause());
  }
  return data;
}

export async function markCheckoutSessionExpired(
  admin: Pick<AccountAdminClientLike, "rpc">,
  sessionId: string,
): Promise<void> {
  const { error } = await accountRpc(admin, "checkout_lifecycle_mark_expired", {
    checkout_session_id: sessionId,
  });
  if (error !== null) {
    throw databaseError("Failed to mark Checkout Session expired", error);
  }
}

function invalidRpcResultCause(): SupabaseErrorLike {
  return { message: "rpc returned an invalid result" };
}

async function runDeletionSettlementPass(
  admin: AccountAdminClientLike,
  stripe: StripeCustomerClientLike,
  userId: string,
  sessionIds: Set<string>,
  customerIds: Set<string>,
  deletedCustomerIds: Set<string>,
): Promise<void> {
  await settleDeletionFixpoint(admin, userId, sessionIds, customerIds);
  await finalizeAccountDeletion(admin, userId, customerIds);
  await deleteStripeCustomers(stripe, customerIds, deletedCustomerIds);
}

async function settleDeletionFixpoint(
  admin: AccountAdminClientLike,
  userId: string,
  sessionIds: Set<string>,
  customerIds: Set<string>,
): Promise<void> {
  const maxRefreshes = 8;

  for (let refresh = 0; refresh < maxRefreshes; refresh += 1) {
    const previousSessionCount = sessionIds.size;
    const previousCustomerCount = customerIds.size;
    await refreshSettledLifecycle(admin, userId, sessionIds, customerIds);

    if (
      sessionIds.size === previousSessionCount &&
      customerIds.size === previousCustomerCount
    ) {
      return;
    }
  }

  throw new EdgeSharedError(
    "deletion_incomplete",
    "Checkout Session cleanup did not reach a stable lifecycle snapshot",
  );
}

async function refreshSettledLifecycle(
  admin: AccountAdminClientLike,
  userId: string,
  sessionIds: Set<string>,
  customerIds: Set<string>,
): Promise<void> {
  const sessions = await readCheckoutLifecycleSessions(admin, userId);
  for (const session of sessions) {
    sessionIds.add(session.stripe_checkout_session_id);
    addStripeCustomerId(customerIds, session.stripe_customer_id);
    if (session.state === "open" || session.state === "refund_pending") {
      throw new EdgeSharedError(
        "deletion_incomplete",
        "Checkout Session cleanup or refund reconciliation is still pending",
      );
    }
  }
}

async function finalizeAccountDeletion(
  admin: Pick<AccountAdminClientLike, "rpc">,
  userId: string,
  customerIds: Set<string>,
): Promise<void> {
  const { data, error } = await accountRpc<unknown>(
    admin,
    "checkout_lifecycle_finalize_deletion",
    { target_user: userId },
  );
  if (error !== null) {
    throw databaseError("Failed to finalize account deletion", error);
  }
  if (
    !isRecord(data) ||
    data.status !== "finalized" ||
    !Array.isArray(data.customer_ids)
  ) {
    throw new EdgeSharedError(
      "deletion_incomplete",
      "Checkout Session lifecycle changed before deletion finalization",
    );
  }
  for (const customerId of data.customer_ids) {
    addStripeCustomerId(customerIds, customerId);
  }
}

async function deleteAuthUserAtomically(
  admin: Pick<AccountAdminClientLike, "rpc">,
  userId: string,
): Promise<void> {
  const { data, error } = await accountRpc<string>(
    admin,
    "checkout_lifecycle_delete_auth_user",
    { target_user: userId },
  );
  if (error !== null) {
    throw databaseError("Failed to atomically delete auth user", error);
  }
  if (data !== "deleted") {
    throw new EdgeSharedError(
      "deletion_incomplete",
      "Checkout Session lifecycle changed before atomic auth deletion",
    );
  }
}

async function deleteStripeCustomers(
  stripe: StripeCustomerClientLike,
  customerIds: Set<string>,
  deletedCustomerIds: Set<string>,
): Promise<void> {
  for (const customerId of customerIds) {
    if (deletedCustomerIds.has(customerId)) {
      continue;
    }
    try {
      await stripe.customers.del(customerId);
      deletedCustomerIds.add(customerId);
    } catch (error) {
      if (isStripeResourceMissingError(error)) {
        deletedCustomerIds.add(customerId);
        continue;
      }
      throw new EdgeSharedError("deletion_incomplete", "Failed to delete Stripe customer", {
        cause: error,
      });
    }
  }
}

async function readCheckoutLifecycleSessions(
  admin: AccountAdminClientLike,
  userId: string,
): Promise<CheckoutLifecycleSessionRow[]> {
  const sessions: CheckoutLifecycleSessionRow[] = [];
  const pageSize = 1000;

  for (let pageStart = 0; ; pageStart += pageSize) {
    const { data, error } = await accountRpc<CheckoutLifecycleSessionRow[]>(
      admin,
      "checkout_lifecycle_list_sessions",
      {
        target_user: userId,
        page_start: pageStart,
        page_size: pageSize,
      },
    );
    if (error !== null) {
      throw databaseError("Failed to read registered Checkout Sessions", error);
    }

    const page = data ?? [];
    sessions.push(...page);
    if (page.length < pageSize) {
      return sessions;
    }
  }
}

async function collectOpenCheckoutSessionIds(
  stripe: StripeCheckoutClientLike,
  customerId: string,
): Promise<string[]> {
  const sessionIds: string[] = [];
  const pageSize = 100;
  let startingAfter: string | undefined;

  for (;;) {
    let page: StripeCheckoutSessionListResult;
    try {
      page = await stripe.checkout.sessions.list({
        customer: customerId,
        status: "open",
        limit: pageSize,
        ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
      });
    } catch (error) {
      if (isStripeResourceMissingError(error)) {
        return sessionIds;
      }
      throw new EdgeSharedError("deletion_incomplete", "Failed to list open Checkout Sessions", {
        cause: error,
      });
    }

    for (const session of page.data) {
      sessionIds.push(session.id);
    }
    if (!page.has_more) {
      return sessionIds;
    }

    const lastSession = page.data.at(-1);
    if (lastSession === undefined) {
      throw new EdgeSharedError(
        "deletion_incomplete",
        "Stripe Checkout Session pagination did not advance",
      );
    }
    startingAfter = lastSession.id;
  }
}

async function readCreditLedgerExport(
  admin: Pick<AccountAdminClientLike, "from">,
  userId: string,
): Promise<AccountCreditLedgerRow[]> {
  return readCreditLedgerPages<AccountCreditLedgerRow>(
    admin,
    userId,
    "id,amount_cents,kind,description,stripe_event_id,stripe_checkout_session_id,metadata,created_at,idempotency_key",
  );
}

async function readCreditLedgerPages<T>(
  admin: Pick<AccountAdminClientLike, "from">,
  userId: string,
  columns: string,
): Promise<T[]> {
  const entries: T[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await accountTable<T[]>(admin, "credit_ledger")
      .select(columns)
      .eq("user_id", userId)
      .order("id")
      .range(from, from + pageSize - 1);
    if (error !== null) {
      throw databaseError("Failed to export credit ledger", error);
    }

    const page = data ?? [];
    entries.push(...page);
    if (page.length < pageSize) {
      return entries;
    }
  }
}

function addStripeCustomerId(customerIds: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    customerIds.add(value.trim());
  }
}
