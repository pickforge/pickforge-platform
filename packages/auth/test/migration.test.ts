import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(import.meta.dirname, "../../../supabase/migrations/20260705000000_profiles_entitlements.sql"),
  "utf8",
);

describe("profiles and entitlements migration", () => {
  it("enables RLS on both tables", () => {
    expect(migration).toContain("alter table public.profiles enable row level security");
    expect(migration).toContain("alter table public.entitlements enable row level security");
  });

  it("limits profile and entitlement reads to the authenticated owner", () => {
    expect(migration).toContain("auth.uid() = id");
    expect(migration).toContain("auth.uid() = user_id");
  });
});
