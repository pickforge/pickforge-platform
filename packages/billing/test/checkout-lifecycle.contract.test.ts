// Checkout lifecycle contract lane (issue #37, CAND-1).
//
// Exercises the production `processStripeEvent` / `getCreditBalanceCents`
// billing policy against the REAL durable `checkout_lifecycle_*` SQL RPCs in
// supabase/migrations/20260712193633_checkout_deletion_lifecycle.sql, running
// on a local Supabase Postgres, with only Stripe mocked. Locks, transitions,
// idempotency, attempt history, and cleanup ordering all stay behind the
// `SupabaseClientLike` interface — this file never reimplements lifecycle
// policy, it only asserts on outcomes.
//
// Prerequisite: a local Supabase Postgres via `supabase start` (requires
// Docker). When it is not reachable — e.g. the default CI `check` job, which
// runs `bun run test` without Postgres — every test below is skipped with a
// console message instead of failing the run. CI's `database` job starts
// Supabase and runs this lane for real via `bun run test:supabase`.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { SQL } from "bun";
import {
  getCreditBalanceCents,
  processStripeEvent,
  type StripeClientLike,
  type StripeEventLike,
  type StripeRefundLike,
  type SupabaseClientLike,
  type SupabaseQueryResult,
} from "../src/index.js";
import {
  connectToLocalDatabase,
  DEFAULT_DATABASE_URL,
  insertAuthUser,
  resolveLocalDatabaseUrl,
  uniqueId,
  withRollback,
  cleanupLifecycleFixtures,
} from "./lifecycle-fixtures.js";
import { createPostgresSupabaseClient } from "./postgres-lifecycle-client.js";

const sql = await connectToLocalDatabase();

if (sql === null) {
  console.log(
    "[billing contract lane] Skipping checkout-lifecycle Postgres contract tests: " +
      `no local Supabase Postgres reachable at ${resolveLocalDatabaseUrl() ?? process.env.SUPABASE_DB_URL ?? DEFAULT_DATABASE_URL}. ` +
      "Run `supabase start` (requires Docker) to exercise this lane locally; " +
      "CI's `database` job runs it automatically via `bun run test:supabase`.",
  );
}

