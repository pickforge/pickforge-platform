import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import {
  corsHeaders,
  corsPreflightResponse,
  createCallerSupabaseFactory,
  createDeleteAccountHandler,
  createRequiredEnv,
  getUserFromRequest,
  jsonResponse,
  withCors,
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
    return jsonResponse(405, { error: "method_not_allowed" }, corsHeaders());
  }

  const handler = createDeleteAccountHandler({
    admin: serviceSupabase,
    stripe,
    resolveUserId: async (request: Request) => {
      const { userId } = await getUserFromRequest({ supabase: createCallerSupabase(request), req: request });
      return userId;
    },
  });
  return withCors(handler(req));
});
