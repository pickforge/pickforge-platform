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
const stripe = new Stripe(requiredEnv("STRIPE_SECRET_KEY"));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse();
  }

  try {
    const { userId } = await getUserFromRequest({ supabase: createCallerSupabase(req), req });
    const { pack } = await readCheckoutRequest(req);
    const session = await createCreditCheckoutSession<{ url: string | null }>({
      stripe,
      userId,
      priceId: priceIdForPack(pack),
      successUrl: requiredEnv("CHECKOUT_SUCCESS_URL"),
      cancelUrl: requiredEnv("CHECKOUT_CANCEL_URL"),
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
