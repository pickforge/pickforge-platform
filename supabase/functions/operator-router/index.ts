import { createClient } from "@supabase/supabase-js";
import { getCreditBalanceCents } from "@pickforge/billing";
import {
  createCallerSupabaseFactory,
  createOperatorRouterHandler,
  createRequiredEnv,
  corsHeaders,
  corsPreflightResponse,
  EdgeSharedError,
  jsonResponse,
  withCors,
} from "@pickforge/edge-shared";

const requiredEnv = createRequiredEnv(Deno.env);
const supabaseUrl = requiredEnv("SUPABASE_URL");
const supabaseAnonKey = requiredEnv("SUPABASE_ANON_KEY");
const serviceSupabase = createClient(supabaseUrl, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const createCallerSupabase = createCallerSupabaseFactory({ createClient, supabaseUrl, supabaseAnonKey });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse();
  }

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (apiKey === undefined || apiKey.length === 0) {
    return respond(503, {
      error: "hosted_routing_not_configured",
      message: "Hosted routing is not configured",
    });
  }

  const handler = createOperatorRouterHandler({
    supabase: createCallerSupabase(req),
    serviceSupabase,
    getCreditBalance: (userId) => getCreditBalanceCents({ supabase: serviceSupabase, userId }),
    consumeRateLimit,
    chatComplete,
    model: Deno.env.get("OPENAI_ROUTER_MODEL") ?? "gpt-5.4-mini",
    apiKey,
    baseUrl: Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
    creditCostCents: readPositiveIntegerEnv("ROUTER_CREDIT_COST_CENTS", 2),
    attemptLeaseSeconds: readPositiveIntegerEnv("ROUTER_ATTEMPT_LEASE_SECONDS", 30),
  });

  return withCors(handler(req));
});

async function consumeRateLimit(userId: string): Promise<boolean> {
  const { data, error } = await serviceSupabase.rpc<boolean>("consume_router_rate_limit", {
    target_user: userId,
  });
  if (error !== null) {
    throw new EdgeSharedError("database_error", "Failed to consume router rate limit", { cause: error });
  }
  if (typeof data !== "boolean") {
    throw new EdgeSharedError("invalid_rpc_result", "Router rate limit returned an invalid result");
  }

  return data;
}

function respond(status: number, body: unknown): Response {
  return jsonResponse(status, body, corsHeaders());
}

async function chatComplete({
  model,
  apiKey,
  baseUrl,
  systemPrompt,
  userPrompt,
}: {
  model: string;
  apiKey: string;
  baseUrl: string;
  systemPrompt: string;
  userPrompt: string;
}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI chat completion failed with ${response.status}`);
  }

  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content;
  const input = body?.usage?.prompt_tokens;
  const output = body?.usage?.completion_tokens;
  if (typeof text !== "string" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output)) {
    throw new Error("OpenAI chat completion returned an invalid response");
  }

  return { text, usage: { input, output } };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}
