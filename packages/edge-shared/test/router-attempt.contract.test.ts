// Operator-router durable claim contract lane (issue #37, CAND-4).
//
// Exercises the production `claimRouteAttempt` / `completeRouteAttempt` /
// `failRouteAttempt` / `findDebitedRouteResult` / `debitCredits` functions,
// and the full `createOperatorRouterHandler` composition built from them,
// against the REAL durable `router_attempt_claim` / `router_attempt_complete`
// / `router_attempt_fail` SQL functions in
// supabase/migrations/20260722000000_router_attempt_claim.sql, running on a
// local Supabase Postgres. The claim/complete/fail decision lives entirely
// behind the `SupabaseClientLike` boundary — this file never reimplements
// that policy, it only asserts on outcomes, including genuine concurrent
// races between independently committing Postgres transactions.
//
// Prerequisite: a local Supabase Postgres via `supabase start` (requires
// Docker). When it is not reachable, every test below is skipped with a
// console message instead of failing the run. CI's `database` job starts
// Supabase and runs this lane for real via `bun run test:supabase`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import {
  claimRouteAttempt,
  completeRouteAttempt,
  createOperatorRouterHandler,
  debitCredits,
  failRouteAttempt,
  findDebitedRouteResult,
} from "../src/index.js";
import { createPostgresRouterClient } from "./postgres-router-client.js";
import {
  cleanupRouterFixtures,
  connectToLocalDatabase,
  DEFAULT_DATABASE_URL,
  grantCredits,
  insertAuthUser,
  resolveLocalDatabaseUrl,
  uniqueId,
  withRollback,
} from "./router-fixtures.js";

const sql = await connectToLocalDatabase();

if (sql === null) {
  console.log(
    "[edge-shared contract lane] Skipping router-attempt Postgres contract tests: " +
      `no local Supabase Postgres reachable at ${resolveLocalDatabaseUrl() ?? process.env.SUPABASE_DB_URL ?? DEFAULT_DATABASE_URL}. ` +
      "Run `supabase start` (requires Docker) to exercise this lane locally; " +
      "CI's `database` job runs it automatically via `bun run test:supabase`.",
  );
}

