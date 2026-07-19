import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(import.meta.dirname, "../../../supabase/migrations/20260709010000_billing_customers_credit_ledger.sql"),
  "utf8",
);

const balanceIndexMigration = readFileSync(
  join(import.meta.dirname, "../../../supabase/migrations/20260719000000_credit_ledger_balance_covering_index.sql"),
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

describe("credit ledger balance covering index migration", () => {
  it("adds a covering index that carries amount_cents for balance sums", () => {
    expect(balanceIndexMigration).toContain(
      "create index if not exists credit_ledger_user_id_amount_cents_idx",
    );
    expect(balanceIndexMigration).toContain("on public.credit_ledger (user_id) include (amount_cents)");
  });

  it("stays additive: no drop/renumber of the existing balance path", () => {
    expect(balanceIndexMigration).not.toMatch(/drop\s+index/i);
    expect(balanceIndexMigration).not.toMatch(/drop\s+table/i);
    expect(balanceIndexMigration).not.toMatch(/alter\s+table[\s\S]*drop/i);
  });
});
