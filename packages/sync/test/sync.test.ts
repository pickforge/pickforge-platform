import { describe, expect, it } from "vitest";
import {
  deleteGroup,
  pullAll,
  pullGroup,
  pushGroup,
  type Json,
  type SupabaseClientLike,
  type SupabaseQueryBuilderLike,
  type SupabaseQueryResult,
} from "../src/index.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OLDER = "2026-07-09T04:00:00.000000Z";
const NEWER = "2026-07-09T04:05:00.000000Z";
const DELETED = "2026-07-09T04:10:00.000000Z";
const RESTORED = "2026-07-09T04:15:00.000000Z";
const MICRO_OLDER = "2026-07-09T04:00:00.000001Z";
const MICRO_NEWER = "2026-07-09T04:00:00.000002Z";

describe("@pickforge/sync", () => {
  it("inserts an absent group", async () => {
    const supabase = new MemorySupabase();

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "appSettings",
        payload: { theme: "dark" },
        updatedAt: OLDER,
      }),
    ).resolves.toEqual({
      status: "written",
      record: {
        fieldGroup: "appSettings",
        payload: { theme: "dark" },
        updatedAt: OLDER,
      },
    });

    expect(supabase.tables.settings_sync).toEqual([
      {
        user_id: USER_ID,
        field_group: "appSettings",
        payload: { theme: "dark" },
        updated_at: OLDER,
        deleted_at: null,
      },
    ]);
  });

  it("lets newer writes win", async () => {
    const supabase = new MemorySupabase();
    await pushGroup({
      supabase,
      userId: USER_ID,
      group: "appSettings",
      payload: { theme: "dark" },
      updatedAt: OLDER,
    });

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "appSettings",
        payload: { theme: "light" },
        updatedAt: NEWER,
      }),
    ).resolves.toEqual({
      status: "written",
      record: {
        fieldGroup: "appSettings",
        payload: { theme: "light" },
        updatedAt: NEWER,
      },
    });

    await expect(pullGroup({ supabase, userId: USER_ID, group: "appSettings" })).resolves.toEqual({
      fieldGroup: "appSettings",
      payload: { theme: "light" },
      updatedAt: NEWER,
    });
  });

  it("preserves microsecond ordering for writes inside the same millisecond", async () => {
    const supabase = new MemorySupabase();
    await pushGroup({
      supabase,
      userId: USER_ID,
      group: "appSettings",
      payload: { theme: "dark" },
      updatedAt: MICRO_OLDER,
    });

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "appSettings",
        payload: { theme: "light" },
        updatedAt: MICRO_NEWER,
      }),
    ).resolves.toEqual({
      status: "written",
      record: {
        fieldGroup: "appSettings",
        payload: { theme: "light" },
        updatedAt: MICRO_NEWER,
      },
    });
    expect(supabase.tables.settings_sync).toContainEqual(
      expect.objectContaining({
        field_group: "appSettings",
        payload: { theme: "light" },
        updated_at: MICRO_NEWER,
      }),
    );
  });

  it("canonicalizes offset timestamps to fixed-width UTC strings", async () => {
    const supabase = new MemorySupabase();

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "operatorConfig",
        payload: { threads: 8 },
        updatedAt: "2026-07-09T01:00:00.123456-03:00",
      }),
    ).resolves.toEqual({
      status: "written",
      record: {
        fieldGroup: "operatorConfig",
        payload: { threads: 8 },
        updatedAt: "2026-07-09T04:00:00.123456Z",
      },
    });
  });

  it("returns the server row for stale pushes", async () => {
    const supabase = new MemorySupabase();
    await pushGroup({
      supabase,
      userId: USER_ID,
      group: "operatorConfig",
      payload: { threads: 8 },
      updatedAt: NEWER,
    });

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "operatorConfig",
        payload: { threads: 2 },
        updatedAt: OLDER,
      }),
    ).resolves.toEqual({
      status: "stale",
      record: {
        fieldGroup: "operatorConfig",
        payload: { threads: 8 },
        updatedAt: NEWER,
      },
    });
  });

  it("isolates LWW by group", async () => {
    const supabase = new MemorySupabase();
    await pushGroup({
      supabase,
      userId: USER_ID,
      group: "appSettings",
      payload: { theme: "dark" },
      updatedAt: NEWER,
    });

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "keybindings",
        payload: { bindings: [{ command: "save", shortcut: "Ctrl+S" }] },
        updatedAt: OLDER,
      }),
    ).resolves.toMatchObject({ status: "written" });

    await expect(pullAll({ supabase, userId: USER_ID })).resolves.toEqual([
      { fieldGroup: "appSettings", payload: { theme: "dark" }, updatedAt: NEWER },
      {
        fieldGroup: "keybindings",
        payload: { bindings: [{ command: "save", shortcut: "Ctrl+S" }] },
        updatedAt: OLDER,
      },
    ]);
  });

  it("tombstones one group for opt-out", async () => {
    const supabase = new MemorySupabase();
    await pushGroup({
      supabase,
      userId: USER_ID,
      group: "appSettings",
      payload: { theme: "dark" },
      updatedAt: OLDER,
    });
    await pushGroup({
      supabase,
      userId: USER_ID,
      group: "remoteBindings",
      payload: { profiles: [{ name: "prod", remoteRoot: "/srv/pickforge" }] },
      updatedAt: OLDER,
    });

    await expect(
      deleteGroup({ supabase, userId: USER_ID, group: "appSettings", updatedAt: DELETED }),
    ).resolves.toEqual({ status: "deleted" });

    await expect(pullAll({ supabase, userId: USER_ID })).resolves.toEqual([
      {
        fieldGroup: "remoteBindings",
        payload: { profiles: [{ name: "prod", remoteRoot: "/srv/pickforge" }] },
        updatedAt: OLDER,
      },
    ]);
    await expect(pullGroup({ supabase, userId: USER_ID, group: "appSettings" })).resolves.toBeNull();
    expect(supabase.tables.settings_sync).toContainEqual(
      expect.objectContaining({
        user_id: USER_ID,
        field_group: "appSettings",
        payload: {},
        updated_at: DELETED,
        deleted_at: DELETED,
      }),
    );
  });

  it("keeps stale pushes from resurrecting tombstoned groups and lets newer pushes restore", async () => {
    const supabase = new MemorySupabase();
    await pushGroup({
      supabase,
      userId: USER_ID,
      group: "appSettings",
      payload: { theme: "dark" },
      updatedAt: NEWER,
    });
    await expect(
      deleteGroup({ supabase, userId: USER_ID, group: "appSettings", updatedAt: DELETED }),
    ).resolves.toEqual({ status: "deleted" });

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "appSettings",
        payload: { theme: "stale" },
        updatedAt: NEWER,
      }),
    ).resolves.toEqual({
      status: "stale",
      record: null,
    });
    await expect(pullGroup({ supabase, userId: USER_ID, group: "appSettings" })).resolves.toBeNull();

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "appSettings",
        payload: { theme: "restored" },
        updatedAt: RESTORED,
      }),
    ).resolves.toEqual({
      status: "written",
      record: {
        fieldGroup: "appSettings",
        payload: { theme: "restored" },
        updatedAt: RESTORED,
      },
    });
    expect(supabase.tables.settings_sync).toContainEqual(
      expect.objectContaining({
        field_group: "appSettings",
        payload: { theme: "restored" },
        updated_at: RESTORED,
        deleted_at: null,
      }),
    );
  });

  it("returns the server row for stale deletes", async () => {
    const supabase = new MemorySupabase();
    await pushGroup({
      supabase,
      userId: USER_ID,
      group: "operatorConfig",
      payload: { threads: 8 },
      updatedAt: NEWER,
    });

    await expect(
      deleteGroup({ supabase, userId: USER_ID, group: "operatorConfig", updatedAt: OLDER }),
    ).resolves.toEqual({
      status: "stale",
      record: {
        fieldGroup: "operatorConfig",
        payload: { threads: 8 },
        updatedAt: NEWER,
      },
    });
    await expect(pullGroup({ supabase, userId: USER_ID, group: "operatorConfig" })).resolves.toEqual({
      fieldGroup: "operatorConfig",
      payload: { threads: 8 },
      updatedAt: NEWER,
    });
  });

  it("treats an equal updated_at as stale, so the first writer wins a tie", async () => {
    const supabase = new MemorySupabase();
    await pushGroup({
      supabase,
      userId: USER_ID,
      group: "appSettings",
      payload: { theme: "first" },
      updatedAt: NEWER,
    });

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "appSettings",
        payload: { theme: "second" },
        updatedAt: NEWER,
      }),
    ).resolves.toEqual({
      status: "stale",
      record: {
        fieldGroup: "appSettings",
        payload: { theme: "first" },
        updatedAt: NEWER,
      },
    });
    expect(supabase.tables.settings_sync).toEqual([
      {
        user_id: USER_ID,
        field_group: "appSettings",
        payload: { theme: "first" },
        updated_at: NEWER,
        deleted_at: null,
      },
    ]);
  });

  it("treats an equal updated_at delete race the same way: first writer wins", async () => {
    const supabase = new MemorySupabase();
    await pushGroup({
      supabase,
      userId: USER_ID,
      group: "appSettings",
      payload: { theme: "dark" },
      updatedAt: OLDER,
    });
    await deleteGroup({ supabase, userId: USER_ID, group: "appSettings", updatedAt: DELETED });

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "appSettings",
        payload: { theme: "racing-push" },
        updatedAt: DELETED,
      }),
    ).resolves.toEqual({ status: "stale", record: null });
    await expect(pullGroup({ supabase, userId: USER_ID, group: "appSettings" })).resolves.toBeNull();
  });
});

