// Settings sync LWW contract lane (issue #37, CAND-3).
//
// Exercises the production `pushGroup` / `deleteGroup` / `pullGroup` policy
// against the REAL durable `settings_sync_lww_write` SQL function in
// supabase/migrations/20260720000000_settings_sync_lww.sql, running on a
// local Supabase Postgres. The compare/write/winner decision lives entirely
// behind the `SupabaseClientLike` boundary — this file never reimplements
// LWW policy, it only asserts on outcomes, including genuine concurrent
// races between independently committing Postgres transactions.
//
// Prerequisite: a local Supabase Postgres via `supabase start` (requires
// Docker). When it is not reachable, every test below is skipped with a
// console message instead of failing the run. CI's `database` job starts
// Supabase and runs this lane for real via `bun run test:supabase`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { deleteGroup, pullGroup, pushGroup, type PushGroupResult } from "../src/index.js";
import {
  cleanupSyncFixtures,
  connectToLocalDatabase,
  DEFAULT_DATABASE_URL,
  insertAuthUser,
  resolveLocalDatabaseUrl,
  uniqueId,
  withRollback,
} from "./lww-fixtures.js";
import { createPostgresSyncClient } from "./postgres-sync-client.js";

const sql = await connectToLocalDatabase();

if (sql === null) {
  console.log(
    "[sync contract lane] Skipping settings-sync LWW Postgres contract tests: " +
      `no local Supabase Postgres reachable at ${resolveLocalDatabaseUrl() ?? process.env.SUPABASE_DB_URL ?? DEFAULT_DATABASE_URL}. ` +
      "Run `supabase start` (requires Docker) to exercise this lane locally; " +
      "CI's `database` job runs it automatically via `bun run test:supabase`.",
  );
}

