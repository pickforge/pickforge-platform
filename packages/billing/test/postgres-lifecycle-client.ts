// Local-Postgres contract-lane adapter. Implements the same `SupabaseClientLike`
// boundary the production `processStripeEvent` / `getCreditBalanceCents` /
// `listLedgerEntries` code is written against, but backed by a real `bun:sql`
// connection instead of the in-memory fake. No lifecycle transition vocabulary
// is reimplemented here: every `checkout_lifecycle_*` decision is made by the
// durable SQL functions in supabase/migrations, exactly as production does.
import type { SQL } from "bun";
import type {
  SupabaseClientLike,
  SupabaseErrorLike,
  SupabaseQueryBuilderLike,
  SupabaseQueryResult,
} from "../src/index.js";

// The subset of checkout_lifecycle_* RPCs whose SQL return type is jsonb: bun's
// postgres driver hands jsonb columns back as text, so these need JSON.parse.
const JSONB_RPCS = new Set([
  "checkout_lifecycle_prepare_refund_attempt",
  "checkout_lifecycle_reconcile_refund_event",
  "checkout_lifecycle_get_customer_cleanup",
  "checkout_lifecycle_finalize_deletion",
]);

const KNOWN_TABLES = ["billing_customers", "credit_ledger", "stripe_events"] as const;
type KnownTable = (typeof KNOWN_TABLES)[number];

export function createPostgresSupabaseClient(sql: SQL): SupabaseClientLike {
  return {
    from(table: string) {
      if (!isKnownTable(table)) {
        throw new Error(`Unknown table: ${table}`);
      }
      return new PostgresQuery(sql, table);
    },
    rpc(fn: string, args: Record<string, unknown> = {}) {
      return callRpc(sql, fn, args);
    },
  };
}

/**
 * Production RPC/query calls each run as their own independent PostgREST
 * request/transaction, so a caught error (e.g. a duplicate-key retry) on one
 * call never affects another. The contract lane instead nests every call
 * inside one outer per-test transaction (for cheap rollback-based cleanup),
 * so each call is wrapped in its own SAVEPOINT: an error rolls back only that
 * call, keeping the outer transaction usable, exactly like independent
 * requests would behave in production.
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
  const values = keys.map((key) => toSqlParam(args[key]));
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

function toSqlParam(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
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
  private action: "select" | "insert" | "upsert" = "select";
  private values: Record<string, unknown> | null = null;
  private onConflict: string | undefined;
  private readonly filters: Array<{ column: string; value: unknown }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitCount: number | null = null;
  private columns = "*";

  constructor(
    private readonly sql: SQL,
    private readonly table: KnownTable,
  ) {}

  select(columns = "*"): SupabaseQueryBuilderLike<T> {
    this.action = "select";
    this.columns = columns;
    return this;
  }

  insert(values: unknown): SupabaseQueryBuilderLike<T> {
    this.action = "insert";
    this.values = values as Record<string, unknown>;
    return this;
  }

  upsert(values: unknown, options?: { onConflict?: string }): SupabaseQueryBuilderLike<T> {
    this.action = "upsert";
    this.values = values as Record<string, unknown>;
    this.onConflict = options?.onConflict;
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryBuilderLike<T> {
    this.filters.push({ column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): SupabaseQueryBuilderLike<T> {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(count: number): SupabaseQueryBuilderLike<T> {
    this.limitCount = count;
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
      if (this.action === "insert") {
        const values = this.values ?? {};
        return await withIsolatedQuery(this.sql, (handle) => this.runInsert(handle, values));
      }
      if (this.action === "upsert") {
        const values = this.values ?? {};
        const onConflict = this.onConflict;
        return await withIsolatedQuery(this.sql, (handle) => this.runUpsert(handle, values, onConflict));
      }
      return await withIsolatedQuery(this.sql, (handle) => this.runSelect(handle));
    } catch (error) {
      return { data: null, error: toSupabaseError(error) };
    }
  }

  private async runInsert(handle: SQL, values: Record<string, unknown>): Promise<SupabaseQueryResult<T>> {
    const keys = Object.keys(values);
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
    const params = keys.map((key) => toSqlParam(values[key]));
    const text = `insert into public.${this.table} (${keys.join(",")}) values (${placeholders}) returning *`;
    const rows = await handle.unsafe(text, params);
    return { data: rows[0] as T, error: null };
  }

  private async runUpsert(
    handle: SQL,
    values: Record<string, unknown>,
    onConflict?: string,
  ): Promise<SupabaseQueryResult<T>> {
    const keys = Object.keys(values);
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
    const params = keys.map((key) => toSqlParam(values[key]));
    const conflictColumn = onConflict ?? "id";
    const updates = keys
      .filter((key) => key !== conflictColumn)
      .map((key) => `${key} = excluded.${key}`)
      .join(", ");
    const text = `insert into public.${this.table} (${keys.join(",")}) values (${placeholders})
      on conflict (${conflictColumn}) do update set ${updates}
      returning *`;
    const rows = await handle.unsafe(text, params);
    return { data: rows[0] as T, error: null };
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
    if (this.orderBy !== null) {
      text += ` order by ${this.orderBy.column} ${this.orderBy.ascending ? "asc" : "desc"}`;
    }
    if (this.limitCount !== null) {
      params.push(this.limitCount);
      text += ` limit $${params.length}`;
    }
    const rows = await handle.unsafe(text, params);
    return { data: rows as T, error: null };
  }
}

function isKnownTable(table: string): table is KnownTable {
  return (KNOWN_TABLES as readonly string[]).includes(table);
}