describe.skipIf(sql === null)("@pickforge/billing checkout lifecycle contract (local Postgres)", () => {
  const db = sql as SQL;
  let welcomeCreditsCampaignWasEnabled = true;

  beforeAll(async () => {
    // The launch welcome-credit campaign grants an extra 100 cents to every
    // new auth user while under its cap. That is orthogonal to checkout
    // lifecycle policy, so disable it for this lane's duration rather than
    // coupling credit-balance assertions to however many users other test
    // runs have already created.
    const [campaign] = await db.unsafe(
      "select enabled from welcome_credits_private.campaigns where campaign_key = 'launch_welcome_first_50'",
    );
    welcomeCreditsCampaignWasEnabled = Boolean(campaign?.enabled);
    await db.unsafe(
      "update welcome_credits_private.campaigns set enabled = false where campaign_key = 'launch_welcome_first_50'",
    );
  });

  afterAll(async () => {
    await db.unsafe(
      "update welcome_credits_private.campaigns set enabled = $1 where campaign_key = 'launch_welcome_first_50'",
      [welcomeCreditsCampaignWasEnabled],
    );
    await db.close();
  });

  it("credits an unfenced completion once, upserts the Stripe customer, and treats replay as duplicate", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_credited");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      const stripe = fakeStripe();

      await expect(
        processStripeEvent({
          supabase: client,
          stripe,
          event: checkoutSessionEvent(userId, { sessionId }),
        }),
      ).resolves.toEqual({ handled: true, duplicate: false });

      const [customer] = await tx.unsafe(
        "select stripe_customer_id from public.billing_customers where user_id = $1",
        [userId],
      );
      expect(customer).toMatchObject({ stripe_customer_id: "cus_123" });

      await expect(getCreditBalanceCents({ supabase: client, userId })).resolves.toBe(1000);

      await expect(
        processStripeEvent({
          supabase: client,
          stripe,
          event: checkoutSessionEvent(userId, { sessionId, id: "evt_replay" }),
        }),
      ).resolves.toEqual({ handled: false, duplicate: true });

      await expect(getCreditBalanceCents({ supabase: client, userId })).resolves.toBe(1000);
    });
  });

  it("mints a paid session with a null customer without creating a billing_customers row", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });

      await expect(
        processStripeEvent({
          supabase: client,
          stripe: fakeStripe(),
          event: checkoutSessionEvent(userId, { customer: null }),
        }),
      ).resolves.toEqual({ handled: true, duplicate: false });

      const rows = await tx.unsafe(
        "select 1 from public.billing_customers where user_id = $1",
        [userId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("refunds a fenced user's completion without granting credit, and is idempotent on replay", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_fenced");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const stripe = fakeStripe();
      const event = checkoutSessionEvent(userId, { sessionId });

      await expect(processStripeEvent({ supabase: client, stripe, event })).resolves.toEqual({
        handled: true,
        duplicate: false,
        reconciliation: "deletion_race_refunded",
      });
      await expect(processStripeEvent({ supabase: client, stripe, event })).resolves.toEqual({
        handled: false,
        duplicate: true,
        reconciliation: "deletion_race_refunded",
      });

      expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
      expect(stripe.refunds.create).toHaveBeenCalledWith(
        { payment_intent: "pi_123", amount: 1000 },
        { idempotencyKey: `checkout-deletion:${sessionId}:attempt:1` },
      );
      const rows = await tx.unsafe(
        "select 1 from public.credit_ledger where stripe_checkout_session_id = $1",
        [sessionId],
      );
      expect(rows).toHaveLength(0);
      await expectSessionState(tx, sessionId, "refunded");
    });
  });

  it("refunds and cleans up a late customer after deletion finalizes before the completion event lands", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_after_finalize");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const finalized = await rpc(client, "checkout_lifecycle_finalize_deletion", {
        target_user: userId,
      });
      expect(finalized.data).toMatchObject({ status: "finalized" });
      const stripe = fakeStripe();

      await expect(
        processStripeEvent({
          supabase: client,
          stripe,
          event: checkoutSessionEvent(userId, { sessionId }),
        }),
      ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });

      expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
      expect(stripe.customers.del).toHaveBeenCalledWith("cus_123");
      await expectSessionState(tx, sessionId, "refunded");

      // Auth user still exists (deletion not yet atomically applied); the
      // race un-fenced deletion so a future retry can settle safely.
      const [fence] = await tx.unsafe(
        "select finalized_at is null as unfenced from checkout_lifecycle_private.deletion_fences where user_id = $1",
        [userId],
      );
      expect(fence).toMatchObject({ unfenced: true });
    });
  });

  it("immediately refunds a completion whose user is already deleted, retrying customer cleanup without a second refund", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_deleted");
      // The user never existed in this transaction: reconcile_completion's
      // `not exists (select 1 from auth.users ...)` branch fires directly.
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const stripe = fakeStripe();
      stripe.customers.del.mockRejectedValueOnce(new Error("Stripe unavailable"));
      const event = checkoutSessionEvent(userId, { sessionId });

      await expect(processStripeEvent({ supabase: client, stripe, event })).rejects.toThrow(
        "Stripe unavailable",
      );
      await expectSessionState(tx, sessionId, "refunded");

      // Replay carries a different (wrong) customer id; cleanup must still
      // target the durably recorded customer, not the replay event's field.
      const replay = checkoutSessionEvent(userId, {
        sessionId,
        id: "evt_cleanup_retry",
        customer: "cus_wrong",
      });
      await expect(
        processStripeEvent({ supabase: client, stripe, event: replay }),
      ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });

      expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
      expect(stripe.customers.del).toHaveBeenCalledTimes(2);
      expect(stripe.customers.del).toHaveBeenNthCalledWith(2, "cus_123");
      expect(stripe.customers.del).not.toHaveBeenCalledWith("cus_wrong");
      const [cleanup] = await tx.unsafe(
        "select customer_cleanup_pending from checkout_lifecycle_private.checkout_sessions where stripe_checkout_session_id = $1",
        [sessionId],
      );
      expect(cleanup).toMatchObject({ customer_cleanup_pending: false });
    });
  });

  it("keeps a fenced refund retryable when Stripe fails, and recovers with the same durable attempt", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_refund_retry");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const stripe = fakeStripe();
      stripe.refunds.create.mockRejectedValueOnce(new Error("Stripe unavailable"));
      const event = checkoutSessionEvent(userId, { sessionId });

      await expect(processStripeEvent({ supabase: client, stripe, event })).rejects.toThrow(
        "Stripe unavailable",
      );
      await expectSessionState(tx, sessionId, "refund_pending");

      await expect(
        processStripeEvent({ supabase: client, stripe, event }),
      ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });
      expect(stripe.refunds.create).toHaveBeenNthCalledWith(
        2,
        { payment_intent: "pi_123", amount: 1000 },
        { idempotencyKey: `checkout-deletion:${sessionId}:attempt:1` },
      );
      await expectSessionState(tx, sessionId, "refunded");
    });
  });

  it("recovers an attached Refund after a crash before retrieval", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_attached_recovery");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const stripe = fakeStripe();
      stripe.refunds.create.mockResolvedValue({ id: "re_attached", amount: 1000, status: "pending" });
      stripe.refunds.retrieve
        .mockResolvedValueOnce({ id: "re_attached", amount: 1000, status: "pending" })
        .mockResolvedValueOnce({ id: "re_attached", amount: 1000, status: "succeeded" });
      const event = checkoutSessionEvent(userId, { sessionId });

      await expect(processStripeEvent({ supabase: client, stripe, event })).rejects.toMatchObject({
        code: "refund_incomplete",
      });
      await expect(processStripeEvent({ supabase: client, stripe, event })).resolves.toMatchObject({
        reconciliation: "deletion_race_refunded",
      });

      expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
      expect(stripe.refunds.retrieve).toHaveBeenCalledTimes(2);
      await expectSessionState(tx, sessionId, "refunded");
    });
  });

  it("completes reconciliation once a replayed asynchronous refund event reports success", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_async_refund");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const stripe = fakeStripe();
      stripe.refunds.create.mockResolvedValue({ id: "re_pending", amount: 1000, status: "pending" });
      stripe.refunds.retrieve.mockResolvedValueOnce({ id: "re_pending", amount: 1000, status: "pending" });
      const event = checkoutSessionEvent(userId, { sessionId });

      await expect(processStripeEvent({ supabase: client, stripe, event })).rejects.toMatchObject({
        code: "refund_incomplete",
      });
      await expectSessionState(tx, sessionId, "refund_pending");

      await expect(
        processStripeEvent({
          supabase: client,
          stripe,
          event: refundEvent({ refundId: "re_pending", status: "succeeded", type: "refund.created" }),
        }),
      ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });
      await expectSessionState(tx, sessionId, "refunded");
    });
  });

  it("retries a signed terminal Refund with a new durable attempt key", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_signed_retry");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const stripe = fakeStripe();
      stripe.refunds.create
        .mockResolvedValueOnce({ id: "re_failed_attempt", amount: 1000, status: "pending" })
        .mockResolvedValueOnce({ id: "re_retry_succeeded", amount: 1000, status: "succeeded" });
      stripe.refunds.retrieve
        .mockResolvedValueOnce({ id: "re_failed_attempt", amount: 1000, status: "pending" })
        .mockResolvedValueOnce({ id: "re_retry_succeeded", amount: 1000, status: "succeeded" });

      await expect(
        processStripeEvent({ supabase: client, stripe, event: checkoutSessionEvent(userId, { sessionId }) }),
      ).rejects.toMatchObject({ code: "refund_incomplete" });

      await expect(
        processStripeEvent({
          supabase: client,
          stripe,
          event: refundEvent({ refundId: "re_failed_attempt", status: "failed", type: "refund.failed" }),
        }),
      ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });

      expect(stripe.refunds.create).toHaveBeenNthCalledWith(
        2,
        { payment_intent: "pi_123", amount: 1000 },
        { idempotencyKey: `checkout-deletion:${sessionId}:attempt:2` },
      );
      await expectSessionState(tx, sessionId, "refunded");
    });
  });

  it("refunds only the remaining amount after Stripe reports a pre-existing partial refund", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_partial_remaining");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const stripe = fakeStripe();
      stripe.refunds.list.mockResolvedValue({
        data: [{ id: "re_prior", amount: 400, status: "succeeded" }],
        has_more: false,
      });
      stripe.refunds.create.mockResolvedValue({ id: "re_remaining", amount: 600, status: "succeeded" });
      stripe.refunds.retrieve.mockResolvedValue({ id: "re_remaining", amount: 600, status: "succeeded" });

      await expect(
        processStripeEvent({
          supabase: client,
          stripe,
          event: checkoutSessionEvent(userId, { sessionId }),
        }),
      ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });

      expect(stripe.refunds.create).toHaveBeenCalledWith(
        { payment_intent: "pi_123", amount: 600 },
        { idempotencyKey: `checkout-deletion:${sessionId}:attempt:1` },
      );
      await expectSessionState(tx, sessionId, "refunded");
    });
  });

  it("does not refund a pre-lifecycle credited purchase retried after fencing", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_pre_lifecycle");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      // Simulates a purchase credited before the lifecycle registry ever saw
      // the Session (no checkout_lifecycle_private row exists for it yet).
      await tx.unsafe(
        `insert into public.credit_ledger (
          user_id, amount_cents, kind, stripe_event_id, stripe_checkout_session_id, idempotency_key
        ) values ($1, 1000, 'purchase', 'evt_pre_lifecycle', $2, $3)`,
        [userId, sessionId, `stripe:${sessionId}`],
      );
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const stripe = fakeStripe();

      await expect(
        processStripeEvent({
          supabase: client,
          stripe,
          event: checkoutSessionEvent(userId, { id: "evt_pre_lifecycle_retry", sessionId }),
        }),
      ).resolves.toMatchObject({ handled: false, duplicate: true });

      expect(stripe.refunds.create).not.toHaveBeenCalled();
      const rows = await tx.unsafe(
        "select 1 from public.credit_ledger where stripe_checkout_session_id = $1",
        [sessionId],
      );
      expect(rows).toHaveLength(1);
      await expectSessionState(tx, sessionId, "completed");
    });
  });

  it("dedupes checkout.session.completed and async_payment_succeeded events for the same session", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_dedupe");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });

      await processStripeEvent({
        supabase: client,
        stripe: fakeStripe(),
        event: checkoutSessionEvent(userId, { sessionId }),
      });
      await expect(
        processStripeEvent({
          supabase: client,
          stripe: fakeStripe(),
          event: checkoutSessionEvent(userId, {
            sessionId,
            id: "evt_async",
            type: "checkout.session.async_payment_succeeded",
          }),
        }),
      ).resolves.toEqual({ handled: false, duplicate: true });

      const rows = await tx.unsafe(
        "select 1 from public.credit_ledger where stripe_checkout_session_id = $1",
        [sessionId],
      );
      expect(rows).toHaveLength(1);
    });
  });

  it("terminalizes checkout.session.async_payment_failed without granting credit, and a later completion stays non-credit", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_async_failed");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      await rpc(client, "checkout_lifecycle_register_session", {
        target_user: userId,
        checkout_session_id: sessionId,
      });
      const event = checkoutSessionEvent(userId, {
        id: "evt_async_failed",
        sessionId,
        type: "checkout.session.async_payment_failed",
      });

      await expect(
        processStripeEvent({ supabase: client, stripe: fakeStripe(), event }),
      ).resolves.toEqual({ handled: true, duplicate: false });
      await expect(
        processStripeEvent({ supabase: client, stripe: fakeStripe(), event }),
      ).resolves.toEqual({ handled: false, duplicate: true });
      await expect(
        processStripeEvent({
          supabase: client,
          stripe: fakeStripe(),
          event: checkoutSessionEvent(userId, {
            id: "evt_paid_after_async_failure",
            sessionId,
            type: "checkout.session.completed",
          }),
        }),
      ).resolves.toEqual({ handled: false, duplicate: true });

      await expectSessionState(tx, sessionId, "payment_failed");
      const rows = await tx.unsafe(
        "select 1 from public.credit_ledger where stripe_checkout_session_id = $1",
        [sessionId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("ignores a Refund event for an untracked refund id without mutating lifecycle", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);

      await expect(
        processStripeEvent({
          supabase: client,
          stripe: fakeStripe(),
          event: refundEvent({ refundId: "re_unknown" }),
        }),
      ).resolves.toEqual({ handled: false, duplicate: false });
    });
  });

  it.each(["failed", "canceled"] as const)(
    "durably records a terminal refund status %s without releasing the deletion fence",
    async (status) => {
      await withRollback(db, async (tx) => {
        const client = createPostgresSupabaseClient(tx);
        const userId = crypto.randomUUID();
        const sessionId = uniqueId(`cs_${status}`);
        await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
        await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
        const stripe = fakeStripe();
        stripe.refunds.create.mockResolvedValue({ id: "re_terminal", amount: 1000, status });
        stripe.refunds.retrieve.mockResolvedValue({ id: "re_terminal", amount: 1000, status });

        await expect(
          processStripeEvent({
            supabase: client,
            stripe,
            event: checkoutSessionEvent(userId, { sessionId }),
          }),
        ).rejects.toMatchObject({ code: "refund_terminal_failure" });

        await expectSessionState(tx, sessionId, "refund_pending");
        const rows = await tx.unsafe(
          "select 1 from public.credit_ledger where stripe_checkout_session_id = $1",
          [sessionId],
        );
        expect(rows).toHaveLength(0);
      });
    },
  );

  it("accepts charge_already_refunded only after verifying a full succeeded refund", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_already_refunded");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const stripe = fakeStripe();
      stripe.refunds.create.mockRejectedValue({ code: "charge_already_refunded" });
      stripe.refunds.list.mockResolvedValue({
        data: [{ id: "re_existing", amount: 1000, status: "succeeded" }],
        has_more: false,
      });

      await expect(
        processStripeEvent({
          supabase: client,
          stripe,
          event: checkoutSessionEvent(userId, { sessionId }),
        }),
      ).resolves.toMatchObject({ reconciliation: "deletion_race_refunded" });

      expect(stripe.refunds.retrieve).not.toHaveBeenCalled();
      await expectSessionState(tx, sessionId, "refunded");
    });
  });

  it("does not accept charge_already_refunded when only a partial refund succeeded", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_partially_refunded");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });
      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const stripe = fakeStripe();
      stripe.refunds.create.mockRejectedValue({ code: "charge_already_refunded" });
      stripe.refunds.list.mockResolvedValue({
        data: [{ id: "re_partial", amount: 500, status: "succeeded" }],
        has_more: false,
      });

      await expect(
        processStripeEvent({
          supabase: client,
          stripe,
          event: checkoutSessionEvent(userId, { sessionId }),
        }),
      ).rejects.toMatchObject({ code: "charge_already_refunded" });

      await expectSessionState(tx, sessionId, "refund_pending");
    });
  });

  it("blocks deletion finalization while a Checkout Session is still open, then allows it once settled", async () => {
    await withRollback(db, async (tx) => {
      const client = createPostgresSupabaseClient(tx);
      const userId = crypto.randomUUID();
      const sessionId = uniqueId("cs_open_blocks_finalize");
      await insertAuthUser(tx, { id: userId, email: `${uniqueId("contract")}@example.invalid` });

      const registered = await rpc(client, "checkout_lifecycle_register_session", {
        target_user: userId,
        checkout_session_id: sessionId,
      });
      expect(registered.data).toBe(false);

      await rpc(client, "checkout_lifecycle_fence_deletion", { target_user: userId });
      const blocked = await rpc(client, "checkout_lifecycle_finalize_deletion", {
        target_user: userId,
      });
      expect(blocked.data).toMatchObject({ status: "unsafe" });

      await rpc(client, "checkout_lifecycle_mark_expired", { checkout_session_id: sessionId });
      const finalized = await rpc(client, "checkout_lifecycle_finalize_deletion", {
        target_user: userId,
      });
      expect(finalized.data).toMatchObject({ status: "finalized" });

      const deleted = await rpc(client, "checkout_lifecycle_delete_auth_user", {
        target_user: userId,
      });
      expect(deleted.data).toBe("deleted");

      const [user] = await tx.unsafe("select 1 as found from auth.users where id = $1", [userId]);
      expect(user).toBeUndefined();
    });
  });

  it("resolves a concurrent completion and deletion fence to exactly one consistent durable outcome", async () => {
    const userId = crypto.randomUUID();
    const sessionId = uniqueId("cs_concurrent_race");
    await insertAuthUser(db, { id: userId, email: `${uniqueId("contract")}@example.invalid` });

    try {
      const stripe = fakeStripe();
      const event = checkoutSessionEvent(userId, { sessionId });

      const [completionOutcome] = await Promise.all([
        db.begin(async (tx) => {
          const client = createPostgresSupabaseClient(tx);
          return processStripeEvent({ supabase: client, stripe, event });
        }),
        db.begin(async (tx) => {
          await tx.unsafe(
            "select public.checkout_lifecycle_fence_deletion(target_user => $1)",
            [userId],
          );
        }),
      ]);

      const ledgerRows = await db.unsafe(
        "select amount_cents from public.credit_ledger where stripe_checkout_session_id = $1",
        [sessionId],
      );
      const [session] = await db.unsafe(
        "select state from checkout_lifecycle_private.checkout_sessions where stripe_checkout_session_id = $1",
        [sessionId],
      );

      // The advisory lock in both the completion reconciliation and the fence
      // RPC serializes the race: whichever transaction commits first durably
      // decides the outcome, and the two effects are mutually exclusive.
      if (completionOutcome.handled && !completionOutcome.duplicate && completionOutcome.reconciliation === undefined) {
        expect(ledgerRows).toHaveLength(1);
        expect(session).toMatchObject({ state: "completed" });
      } else {
        expect(completionOutcome).toMatchObject({ reconciliation: "deletion_race_refunded" });
        expect(ledgerRows).toHaveLength(0);
        // The mock Stripe refund succeeds synchronously, so the fenced branch
        // resolves all the way to "refunded" within this single call, exactly
        // like the equivalent non-concurrent fenced-completion test.
        expect(session).toMatchObject({ state: "refunded" });
        expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
      }
    } finally {
      await cleanupLifecycleFixtures(db, { userIds: [userId], sessionIds: [sessionId] });
    }
  });
});

