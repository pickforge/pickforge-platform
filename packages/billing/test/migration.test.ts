import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(import.meta.dirname, "../../../supabase/migrations/20260709010000_billing_customers_credit_ledger.sql"),
  "utf8",
);

describe("billing customers and credit ledger migration", () => {
  it("enables RLS on all billing tables", () => {
    expect(migration).toContain("alter table public.billing_customers enable row level security");
    expect(migration).toContain("alter table public.credit_ledger enable row level security");
    expect(migration).toContain("alter table public.stripe_events enable row level security");
  });

  it("allows authenticated users to read only their own customer and ledger rows", () => {
    expect(migration).toContain('create policy "billing_customers_select_own"');
    expect(migration).toContain("using (auth.uid() = user_id)");
    expect(migration).toContain('create policy "credit_ledger_select_own"');
  });

  it("does not grant authenticated or anon write policies", () => {
    expect(migration).not.toMatch(/for\s+(insert|update|delete)[\s\S]*?to\s+(authenticated|anon)/i);
  });

  it("keeps ledger kind and amount constrained", () => {
    expect(migration).toContain(
      "kind text not null check (kind in ('purchase','usage','grant','refund','adjustment'))",
    );
    expect(migration).toContain("amount_cents integer not null check (amount_cents <> 0)");
  });

  it("keeps Stripe event ids unique on the idempotency tables", () => {
    expect(migration).toContain("stripe_event_id text unique");
    expect(migration).toContain("event_id text primary key");
  });

  it("dedupes purchases by checkout session", () => {
    expect(migration).toContain(
      "create unique index if not exists credit_ledger_purchase_session_idx",
    );
    expect(migration).toContain("on public.credit_ledger(stripe_checkout_session_id)");
    expect(migration).toContain("where kind = 'purchase'");
  });

  it("defines the balance function as a stable security invoker rpc", () => {
    expect(migration).toContain("create or replace function public.credit_balance_cents(target_user uuid)");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("stable");
    expect(migration).toContain("coalesce(sum(amount_cents), 0)::integer");
  });
});