interface SettingsSyncRow {
  user_id: string;
  field_group: string;
  payload: Json;
  updated_at: string;
  deleted_at: string | null;
}

interface Tables {
  settings_sync: SettingsSyncRow[];
}

class MemorySupabase implements SupabaseClientLike {
  readonly tables: Tables = {
    settings_sync: [],
  };

  from<T = unknown>(table: string): SupabaseQueryBuilderLike<T> {
    if (table !== "settings_sync") {
      throw new Error(`Unknown table: ${table}`);
    }

    return new MemoryQuery<T>(this, table);
  }

  // Mirrors the durable `settings_sync_lww_write` Postgres function (see
  // supabase/migrations/20260720000000_settings_sync_lww.sql): compares the
  // incoming `updated_at` against any existing row for (user_id, field_group)
  // and performs whichever of insert/update/no-op wins, returning whichever
  // row is now authoritative. This fake is single-threaded, so it is
  // inherently atomic; real concurrent-race coverage lives in the local-
  // Postgres contract lane (packages/sync/test/lww.contract.test.ts).
  rpc(fn: string, args: Record<string, unknown> = {}): PromiseLike<SupabaseQueryResult<unknown>> {
    if (fn !== "settings_sync_lww_write") {
      throw new Error(`Unknown rpc: ${fn}`);
    }

    return Promise.resolve(this.applyLwwWrite(args));
  }