function checkoutSessionEvent(
  userId: string,
  overrides: Partial<{
    amountTotal: unknown;
    customer: unknown;
    id: string;
    paymentIntent: unknown;
    paymentStatus: string;
    sessionId: string;
    type: string;
  }> = {},
): StripeEventLike {
  const session: Record<string, unknown> = {
    id: overrides.sessionId ?? "cs_123",
    amount_total: "amountTotal" in overrides ? overrides.amountTotal : 1000,
    customer: "customer" in overrides ? overrides.customer : "cus_123",
    client_reference_id: userId,
    payment_status: overrides.paymentStatus ?? "paid",
    payment_intent: "paymentIntent" in overrides ? overrides.paymentIntent : "pi_123",
  };

  return {
    id: overrides.id ?? "evt_checkout",
    type: overrides.type ?? "checkout.session.completed",
    data: { object: session },
  };
}

function refundEvent(overrides: {
  refundId?: string;
  status?: string;
  amount?: number;
  paymentIntent?: unknown;
  type?: string;
} = {}): StripeEventLike {
  return {
    id: `evt_${overrides.refundId ?? "refund"}`,
    type: overrides.type ?? "refund.updated",
    data: {
      object: {
        id: overrides.refundId ?? "re_123",
        amount: overrides.amount ?? 1000,
        status: overrides.status ?? "succeeded",
        payment_intent: "paymentIntent" in overrides ? overrides.paymentIntent : "pi_123",
      },
    },
  };
}