describe.skipIf(sql === null)("@pickforge/edge-shared router attempt claim contract (local Postgres)", () => {
  const db = sql as SQL;
  let welcomeCreditsCampaignWasEnabled = true;

  beforeAll(async () => {
    // The launch welcome-credit campaign grants an extra 100 cents to every
    // new auth user while under its cap. That is orthogonal to router claim
    // policy, so disable it for this lane's duration rather than coupling
    // credit-balance assertions to however many users other test runs have
    // already created.
    const [campaign] = await db.unsafe(
      "select enabled from welcome_credits_private.campaigns where campaign_key = 'launch_welcome_first_50'",
    );
    welcomeCreditsCampaignWasEnabled = Boolean(campaign?.enabled);
    await db.unsafe(
      "update welcome_credits_private.campaigns set enabled = false where campaign_key = 'launch_welcome_first_50'",
    );
  });

  afterAll(async () => {
    await db.unsafe("update welcome_credits_private.campaigns set enabled = $1 where campaign_key = 'launch_welcome_first_50'", [
      welcomeCreditsCampaignWasEnabled,
    ]);
    await db.close();
  });

  async function createUser(tx: SQL, label: string): Promise<string> {
    const userId = crypto.randomUUID();
    await insertAuthUser(tx, { id: userId, email: `${uniqueId(label)}@example.invalid` });
    return userId;
  }

  it("durably claims an absent key, and a live claim is reported in_progress, never re-claimed", async () => {
    await withRollback(db, async (tx) => {
      const userId = await createUser(tx, "claim-live");
      const client = createPostgresRouterClient(tx);
      const key = uniqueId("router:attempt");

      await expect(claimRouteAttempt({ supabase: client, userId, idempotencyKey: key })).resolves.toEqual({
        outcome: "claimed",
      });
      await expect(claimRouteAttempt({ supabase: client, userId, idempotencyKey: key })).resolves.toEqual({
        outcome: "in_progress",
      });
    });
  });

  it("records a provider outcome, and a later claim returns it instead of reclaiming", async () => {
    await withRollback(db, async (tx) => {
      const userId = await createUser(tx, "claim-complete");
      const client = createPostgresRouterClient(tx);
      const key = uniqueId("router:attempt");
      const result = { proposalJson: "{\"action\":\"openProject\"}", usage: { input: 42, output: 13 } };

      await claimRouteAttempt({ supabase: client, userId, idempotencyKey: key });
      await expect(
        completeRouteAttempt({ supabase: client, userId, idempotencyKey: key, result }),
      ).resolves.toEqual(result);

      // A later caller (e.g. the original caller's own retry after a debit
      // failure) sees the completed outcome and can skip straight to a debit
      // retry, instead of re-invoking the provider.
      await expect(claimRouteAttempt({ supabase: client, userId, idempotencyKey: key })).resolves.toEqual({
        outcome: "completed",
        result,
      });
    });
  });

  it("releases a claim on a definitive provider failure so a retry can reclaim immediately", async () => {
    await withRollback(db, async (tx) => {
      const userId = await createUser(tx, "claim-fail");
      const client = createPostgresRouterClient(tx);
      const key = uniqueId("router:attempt");

      await claimRouteAttempt({ supabase: client, userId, idempotencyKey: key });
      await failRouteAttempt({ supabase: client, userId, idempotencyKey: key });

      await expect(claimRouteAttempt({ supabase: client, userId, idempotencyKey: key })).resolves.toEqual({
        outcome: "claimed",
      });
    });
  });

  it("recovers a stale (lease-expired) claim without waiting out a fresh lease", async () => {
    await withRollback(db, async (tx) => {
      const userId = await createUser(tx, "claim-stale");
      const client = createPostgresRouterClient(tx);
      const key = uniqueId("router:attempt");

      await claimRouteAttempt({ supabase: client, userId, idempotencyKey: key, leaseSeconds: 30 });
      await tx.unsafe(
        `update public.router_attempts set claimed_at = now() - interval '1 hour'
         where user_id = $1 and idempotency_key = $2`,
        [userId, key],
      );

      await expect(
        claimRouteAttempt({ supabase: client, userId, idempotencyKey: key, leaseSeconds: 30 }),
      ).resolves.toEqual({ outcome: "claimed" });
    });
  });

  it("couples debit to the completed route, and honors it as a legacy ledger replay", async () => {
    await withRollback(db, async (tx) => {
      const userId = await createUser(tx, "claim-debit");
      await grantCredits(tx, userId, 100);
      const client = createPostgresRouterClient(tx);
      const key = uniqueId("router:attempt");
      const result = { proposalJson: "{\"action\":\"openProject\"}", usage: { input: 8, output: 5 } };

      await claimRouteAttempt({ supabase: client, userId, idempotencyKey: key });
      await completeRouteAttempt({ supabase: client, userId, idempotencyKey: key, result });

      await expect(findDebitedRouteResult({ supabase: client, userId, idempotencyKey: key })).resolves.toBeNull();

      await expect(
        debitCredits({
          supabase: client,
          userId,
          amountCents: 2,
          reason: "Operator routing",
          idempotencyKey: key,
          metadata: { proposalJson: result.proposalJson, usage: result.usage },
        }),
      ).resolves.toEqual({ duplicate: false, balance: 98 });

      // The debited ledger row is the money-path source of truth for "has
      // this key already been charged" — findDebitedRouteResult reads it
      // back the same way it would honor a row written before the durable
      // claim table existed.
      await expect(findDebitedRouteResult({ supabase: client, userId, idempotencyKey: key })).resolves.toEqual(
        result,
      );
    });
  });

  it("honors a pre-existing (legacy) debited ledger row with no router_attempts claim at all", async () => {
    await withRollback(db, async (tx) => {
      const userId = await createUser(tx, "legacy-ledger");
      const client = createPostgresRouterClient(tx);
      const key = uniqueId("router:attempt");
      await tx.unsafe(
        `insert into public.credit_ledger (user_id, amount_cents, kind, description, idempotency_key, metadata)
         values ($1, -2, 'usage', 'Operator routing', $2, $3::jsonb)`,
        [
          userId,
          key,
          JSON.stringify({ proposalJson: "{\"legacy\":true}", usage: { input: 1, output: 1 } }),
        ],
      );

      await expect(findDebitedRouteResult({ supabase: client, userId, idempotencyKey: key })).resolves.toEqual({
        proposalJson: "{\"legacy\":true}",
        usage: { input: 1, output: 1 },
      });
    });
  });

  it("resolves two genuinely concurrent claims for the same key to exactly one claim and one in_progress", async () => {
    const userId = crypto.randomUUID();
    await insertAuthUser(db, { id: userId, email: `${uniqueId("concurrent-claim")}@example.invalid` });

    try {
      const key = uniqueId("router:attempt");
      const [first, second] = await Promise.all([
        db.begin(async (tx) => claimRouteAttempt({ supabase: createPostgresRouterClient(tx), userId, idempotencyKey: key })),
        db.begin(async (tx) => claimRouteAttempt({ supabase: createPostgresRouterClient(tx), userId, idempotencyKey: key })),
      ]);

      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(["claimed", "in_progress"]);

      const rows = await db.unsafe(
        "select status from public.router_attempts where user_id = $1 and idempotency_key = $2",
        [userId, key],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "claimed" });
    } finally {
      await cleanupRouterFixtures(db, { userIds: [userId] });
    }
  });

  it("invokes the provider and debits exactly once across two genuinely concurrent same-key requests", async () => {
    const userId = crypto.randomUUID();
    await insertAuthUser(db, { id: userId, email: `${uniqueId("concurrent-handler")}@example.invalid` });
    await grantCredits(db, userId, 100);

    try {
      const serviceSupabase = createPostgresRouterClient(db);
      let providerCallCount = 0;
      const handler = createOperatorRouterHandler({
        supabase: {
          auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
        },
        serviceSupabase,
        getCreditBalance: async () => 100,
        consumeRateLimit: async () => true,
        chatComplete: async () => {
          providerCallCount += 1;
          // Give both concurrent requests a chance to reach the provider
          // step before either resolves, so a real race is exercised even
          // though only one of them should ever get here.
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { text: "{\"action\":{\"action\":\"openProject\"}}", usage: { input: 4, output: 6 } };
        },
        model: "gpt-5.4-mini",
        apiKey: "key",
        baseUrl: "https://api.openai.com/v1",
        creditCostCents: 2,
      });

      const request = () =>
        new Request("https://edge.test", {
          method: "POST",
          headers: { Authorization: "Bearer token", "x-idempotency-key": "concurrent-attempt" },
          body: JSON.stringify({ commandText: "open project Billing" }),
        });

      const [first, second] = await Promise.all([handler(request()), handler(request())]);
      const statuses = [first.status, second.status].sort();
      // The winner gets 200; the loser sees the live claim and is told to
      // retry (409), never a second provider call or a second debit.
      expect(statuses).toEqual([200, 409]);
      expect(providerCallCount).toBe(1);

      const ledgerRows = await db.unsafe(
        "select amount_cents from public.credit_ledger where user_id = $1 and kind = 'usage'",
        [userId],
      );
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({ amount_cents: -2 });
    } finally {
      await cleanupRouterFixtures(db, { userIds: [userId] });
    }
  });
});
