import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { createCreditCheckoutSession } from "@pickforge/billing";
import {
  corsHeaders,
  corsPreflightResponse,
  EdgeSharedError,
  getUserFromRequest,
  jsonResponse,
} from "@pickforge/edge-shared";

const supabaseUrl = requiredEnv("SUPABASE_URL");
const supabaseAnonKey = requiredEnv("SUPABASE_ANON_KEY");
const serviceSupabase = createClient(supabaseUrl, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(requiredEnv("STRIPE_SECRET_KEY"));

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
    const existingCustomerId = await readExistingCustomerId(userId);
    const session = await createCreditCheckoutSession<{ url: string | null }>({
      stripe,
      userId,
      priceId: priceIdForPack(pack),
      successUrl: requiredEnv("CHECKOUT_SUCCESS_URL"),
      cancelUrl: requiredEnv("CHECKOUT_CANCEL_URL"),
      existingCustomerId,
    });
    if (typeof session.url !== "string" || session.url.length === 0) {
      throw new Error("Stripe checkout session did not include a URL");
    }

    return respond(200, { url: session.url });
  } catch (error) {
    if (error instanceof EdgeSharedError) {
      return respond(error.code === "unauthorized" ? 401 : 400, { error: error.code });
    }

    if (error instanceof SyntaxError) {
      return respond(400, { error: "invalid_string" });
    }

    return respond(500, { error: "internal_error" });
  }
});

function createCallerSupabase(req: Request) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: req.headers.get("authorization") ?? "" } },
  });
}

async function readExistingCustomerId(userId: string): Promise<string | undefined> {
  const { data, error } = await serviceSupabase
    .from<{ stripe_customer_id: string | null }>("billing_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();
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

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}