function fakeStripe(options: { event?: StripeEventLike } = {}) {
  return {
    checkout: {
      sessions: {
        create: mock(async (params, _options: { idempotencyKey: string }) => ({
          id: "cs_created",
          ...params,
        })),
      },
    },
    customers: {
      del: mock(async () => ({})),
    },
    refunds: {
      create: mock(async () => ({ id: "re_123", amount: 1000, status: "succeeded" })),
      retrieve: mock(async (refundId: string) => ({ id: refundId, amount: 1000, status: "succeeded" })),
      list: mock(async () => ({ data: [] as StripeRefundLike[], has_more: false })),
    },
    webhooks: {
      constructEventAsync: mock(async () => options.event ?? checkoutSessionEvent(crypto.randomUUID())),
    },
  } satisfies StripeClientLike;
}

// Mirrors the cast every production RPC call site applies to the
// intentionally loose `SupabaseClientLike.rpc()` signature.
function rpc<T = unknown>(
  client: SupabaseClientLike,
  fn: string,
  args?: Record<string, unknown>,
): Promise<SupabaseQueryResult<T>> {
  return client.rpc(fn, args) as Promise<SupabaseQueryResult<T>>;
}

async function expectSessionState(tx: SQL, sessionId: string, state: string): Promise<void> {
  const [session] = await tx.unsafe(
    "select state from checkout_lifecycle_private.checkout_sessions where stripe_checkout_session_id = $1",
    [sessionId],
  );
  expect(session).toMatchObject({ state });
}
