import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(import.meta.dirname, "../../../supabase/migrations/20260709030000_debit_credits.sql"),
  "utf8",
);

const supabaseConfig = readFileSync(join(import.meta.dirname, "../../../supabase/config.toml"), "utf8");
const metadataMigration = readFileSync(
  join(import.meta.dirname, "../../../supabase/migrations/20260709050000_debit_credits_metadata.sql"),
  "utf8",
);
const routerRateMigration = readFileSync(
  join(import.meta.dirname, "../../../supabase/migrations/20260709060000_router_rate_limit.sql"),
  "utf8",
);

describe("debit credits migration", () => {
  it("adds a user-scoped ledger idempotency key", () => {
    expect(migration).toContain("add column if not exists idempotency_key text");
    expect(migration).toContain("drop constraint if exists credit_ledger_idempotency_key_key");
    expect(migration).toContain(
      "create unique index if not exists credit_ledger_user_id_idempotency_key_idx",
    );
    expect(migration).toContain("on public.credit_ledger(user_id, idempotency_key)");
    expect(migration).not.toContain("idempotency_key text unique");
  });

  it("defines debit_credits as a security invoker function", () => {
    expect(migration).toContain("create or replace function public.debit_credits(");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("set search_path = public");
  });

  it("serializes debit decisions per user", () => {
    expect(migration).toContain("pg_advisory_xact_lock(hashtext(target_user::text))");
  });

  it("returns duplicate, insufficient, and ok statuses", () => {
    expect(migration).toMatch(/where user_id = target_user\s+and idempotency_key = idem_key/);
    expect(migration).toContain("jsonb_build_object('status', 'duplicate')");
    expect(migration).toContain("jsonb_build_object('status', 'insufficient', 'balance', current_balance)");
    expect(migration).toContain("jsonb_build_object('status', 'ok', 'balance', next_balance)");
  });

  it("keeps the rpc off public client roles", () => {
    expect(migration).toContain(
      "revoke execute on function public.debit_credits(uuid, integer, text, text) from public, anon, authenticated",
    );
  });
});

describe("debit credits metadata migration", () => {
  it("stores usage metadata and restricts the new RPC signature", () => {
    expect(metadataMigration).toContain("usage_metadata jsonb default '{}'::jsonb");
    expect(metadataMigration).toContain("metadata");
    expect(metadataMigration).toContain("usage_metadata");
    expect(metadataMigration).toContain(
      "revoke execute on function public.debit_credits(uuid, integer, text, text, jsonb)",
    );
  });
});

describe("router rate limit migration", () => {
  it("limits each user to ten requests per ten seconds", () => {
    expect(routerRateMigration).toContain("create table if not exists public.router_rate_limits");
    expect(routerRateMigration).toContain("create function public.consume_router_rate_limit(target_user uuid)");
    expect(routerRateMigration).toContain("current_count >= 10");
    expect(routerRateMigration).toContain("interval '10 seconds'");
  });
});

describe("stripe webhook function config", () => {
  it("disables Supabase JWT verification for Stripe calls", () => {
    expect(supabaseConfig).toContain("[functions.stripe-webhook]");
    expect(supabaseConfig).toContain("verify_jwt = false");
  });
});
