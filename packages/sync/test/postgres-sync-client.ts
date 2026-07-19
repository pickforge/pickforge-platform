// Local-Postgres contract-lane adapter. Implements the same `SupabaseClientLike`
// boundary the production `pushGroup` / `pullAll` / `pullGroup` / `deleteGroup`
// code is written against, but backed by a real `bun:sql` connection instead
// of the in-memory fake. No LWW decision vocabulary is reimplemented here:
// the compare/write/winner decision is made entirely by the durable
// `settings_sync_lww_write` Postgres function, exactly as production does.
//
// Unlike the billing contract lane's Postgres client, `settings_sync` is
// guarded by row-level security scoped to `auth.uid()`, not a service-role-
// only private schema, so every call here runs as the `authenticated` role
// with `request.jwt.claim.sub` set to the acting user — the same boundary a
// real client app session presents to Postgres.
import type { SQL } from "bun";
import type {
  SupabaseClientLike,
  SupabaseErrorLike,
  SupabaseQueryBuilderLike,
  SupabaseQueryResult,
} from "../src/index.js";

const JSONB_RPCS = new Set(["settings_sync_lww_write"]);
const KNOWN_TABLES = ["settings_sync"] as const;
type KnownTable = (typeof KNOWN_TABLES)[number];

export function createPostgresSyncClient(sql: SQL, userId: string): SupabaseClientLike {
  return {
    from(table: string) {
      if (!isKnownTable(table)) {
        throw new Error(`Unknown table: ${table}`);
      }
      return new PostgresQuery(sql, table, userId);
    },
    rpc(fn: string, args: Record<string, unknown> = {}) {
      return callRpc(sql, userId, fn, args);
    },
  };
}

/**
 * Every call authenticates as `userId` (mirroring a real PostgREST request)
 * before running its query, and — when nested inside an outer per-test
 * transaction (`withRollback`) — runs inside its own SAVEPOINT so an
 * expected error (e.g. a cross-user isolation check) rolls back only that
 * call, keeping the outer transaction usable, exactly like independent
 * requests would behave in production.
 */
async function withUserSession<T>(
  sql: SQL,
  userId: string,
  run: (handle: SQL) => Promise<T>,
): Promise<T> {
  const authenticate = async (handle: SQL) => {
    await handle.unsafe("set local role authenticated");
    await handle.unsafe("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return run(handle);
  };

  const transactional = sql as SQL & {
    savepoint?: <R>(fn: (sp: SQL) => Promise<R>) => Promise<R>;
  };
  if (typeof transactional.savepoint === "function") {
    return transactional.savepoint((sp) => authenticate(sp));
  }
  return authenticate(sql);
}

async function callRpc(
  sql: SQL,
  userId: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<SupabaseQueryResult<unknown>> {
  const keys = Object.keys(args);
  const placeholders = keys.map((key, index) => `${key} => $${index + 1}`).join(", ");
  // Bun's `postgres` driver double-encodes JSON.stringify'd object params
  // bound to a jsonb-typed function argument (it JSON-serializes them again
  // client-side), so pass objects (like new_payload) through as-is and let
  // the driver encode them.
  const values = keys.map((key) => args[key]);
  const text = `select public.${fn}(${placeholders}) as result`;

  try {
    const rows = await withUserSession(sql, userId, (handle) => handle.unsafe(text, values));
    const raw = rows[0]?.result;
    if (JSONB_RPCS.has(fn)) {
      return { data: typeof raw === "string" ? JSON.parse(raw) : (raw ?? null), error: null };
    }
    return { data: raw === "" ? null : raw, error: null };
  } catch (error) {
    return { data: null, error: toSupabaseError(error) };
  }
}

function toSupabaseError(error: unknown): SupabaseErrorLike {
  if (error !== null && typeof error === "object" && "message" in error) {
    const pgError = error as { message: unknown; code?: unknown; errno?: unknown };
    const code =
      typeof pgError.errno === "string"
        ? pgError.errno
        : typeof pgError.code === "string"
          ? pgError.code
          : undefined;
    return {
      code,
      message: typeof pgError.message === "string" ? pgError.message : String(pgError.message),
    };
  }
  return { message: String(error) };
}

class PostgresQuery<T> implements SupabaseQueryBuilderLike<T> {
  private columns = "*";
  private readonly filters: Array<{ column: string; op: "eq" | "is"; value: unknown }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly sql: SQL,
    private readonly table: KnownTable,
    private readonly userId: string,
  ) {}

  select(columns = "*"): SupabaseQueryBuilderLike<T> {
    this.columns = columns;
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
    return { data: (rows[0] ?? null) as T | null, error: result.error };
  }

  then<TResult1 = SupabaseQueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<SupabaseQueryResult<T>> {
    try {
      return await withUserSession(this.sql, this.userId, (handle) => this.runSelect(handle));
    } catch (error) {
      return { data: null, error: toSupabaseError(error) };
    }
  }

  private async runSelect(handle: SQL): Promise<SupabaseQueryResult<T>> {
    const params: unknown[] = [];
    const where = this.filters
      .map((filter) => {
        if (filter.op === "is" && filter.value === null) {
          return `${filter.column} is null`;
        }
        params.push(filter.value);
        return filter.op === "is"
          ? `${filter.column} is $${params.length}`
          : `${filter.column} = $${params.length}`;
      })
      .join(" and ");
    let text = `select ${this.columns} from public.${this.table}`;
    if (where.length > 0) {
      text += ` where ${where}`;
    }
    if (this.orderBy !== null) {
      text += ` order by ${this.orderBy.column} ${this.orderBy.ascending ? "asc" : "desc"}`;
    }
    const rows = await handle.unsafe(text, params);
    return { data: rows.map(toTextRow) as T, error: null };
  }
}

// Bun's `postgres` driver decodes `timestamptz` columns fetched via a plain
// SELECT into JS `Date` objects (unlike the RPC path, whose jsonb payload
// already comes back as ISO text), but `SupabaseClientLike` consumers expect
// ISO strings, matching what a real supabase-js/PostgREST client returns.
function toTextRow(row: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    converted[key] = value instanceof Date ? value.toISOString() : value;
  }
  return converted;
}

function isKnownTable(table: string): table is KnownTable {
  return (KNOWN_TABLES as readonly string[]).includes(table);
}
