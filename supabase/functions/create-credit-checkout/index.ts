import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { createCreditCheckoutSession } from "@pickforge/billing";
import {
  corsHeaders,
  corsPreflightResponse,
  createCallerSupabaseFactory,
  createRegisteredCheckoutSession,
  createRequiredEnv,
  EdgeSharedError,
  getUserFromRequest,
  isCheckoutDeletionFenced,
  jsonResponse,
  markCheckoutSessionExpired,
  registerCheckoutSession,
} from "@pickforge/edge-shared";

const requiredEnv = createRequiredEnv(Deno.env);
const supabaseUrl = requiredEnv("SUPABASE_URL");
const supabaseAnonKey = requiredEnv("SUPABASE_ANON_KEY");
const serviceSupabase = createClient(supabaseUrl, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(requiredEnv("STRIPE_SECRET_KEY"));
const createCallerSupabase = createCallerSupabaseFactory({ createClient, supabaseUrl, supabaseAnonKey });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse();
  }
  if (req.method !== "POST") {
    return respond(405, { error: "method_not_allowed" });
  }

  try {
    const { userId } = await getUserFromRequest({ supabase: createCallerSupabase(req), req });
    const { pack } = await readCheckoutRequest(req);
    // Optional client-supplied idempotency token: retries of one purchase reuse it
    // (Stripe returns the same Session); a new purchase sends a fresh token, and an
    // absent header lets billing generate a fresh key so distinct purchases never collide.
    const requestId = req.headers.get("x-idempotency-key") ?? undefined;
    const existingCustomerId = await readExistingCustomerId(userId);
    const session = await createRegisteredCheckoutSession({
      stripe,
      userId,
      isDeletionFenced: (id) => isCheckoutDeletionFenced(serviceSupabase, id),
      createSession: async () => {
        const created = await createCreditCheckoutSession({
          stripe,
          userId,
          priceId: priceIdForPack(pack),
          successUrl: requiredEnv("CHECKOUT_SUCCESS_URL"),
          cancelUrl: requiredEnv("CHECKOUT_CANCEL_URL"),
          existingCustomerId,
          requestId,
        });
        if (!isRecord(created)) {
          throw new Error("Stripe returned an invalid Checkout Session");
        }
        return { id: created.id, url: created.url };
      },
      registerSession: (id, sessionId) => registerCheckoutSession(serviceSupabase, id, sessionId),
      markSessionExpired: (sessionId) => markCheckoutSessionExpired(serviceSupabase, sessionId),
    });

    return respond(200, { url: session.url });
  } catch (error) {
    if (error instanceof EdgeSharedError) {
      const status =
        error.code === "unauthorized" ? 401 : error.code === "deletion_in_progress" ? 409 : 400;
      return respond(status, { error: error.code });
    }

    if (error instanceof SyntaxError) {
      return respond(400, { error: "invalid_string" });
    }

    return respond(500, { error: "internal_error" });
  }
});

async function readExistingCustomerId(userId: string): Promise<string | undefined> {
  const { data, error } = await serviceSupabase
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle()
    .overrideTypes<{ stripe_customer_id: string | null }, { merge: false }>();
  if (error !== null) {
    throw new Error("Failed to read billing customer", { cause: error });
  }

  return typeof data?.stripe_customer_id === "string" && data.stripe_customer_id.length > 0
    ? data.stripe_customer_id
    : undefined;
}

function respond(status: number, body: unknown): Response {
  return jsonResponse(status, body, corsHeaders());
}

function priceIdForPack(pack: unknown): string {
  if (pack === "p10") return requiredEnv("STRIPE_PRICE_PACK_10");
  if (pack === "p25") return requiredEnv("STRIPE_PRICE_PACK_25");
  if (pack === "p50") return requiredEnv("STRIPE_PRICE_PACK_50");

  throw new EdgeSharedError("invalid_string", "pack must be p10, p25, or p50");
}

async function readCheckoutRequest(req: Request): Promise<{ pack: unknown }> {
  const body = await req.json();
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "pack")
  ) {
    throw new EdgeSharedError("invalid_string", "Request body must contain only pack");
  }

  return { pack: body.pack };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
