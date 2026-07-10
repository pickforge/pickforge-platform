import { createClient } from "@supabase/supabase-js";
import {
  corsHeaders,
  corsPreflightResponse,
  createExportAccountHandler,
  getUserFromRequest,
} from "@pickforge/edge-shared";

const supabaseUrl = requiredEnv("SUPABASE_URL");
const supabaseAnonKey = requiredEnv("SUPABASE_ANON_KEY");
const serviceSupabase = createClient(supabaseUrl, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse();
  }

  const handler = createExportAccountHandler({
    admin: serviceSupabase,
    resolveUserId: async (request) => {
      const { userId } = await getUserFromRequest({ supabase: createCallerSupabase(request), req: request });
      return userId;
    },
  });
  return withCors(handler(req));
});

function createCallerSupabase(req: Request) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: req.headers.get("authorization") ?? "" } },
  });
}

async function withCors(response: Promise<Response>): Promise<Response> {
  const resolved = await response;
  const headers = new Headers(resolved.headers);
  for (const [name, value] of Object.entries(corsHeaders())) {
    headers.set(name, value);
  }
  return new Response(resolved.body, { status: resolved.status, headers });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}
