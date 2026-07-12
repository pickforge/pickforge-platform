import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    import.meta.dirname,
    "../../../supabase/migrations/20260712012242_welcome_credits_first_50.sql",
  ),
  "utf8",
);

describe("first-50 welcome credits migration", () => {
  it("keeps campaign state private with a fixed lifetime cap", () => {
    expect(migration).toContain(
      "create schema if not exists welcome_credits_private",
    );
    expect(migration).toContain(
      "create table welcome_credits_private.campaigns",
    );
    expect(migration).toContain("enabled boolean not null default true");
    expect(migration).toContain("issued_count integer not null default 0");
    expect(migration).toContain("check (issued_count between 0 and 50)");
    expect(migration).toContain(
      "alter table welcome_credits_private.campaigns enable row level security",
    );
    expect(migration).toContain(
      "revoke all on schema welcome_credits_private from public, anon, authenticated, service_role",
    );
  });

  it("serializes a fixed grant and only counts successful inserts", () => {
    expect(migration).toContain(
      "create function welcome_credits_private.grant_launch_welcome_credit()",
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain("for update");
    expect(migration).toContain("100,");
    expect(migration).toContain("'grant'");
    expect(migration).toContain("'welcome:first-50:v1'");
    expect(migration).toContain("on conflict (user_id, idempotency_key) do nothing");
    expect(migration).toContain("if granted_id is not null then");
    expect(migration).toContain("issued_count = issued_count + 1");
  });

  it("runs only for new non-anonymous auth users and exposes no grant rpc", () => {
    expect(migration).toContain("after insert on auth.users");
    expect(migration).toContain("when (coalesce(new.is_anonymous, false) = false)");
    expect(migration).toContain(
      "revoke execute on function welcome_credits_private.grant_launch_welcome_credit() from public, anon, authenticated, service_role",
    );
    expect(migration).not.toContain(
      "grant execute on function welcome_credits_private.grant_launch_welcome_credit",
    );
  });
});
