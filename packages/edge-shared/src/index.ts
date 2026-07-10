export type EdgeSharedErrorCode =
  | "database_error"
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
  findCompletedRoute(userId: string, idempotencyKey: string): Promise<StoredRouteProposal | null>;
  getCreditBalance(userId: string): Promise<number>;
  consumeRateLimit(userId: string): Promise<boolean>;
  debit(options: Omit<DebitCreditsOptions, "supabase">): Promise<DebitCreditsResult>;
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
}

export interface AccountAdminClientLike {
  auth: {
    admin: {
      deleteUser(userId: string): PromiseLike<{ error: SupabaseErrorLike | null }>;
    };
  };
  from<T = unknown>(table: string): SupabaseQueryBuilderLike<T>;
}

export interface StripeCustomerClientLike {
  customers: {
    del(customerId: string): PromiseLike<unknown>;
  };
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

interface AccountSyncedSettingRow {
  field_group: string;
  payload: EdgeSharedJson;
  updated_at: string;
}

export interface StoredRouteProposal {
  proposalJson: string;
  usage: ChatCompletionUsage;
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
  findCompletedRoute,
  getCreditBalance,
  consumeRateLimit,
  debit,
  chatComplete,
  model,
  apiKey,
  baseUrl,
  creditCostCents,
  systemPrompt = operatorRouterSystemPrompt,
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
      const completedRoute = await findCompletedRoute(userId, scopedIdempotencyKey);
      if (completedRoute !== null) {
        return routeResponse(completedRoute, validCreditCostCents);
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

      const completion = await chatComplete({
        model: validModel,
        apiKey: validApiKey,
        baseUrl: validBaseUrl,
        systemPrompt,
        userPrompt: JSON.stringify(routeRequest),
      });
      const route = {
        proposalJson: completion.text,
        usage: { input: completion.usage.input, output: completion.usage.output },
      };
      let debitResult: DebitCreditsResult;
      try {
        debitResult = await debit({
          userId,
          amountCents: validCreditCostCents,
          reason: "Operator routing",
          idempotencyKey: scopedIdempotencyKey,
          metadata: route,
        });
      } catch (error) {
        const storedRoute = await findCompletedRoute(userId, scopedIdempotencyKey);
        if (storedRoute !== null) {
          return routeResponse(storedRoute, validCreditCostCents);
        }

        throw error;
      }
      if (debitResult.duplicate) {
        const storedRoute = await findCompletedRoute(userId, scopedIdempotencyKey);
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

export function createDeleteAccountHandler({
  admin,
  stripe,
  resolveUserId,
}: CreateDeleteAccountHandlerOptions): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      const userId = await resolveUserId(req);
      const { data: billingCustomer, error: billingCustomerError } = await admin
        .from<BillingCustomerRow>("billing_customers")
        .select("stripe_customer_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (billingCustomerError !== null) {
        throw databaseError("Failed to read billing customer", billingCustomerError);
      }

      if (typeof billingCustomer?.stripe_customer_id === "string" && billingCustomer.stripe_customer_id.length > 0) {
        try {
          // Stripe deletion is best-effort because it retains transaction records for legal and fiscal obligations.
          await stripe.customers.del(billingCustomer.stripe_customer_id);
        } catch {}
      }

      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error !== null && !isUserNotFoundError(error)) {
        throw new Error("Failed to delete user", { cause: error });
      }

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
      const [profileResult, entitlementsResult, creditLedgerResult, syncedSettingsResult, billingResult] = await Promise.all([
        admin
          .from<AccountProfileRow>("profiles")
          .select("id,email,display_name,avatar_url,created_at,updated_at")
          .eq("id", userId)
          .maybeSingle(),
        admin
          .from<AccountEntitlementRow>("entitlements")
          .select("id,key,value,granted_at,expires_at,source")
          .eq("user_id", userId),
        admin
          .from<AccountCreditLedgerRow>("credit_ledger")
          .select("id,amount_cents,kind,description,stripe_event_id,stripe_checkout_session_id,metadata,created_at,idempotency_key")
          .eq("user_id", userId),
        admin
          .from<AccountSyncedSettingRow>("settings_sync")
          .select("field_group,payload,updated_at")
          .eq("user_id", userId)
          .is("deleted_at", null),
        admin
          .from<BillingCustomerRow>("billing_customers")
          .select("stripe_customer_id")
          .eq("user_id", userId)
          .maybeSingle(),
      ]);

      for (const result of [profileResult, entitlementsResult, creditLedgerResult, syncedSettingsResult, billingResult]) {
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
        creditLedger: creditLedgerResult.data ?? [],
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

function accountErrorResponse(error: unknown): Response {
  if (error instanceof EdgeSharedError) {
    return jsonResponse(error.code === "unauthorized" ? 401 : 400, { error: error.code });
  }

  return jsonResponse(500, { error: "internal_error" });
}

function isUserNotFoundError(error: SupabaseErrorLike): boolean {
  return error.code === "user_not_found" || /user not found/i.test(error.message);
}
