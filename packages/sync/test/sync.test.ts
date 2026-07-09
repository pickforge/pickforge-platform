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

  it("retries the conditional update after an ignored duplicate insert race", async () => {
    const supabase = new MemorySupabase();
    supabase.beforeNextUpsert(() => {
      supabase.tables.settings_sync.push({
        user_id: USER_ID,
        field_group: "appSettings",
        payload: { theme: "older" },
        updated_at: OLDER,
        deleted_at: null,
      });
    });

    await expect(
      pushGroup({
        supabase,
        userId: USER_ID,
        group: "appSettings",
        payload: { theme: "newer" },
        updatedAt: NEWER,
      }),
    ).resolves.toEqual({
      status: "written",
      record: {
        fieldGroup: "appSettings",
        payload: { theme: "newer" },
        updatedAt: NEWER,
      },
    });
    expect(supabase.tables.settings_sync).toEqual([
      {
        user_id: USER_ID,
        field_group: "appSettings",
        payload: { theme: "newer" },
        updated_at: NEWER,
        deleted_at: null,
      },
    ]);
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

  private readonly upsertHooks: Array<() => void> = [];

  from<T = unknown>(table: string): SupabaseQueryBuilderLike<T> {
    if (table !== "settings_sync") {
      throw new Error(`Unknown table: ${table}`);
    }

    return new MemoryQuery<T>(this, table);
  }

  beforeNextUpsert(hook: () => void): void {
    this.upsertHooks.push(hook);
  }

  runBeforeUpsert(): void {
    this.upsertHooks.shift()?.();
  }
}

class MemoryQuery<T> implements SupabaseQueryBuilderLike<T> {
  private action: "select" | "update" | "upsert" = "select";
  private values: Record<string, unknown> | null = null;
  private filters: Array<{ column: string; op: "eq" | "is" | "lt"; value: unknown }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private onConflict: string | undefined;
  private ignoreDuplicates = false;

  constructor(
    private readonly supabase: MemorySupabase,
    private readonly table: keyof Tables,
  ) {}

  select(): SupabaseQueryBuilderLike<T> {
    return this;
  }

  update(values: unknown): SupabaseQueryBuilderLike<T> {
    this.action = "update";
    this.values = values as Record<string, unknown>;
    return this;
  }

  upsert(
    values: unknown,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): SupabaseQueryBuilderLike<T> {
    this.action = "upsert";
    this.values = values as Record<string, unknown>;
    this.onConflict = options?.onConflict;
    this.ignoreDuplicates = options?.ignoreDuplicates === true;
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

  lt(column: string, value: unknown): SupabaseQueryBuilderLike<T> {
    this.filters.push({ column, op: "lt", value });
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
    if (this.action === "update") {
      const rows = this.matchingRows();
      for (const row of rows) {
        Object.assign(row, this.values);
      }

      return { data: rows as T, error: null };
    }

    if (this.action === "upsert") {
      return this.upsertRow() as SupabaseQueryResult<T>;
    }

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

  private upsertRow(): SupabaseQueryResult<SettingsSyncRow[] | null> {
    const value = this.values as unknown as SettingsSyncRow;
    const conflictColumns = (this.onConflict ?? "").split(",").map((column) => column.trim());
    this.supabase.runBeforeUpsert();
    const existing = this.supabase.tables[this.table].find((row) =>
      conflictColumns.every(
        (column) => row[column as keyof SettingsSyncRow] === value[column as keyof SettingsSyncRow],
      ),
    );

    if (existing !== undefined) {
      if (this.ignoreDuplicates) {
        return { data: null, error: null };
      }

      Object.assign(existing, value);
      return { data: [existing], error: null };
    }

    this.supabase.tables[this.table].push(value);
    return { data: [value], error: null };
  }

  private matchingRows(): SettingsSyncRow[] {
    return this.supabase.tables[this.table].filter((row) =>
      this.filters.every((filter) => {
        const value = row[filter.column as keyof SettingsSyncRow];
        if (filter.op === "lt") {
          return String(value) < String(filter.value);
        }
        if (filter.op === "is") {
          return value === filter.value;
        }

        return value === filter.value;
      }),
    );
  }
}