  private applyLwwWrite(args: Record<string, unknown>): SupabaseQueryResult<unknown> {
    const targetUser = args.target_user as string;
    const targetGroup = args.target_group as string;
    const newPayload = args.new_payload as Json;
    const newUpdatedAt = args.new_updated_at as string;
    const newDeletedAt = (args.new_deleted_at as string | null) ?? null;

    const existing = this.tables.settings_sync.find(
      (row) => row.user_id === targetUser && row.field_group === targetGroup,
    );

    if (existing === undefined) {
      const row: SettingsSyncRow = {
        user_id: targetUser,
        field_group: targetGroup,
        payload: newPayload,
        updated_at: newUpdatedAt,
        deleted_at: newDeletedAt,
      };
      this.tables.settings_sync.push(row);
      return { data: { written: true, ...row }, error: null };
    }

    if (newUpdatedAt > existing.updated_at) {
      existing.payload = newPayload;
      existing.updated_at = newUpdatedAt;
      existing.deleted_at = newDeletedAt;
      return { data: { written: true, ...existing }, error: null };
    }

    return { data: { written: false, ...existing }, error: null };
  }
}

class MemoryQuery<T> implements SupabaseQueryBuilderLike<T> {
  private filters: Array<{ column: string; op: "eq" | "is"; value: unknown }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly supabase: MemorySupabase,
    private readonly table: keyof Tables,
  ) {}

  select(): SupabaseQueryBuilderLike<T> {
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryBuilderLike<T> {
    this.filters.push({ column, op: "eq", value });
    return this;
  }

  is(column: string, value: unknown): SupabaseQueryBuilderLike<T> {
    this.filters.push({ column, op: "is", value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): SupabaseQueryBuilderLike<T> {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  async maybeSingle(): Promise<SupabaseQueryResult<T | null>> {
    const result = await this.execute();
    const rows = Array.isArray(result.data) ? result.data : result.data === null ? [] : [result.data];

    return {
      data: (rows[0] ?? null) as T | null,
      error: result.error,
    };
  }

  then<TResult1 = SupabaseQueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<SupabaseQueryResult<T>> {
    let rows = this.matchingRows();
    if (this.orderBy !== null) {
      rows = [...rows].sort((left, right) => {
        const leftValue = String(left[this.orderBy?.column as keyof SettingsSyncRow]);
        const rightValue = String(right[this.orderBy?.column as keyof SettingsSyncRow]);
        return this.orderBy?.ascending === true
          ? leftValue.localeCompare(rightValue)
          : rightValue.localeCompare(leftValue);
      });
    }

    return { data: rows as T, error: null };
  }

  private matchingRows(): SettingsSyncRow[] {
    return this.supabase.tables[this.table].filter((row) =>
      this.filters.every((filter) => {
        const value = row[filter.column as keyof SettingsSyncRow];
        return value === filter.value;
      }),
    );
  }
}
