// Local-Postgres contract-lane adapter. Implements the same `SupabaseClientLike`
// boundary `claimRouteAttempt` / `completeRouteAttempt` / `failRouteAttempt` /
// `findDebitedRouteResult` / `debitCredits` are written against, but backed by
// a real `bun:sql` connection instead of the in-memory fake used by the fast
// unit tests. No claim/complete/debit decision vocabulary is reimplemented
// here: every decision is made by the durable SQL functions in
// supabase/migrations, exactly as production (the service-role client) does.
import type { SQL } from "bun";
import type {
  SupabaseClientLike,
  SupabaseErrorLike,
  SupabaseQueryBuilderLike,
  SupabaseQueryResult,
} from "../src/index.js";

// The subset of RPCs whose SQL return type is jsonb: bun's postgres driver
// hands jsonb columns back as text, so these need JSON.parse.
const JSONB_RPCS = new Set(["router_attempt_claim", "router_attempt_complete", "debit_credits"]);

const KNOWN_TABLES = ["credit_ledger"] as const;
type KnownTable = (typeof KNOWN_TABLES)[number];

export function createPostgresRouterClient(sql: SQL): Pick<SupabaseClientLike, "from" | "rpc"> {
  return {
    from(table: string) {
      if (!isKnownTable(table)) {
        throw new Error(`Unknown table: ${table}`);
      }
      return new PostgresLedgerQuery(sql, table);
    },
    rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}) {
      return callRpc(sql, fn, args) as Promise<SupabaseQueryResult<T>>;
    },
  };
}

/**
 * Production RPC calls each run as their own independent PostgREST
 * request/transaction, so a caught error (e.g. a rejected claim) on one call
 * never affects another. The contract lane instead nests calls inside one
 * outer per-test transaction (for cheap rollback-based cleanup), so each call
 * runs in its own SAVEPOINT: an error rolls back only that call, keeping the
 * outer transaction usable, exactly like independent requests would behave
 * in production.
 */
async function withIsolatedQuery<T>(sql: SQL, run: (handle: SQL) => Promise<T>): Promise<T> {
  const transactional = sql as SQL & {
    savepoint?: <R>(fn: (sp: SQL) => Promise<R>) => Promise<R>;
  };
  if (typeof transactional.savepoint === "function") {
    return transactional.savepoint((sp) => run(sp));
  }
  return run(sql);
}

async function callRpc(
  sql: SQL,
  fn: string,
  args: Record<string, unknown>,
): Promise<SupabaseQueryResult<unknown>> {
  const keys = Object.keys(args);
  const placeholders = keys.map((key, index) => `${key} => $${index + 1}`).join(", ");
  // Bun's `postgres` driver double-encodes JSON.stringify'd object params
  // bound to a jsonb-typed function argument (it JSON-serializes them again
  // client-side), so pass objects (like usage_metadata) through as-is and let
  // the driver encode them.
  const values = keys.map((key) => args[key]);
  const text = `select public.${fn}(${placeholders}) as result`;

  try {
    const rows = await withIsolatedQuery(sql, (handle) => handle.unsafe(text, values));
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

class PostgresLedgerQuery<T> implements SupabaseQueryBuilderLike<T> {
  private columns = "*";
  private readonly filters: Array<{ column: string; value: unknown }> = [];

  constructor(
    private readonly sql: SQL,
    private readonly table: KnownTable,
  ) {}

  select(columns = "*"): SupabaseQueryBuilderLike<T> {
    this.columns = columns;
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryBuilderLike<T> {
    this.filters.push({ column, value });
    return this;
  }

  is(column: string, value: null): SupabaseQueryBuilderLike<T> {
    return this.eq(column, value);
  }

  order(): SupabaseQueryBuilderLike<T> {
    return this;
  }

  range(): SupabaseQueryBuilderLike<T> {
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
      return await withIsolatedQuery(this.sql, (handle) => this.runSelect(handle));
    } catch (error) {
      return { data: null, error: toSupabaseError(error) };
    }
  }

  private async runSelect(handle: SQL): Promise<SupabaseQueryResult<T>> {
    const params: unknown[] = [];
    const where = this.filters
      .map((filter) => {
        params.push(filter.value);
        return `${filter.column} = $${params.length}`;
      })
      .join(" and ");
    let text = `select ${this.columns} from public.${this.table}`;
    if (where.length > 0) {
      text += ` where ${where}`;
    }
    const rows = await handle.unsafe(text, params);
    return { data: rows.map(parseJsonbMetadata) as T, error: null };
  }
}

// Bun's postgres driver decodes a jsonb column fetched via a plain SELECT as
// text (unlike an insert/update `returning`, which the driver does parse),
// but `SupabaseClientLike` consumers expect the already-decoded value, same
// as a real supabase-js/PostgREST client returns.
function parseJsonbMetadata(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.metadata !== "string") {
    return row;
  }
  return { ...row, metadata: JSON.parse(row.metadata) };
}

function isKnownTable(table: string): table is KnownTable {
  return (KNOWN_TABLES as readonly string[]).includes(table);
}