describe.skipIf(sql === null)("@pickforge/sync settings sync LWW contract (local Postgres)", () => {
  const db = sql as SQL;

  afterAll(async () => {
    await db.close();
  });

  async function createUser(tx: SQL, label: string): Promise<string> {
    const userId = crypto.randomUUID();
    await insertAuthUser(tx, { id: userId, email: `${uniqueId(label)}@example.invalid` });
    return userId;
  }

  it("inserts an absent group and lets a strictly newer push win", async () => {
    await withRollback(db, async (tx) => {
      const userId = await createUser(tx, "push-newer-wins");
      const client = createPostgresSyncClient(tx, userId);

      await expect(
        pushGroup({
          supabase: client,
          userId,
          group: "appSettings",
          payload: { theme: "dark" },
          updatedAt: "2026-07-09T04:00:00.000000Z",
        }),
      ).resolves.toMatchObject({ status: "written" });

      await expect(
        pushGroup({
          supabase: client,
          userId,
          group: "appSettings",
          payload: { theme: "light" },
          updatedAt: "2026-07-09T04:05:00.000000Z",
        }),
      ).resolves.toEqual({
        status: "written",
        record: { fieldGroup: "appSettings", payload: { theme: "light" }, updatedAt: "2026-07-09T04:05:00.000000Z" },
      });

      await expect(pullGroup({ supabase: client, userId, group: "appSettings" })).resolves.toEqual({
        fieldGroup: "appSettings",
        payload: { theme: "light" },
        updatedAt: "2026-07-09T04:05:00.000000Z",
      });
    });
  });

  it("returns the winning row for a stale push without a follow-up read", async () => {
    await withRollback(db, async (tx) => {
      const userId = await createUser(tx, "push-stale");
      const client = createPostgresSyncClient(tx, userId);

      await pushGroup({
        supabase: client,
        userId,
        group: "operatorConfig",
        payload: { threads: 8 },
        updatedAt: "2026-07-09T04:05:00.000000Z",
      });

      await expect(
        pushGroup({
          supabase: client,
          userId,
          group: "operatorConfig",
          payload: { threads: 2 },
          updatedAt: "2026-07-09T04:00:00.000000Z",
        }),
      ).resolves.toEqual({
        status: "stale",
        record: { fieldGroup: "operatorConfig", payload: { threads: 8 }, updatedAt: "2026-07-09T04:05:00.000000Z" },
      });
    });
  });

  it("treats an equal updated_at push as stale (first writer wins the tie)", async () => {
    await withRollback(db, async (tx) => {
      const userId = await createUser(tx, "push-equal-tie");
      const client = createPostgresSyncClient(tx, userId);
      const tie = "2026-07-09T04:05:00.000000Z";

      await pushGroup({
        supabase: client,
        userId,
        group: "appSettings",
        payload: { theme: "first" },
        updatedAt: tie,
      });

      await expect(
        pushGroup({
          supabase: client,
          userId,
          group: "appSettings",
          payload: { theme: "second" },
          updatedAt: tie,
        }),
      ).resolves.toEqual({
        status: "stale",
        record: { fieldGroup: "appSettings", payload: { theme: "first" }, updatedAt: tie },
      });
    });
  });

  it("keeps older data from resurrecting a group after a newer tombstone", async () => {
    await withRollback(db, async (tx) => {
      const userId = await createUser(tx, "tombstone-resurrect");
      const client = createPostgresSyncClient(tx, userId);

      await pushGroup({
        supabase: client,
        userId,
        group: "appSettings",
        payload: { theme: "dark" },
        updatedAt: "2026-07-09T04:00:00.000000Z",
      });
      await expect(
        deleteGroup({
          supabase: client,
          userId,
          group: "appSettings",
          updatedAt: "2026-07-09T04:10:00.000000Z",
        }),
      ).resolves.toEqual({ status: "deleted" });

      await expect(
        pushGroup({
          supabase: client,
          userId,
          group: "appSettings",
          payload: { theme: "late-arrival" },
          updatedAt: "2026-07-09T04:05:00.000000Z",
        }),
      ).resolves.toEqual({ status: "stale", record: null });
      await expect(pullGroup({ supabase: client, userId, group: "appSettings" })).resolves.toBeNull();

      await expect(
        pushGroup({
          supabase: client,
          userId,
          group: "appSettings",
          payload: { theme: "restored" },
          updatedAt: "2026-07-09T04:15:00.000000Z",
        }),
      ).resolves.toEqual({
        status: "written",
        record: { fieldGroup: "appSettings", payload: { theme: "restored" }, updatedAt: "2026-07-09T04:15:00.000000Z" },
      });
    });
  });

  it("resolves two genuinely concurrent pushes to exactly one durable, order-independent winner", async () => {
    const userId = crypto.randomUUID();
    await insertAuthUser(db, { id: userId, email: `${uniqueId("concurrent-push-push")}@example.invalid` });

    try {
      const [olderOutcome, newerOutcome] = await Promise.all([
        db.begin(async (tx) => {
          const client = createPostgresSyncClient(tx, userId);
          return pushGroup({
            supabase: client,
            userId,
            group: "appSettings",
            payload: { theme: "older" },
            updatedAt: "2026-07-09T04:00:00.000000Z",
          });
        }),
        db.begin(async (tx) => {
          const client = createPostgresSyncClient(tx, userId);
          return pushGroup({
            supabase: client,
            userId,
            group: "appSettings",
            payload: { theme: "newer" },
            updatedAt: "2026-07-09T04:05:00.000000Z",
          });
        }),
      ]);

      // Whichever transaction committed first durably decided the outcome,
      // but the newer updated_at always wins the durable comparison: no
      // interleaving lets the older write survive.
      expect(newerOutcome).toEqual({
        status: "written",
        record: { fieldGroup: "appSettings", payload: { theme: "newer" }, updatedAt: "2026-07-09T04:05:00.000000Z" },
      });
      expect(olderOutcome.status === "stale" || olderOutcome.status === "written").toBe(true);
      const olderResult = olderOutcome as PushGroupResult;
      if (olderResult.status === "stale") {
        expect(olderResult.record).toEqual({
          fieldGroup: "appSettings",
          payload: { theme: "newer" },
          updatedAt: "2026-07-09T04:05:00.000000Z",
        });
      }

      const rows = await db.unsafe(
        "select payload, updated_at from public.settings_sync where user_id = $1 and field_group = 'appSettings'",
        [userId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ payload: { theme: "newer" } });
    } finally {
      await cleanupSyncFixtures(db, { userIds: [userId] });
    }
  });

  it("resolves a push racing a delete to exactly one durable, order-independent winner", async () => {
    const userId = crypto.randomUUID();
    await insertAuthUser(db, { id: userId, email: `${uniqueId("concurrent-push-delete")}@example.invalid` });
    await db.unsafe(
      `insert into public.settings_sync (user_id, field_group, payload, updated_at, deleted_at)
       values ($1, 'appSettings', $2, $3, null)`,
      [userId, { theme: "seed" }, "2026-07-09T03:00:00.000000Z"],
    );

    try {
      const [pushOutcome, deleteOutcome] = await Promise.all([
        db.begin(async (tx) => {
          const client = createPostgresSyncClient(tx, userId);
          return pushGroup({
            supabase: client,
            userId,
            group: "appSettings",
            payload: { theme: "pushed" },
            updatedAt: "2026-07-09T04:00:00.000000Z",
          });
        }),
        db.begin(async (tx) => {
          const client = createPostgresSyncClient(tx, userId);
          return deleteGroup({
            supabase: client,
            userId,
            group: "appSettings",
            updatedAt: "2026-07-09T04:05:00.000000Z",
          });
        }),
      ]);

      // The delete has the strictly newer updated_at than both the seed row
      // and the push, so it always durably wins in the end no matter which
      // transaction's compare/write runs first. The push's own outcome
      // depends on whether it ran before or after the delete (it can
      // legitimately win against the older seed row first and then get
      // superseded), so only the delete's outcome and the final row state
      // are order-independent.
      expect(deleteOutcome.status).toBe("deleted");
      expect(pushOutcome.status === "stale" || pushOutcome.status === "written").toBe(true);

      const rows = await db.unsafe(
        "select deleted_at from public.settings_sync where user_id = $1 and field_group = 'appSettings'",
        [userId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deleted_at).not.toBeNull();
    } finally {
      await cleanupSyncFixtures(db, { userIds: [userId] });
    }
  });

  it("resolves two genuinely concurrent first inserts to exactly one durable, order-independent winner", async () => {
    const userId = crypto.randomUUID();
    await insertAuthUser(db, { id: userId, email: `${uniqueId("concurrent-first-insert")}@example.invalid` });

    try {
      const [firstOutcome, secondOutcome] = await Promise.all([
        db.begin(async (tx) => {
          const client = createPostgresSyncClient(tx, userId);
          return pushGroup({
            supabase: client,
            userId,
            group: "keybindings",
            payload: { bindings: [{ command: "save", shortcut: "Ctrl+S" }] },
            updatedAt: "2026-07-09T04:00:00.000000Z",
          });
        }),
        db.begin(async (tx) => {
          const client = createPostgresSyncClient(tx, userId);
          return pushGroup({
            supabase: client,
            userId,
            group: "keybindings",
            payload: { bindings: [{ command: "save", shortcut: "Ctrl+Shift+S" }] },
            updatedAt: "2026-07-09T04:05:00.000000Z",
          });
        }),
      ]);

      // The strictly newer insert always durably wins, even though both
      // transactions raced to insert the first row for this group.
      expect(secondOutcome).toEqual({
        status: "written",
        record: {
          fieldGroup: "keybindings",
          payload: { bindings: [{ command: "save", shortcut: "Ctrl+Shift+S" }] },
          updatedAt: "2026-07-09T04:05:00.000000Z",
        },
      });
      expect(firstOutcome.status === "stale" || firstOutcome.status === "written").toBe(true);

      const rows = await db.unsafe(
        "select payload from public.settings_sync where user_id = $1 and field_group = 'keybindings'",
        [userId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ payload: { bindings: [{ command: "save", shortcut: "Ctrl+Shift+S" }] } });
    } finally {
      await cleanupSyncFixtures(db, { userIds: [userId] });
    }
  });

  it("rejects a durable write to another user's row (per-user isolation)", async () => {
    await withRollback(db, async (tx) => {
      const ownerId = await createUser(tx, "isolation-owner");
      const attackerId = await createUser(tx, "isolation-attacker");
      const attackerClient = createPostgresSyncClient(tx, attackerId);

      await expect(
        pushGroup({
          supabase: attackerClient,
          userId: ownerId,
          group: "appSettings",
          payload: { theme: "stolen" },
          updatedAt: "2026-07-09T04:00:00.000000Z",
        }),
      ).rejects.toMatchObject({ name: "SyncError", code: "database_error" });
    });
  });
});
