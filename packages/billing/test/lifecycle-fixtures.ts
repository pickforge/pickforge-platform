// Local-Postgres contract-lane fixtures. Mirrors the `SUPABASE_DB_URL` /
// localhost-only guard used by `supabase/tests/welcome-credits-concurrency.ts`
// so this lane can never accidentally target a non-disposable database, and
// gracefully reports why it is skipped when no local Supabase is running.
import { SQL } from "bun";

export const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export function resolveLocalDatabaseUrl(): string | null {
  const raw = process.env.SUPABASE_DB_URL ?? DEFAULT_DATABASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const isDisposableLocalDatabase =
    ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) &&
    parsed.port === "54322" &&
    parsed.pathname === "/postgres" &&
    parsed.username === "postgres";
  return isDisposableLocalDatabase ? raw : null;
}

/**
 * Connects to the local Supabase Postgres started by `supabase start`. Returns
 * `null` (never throws) when the database is unreachable so the contract lane
 * can skip cleanly instead of failing CI runs that have no local Postgres.
 */
export async function connectToLocalDatabase(): Promise<SQL | null> {
  const databaseUrl = resolveLocalDatabaseUrl();
  if (databaseUrl === null) {
    return null;
  }

  const sql = new SQL(databaseUrl, { max: 10 });
  try {
    await sql.unsafe("select 1");
  } catch {
    await sql.close().catch(() => {});
    return null;
  }
  return sql;
}

export function uniqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function insertAuthUser(
  sql: Pick<SQL, "unsafe">,
  user: { id: string; email: string },
): Promise<void> {
  await sql.unsafe(
    `insert into auth.users (
      id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at
    ) values ($1, 'authenticated', 'authenticated', $2, '{}'::jsonb, '{}'::jsonb, false, now(), now())`,
    [user.id, user.email],
  );
}

/**
 * Cleans up rows the contract lane cannot roll back transactionally: used only
 * by the true-concurrency test, which needs two independent connections/
 * transactions racing for real, so it commits instead of rolling back.
 */
export async function cleanupLifecycleFixtures(
  sql: Pick<SQL, "unsafe" | "array">,
  fixtures: { userIds?: string[]; sessionIds?: string[]; eventIds?: string[] },
): Promise<void> {
  const sessionIds = fixtures.sessionIds ?? [];
  const userIds = fixtures.userIds ?? [];
  const eventIds = fixtures.eventIds ?? [];

  if (sessionIds.length > 0) {
    const sessionIdArray = sql.array(sessionIds, "text");
    await sql.unsafe(
      "delete from checkout_lifecycle_private.refund_attempts where stripe_checkout_session_id = any($1::text[])",
      [sessionIdArray],
    );
    await sql.unsafe(
      "delete from checkout_lifecycle_private.checkout_sessions where stripe_checkout_session_id = any($1::text[])",
      [sessionIdArray],
    );
  }
  if (eventIds.length > 0) {
    await sql.unsafe("delete from public.stripe_events where event_id = any($1::text[])", [
      sql.array(eventIds, "text"),
    ]);
  }
  if (userIds.length > 0) {
    const userIdArray = sql.array(userIds, "uuid");
    await sql.unsafe(
      "delete from checkout_lifecycle_private.deletion_fences where user_id = any($1::uuid[])",
      [userIdArray],
    );
    // Cascades billing_customers and credit_ledger rows for the same user.
    await sql.unsafe("delete from auth.users where id = any($1::uuid[])", [userIdArray]);
  }
}

/**
 * Runs `run` inside a transaction that always rolls back, so each contract
 * test is fully isolated without needing bespoke per-table cleanup. Only the
 * true-concurrency test opts out of this helper, since it needs two
 * independently committing connections.
 */
export async function withRollback(
  sql: SQL,
  run: (tx: SQL) => Promise<void>,
): Promise<void> {
  const rollbackSentinel = Symbol("contract-lane-rollback");
  try {
    await sql.begin(async (tx) => {
      await run(tx);
      throw rollbackSentinel;
    });
  } catch (error) {
    if (error !== rollbackSentinel) {
      throw error;
    }
  }
}
