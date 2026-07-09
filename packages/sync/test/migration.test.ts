import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UNAMBIGUOUS_SYNC_TOKEN_PATTERN_SOURCE } from "../src/index.js";

const migration = readFileSync(
  join(import.meta.dirname, "../../../supabase/migrations/20260709040000_settings_sync.sql"),
  "utf8",
);

describe("settings sync migration", () => {
  it("creates the settings_sync table with a user/group primary key", () => {
    expect(migration).toContain("create table if not exists public.settings_sync");
    expect(migration).toContain("user_id uuid not null references auth.users(id) on delete cascade");
    expect(migration).toContain("deleted_at timestamptz");
    expect(migration).toContain("primary key (user_id, field_group)");
  });

  it("keeps the field group allowlist closed", () => {
    expect(migration).toContain(
      "field_group text not null check (field_group in ('appSettings','operatorConfig','keybindings','remoteBindings'))",
    );
  });

  it("caps payload size and rejects far-future client timestamps", () => {
    expect(migration).toContain("check (pg_column_size(payload) <= 65536)");
    expect(migration).toContain("check (updated_at <= now() + interval '5 minutes')");
  });

  it("rejects unambiguous token prefixes in payload text", () => {
    expect(migration).toContain(
      `check (payload::text !~* '${UNAMBIGUOUS_SYNC_TOKEN_PATTERN_SOURCE}')`,
    );
  });

  it("enables RLS and owns authenticated select, insert, and update operations", () => {
    expect(migration).toContain("alter table public.settings_sync enable row level security");
    expect(migration).toContain('create policy "settings_sync_select_own"');
    expect(migration).toContain('create policy "settings_sync_insert_own"');
    expect(migration).toContain('create policy "settings_sync_update_own"');
    expect(migration).toMatch(/for select\s+to authenticated\s+using \(auth\.uid\(\) = user_id\)/);
    expect(migration).toMatch(/for insert\s+to authenticated\s+with check \(auth\.uid\(\) = user_id\)/);
    expect(migration).toMatch(
      /for update\s+to authenticated\s+using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/,
    );
    expect(migration).not.toMatch(/for delete\s+to authenticated/);
  });

  it("does not add a server timestamp trigger", () => {
    expect(migration).not.toMatch(/trigger/i);
  });
});
