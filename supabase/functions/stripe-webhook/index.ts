import Stripe from "npm:stripe@19.1.0";
import { createClient } from "npm:@supabase/supabase-js@2.110.0";
import { processStripeEvent, verifyStripeEvent } from "npm:@pickforge/billing@0.5.0";
import { createStripeWebhookHandler } from "npm:@pickforge/edge-shared@0.5.0";

const stripe = new Stripe(requiredEnv("STRIPE_SECRET_KEY"));
const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
const handleWebhookRequest = createStripeWebhookHandler({
  stripe,
  supabase,
  webhookSecret: requiredEnv("STRIPE_WEBHOOK_SECRET"),
  verifyStripeEvent,
  processStripeEvent,
});

Deno.serve(handleWebhookRequest);

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}
