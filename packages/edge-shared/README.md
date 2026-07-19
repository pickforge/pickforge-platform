# @pickforge/edge-shared

Deno-compatible helpers for Pickforge Edge Functions. Clients are injected structurally, so app functions can use Supabase service clients without coupling this package to a specific SDK import.

`assertRouteRequest` accepts only the hosted-router wire shape: `commandText` plus optional `context.projectName`, `context.chatNames`, and `context.widgetLabels`. Command text is user-authored and passed through unchanged; attached context is guarded against paths, host identifiers, tailnet IPs, and long serial-like tokens with `boundary_violation`.

`createOperatorRouterHandler` composes bearer-token authentication, request boundary validation, idempotent credit debiting, and an injected chat completion. A replayed idempotency key returns its stored proposal without another model call.

Hosted routing is limited to 10 uncached attempts per user in each 10-second window. Its responses are `200` with a proposal, `402` for insufficient credits, `429` for `rate_limited`, boundary/auth `4xx`, and `5xx` for server or provider failures.

## Usage

```ts
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  EdgeSharedError,
  debitCredits,
  getUserFromRequest,
  jsonResponse,
  newIdempotencyKey,
  requireEntitlement,
} from "npm:@pickforge/edge-shared@0.7.0";

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  try {
    const { userId } = await getUserFromRequest({ supabase, req });
    await requireEntitlement({ supabase, userId, key: "render" });

    const requestId = new URL(req.url).searchParams.get("request_id") ?? "";
    const debit = await debitCredits({
      supabase,
      userId,
      amountCents: 25,
      reason: "Render job",
      idempotencyKey: newIdempotencyKey("render", requestId),
    });

    if (debit.duplicate) {
      return jsonResponse(200, { duplicate: true });
    }

    const output = await runWork();
    return jsonResponse(200, { balance: debit.balance, output });
  } catch (error) {
    if (error instanceof EdgeSharedError) {
      return jsonResponse(error.code === "unauthorized" ? 401 : 403, { error: error.code });
    }

    return jsonResponse(500, { error: "internal_error" });
  }
});
```

## Prerequisites

- Apply the platform Supabase migrations, including `20260712193633_checkout_deletion_lifecycle.sql`.
- Use `SUPABASE_SERVICE_ROLE_KEY` only in server-side Edge Functions.
- Deploy app Edge Functions with access to `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Hosted function environment

`operator-router` uses `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `OPENAI_API_KEY`. Optional settings are `OPENAI_ROUTER_MODEL` (default `gpt-5.4-mini`), `OPENAI_BASE_URL` (default `https://api.openai.com/v1`), and `ROUTER_CREDIT_COST_CENTS` (default `2`). It sets `verify_jwt = false` because `getUserFromRequest` verifies the caller bearer token in the handler; the service-role client is used only for the debit RPC.

`create-credit-checkout` uses `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PACK_10`, `STRIPE_PRICE_PACK_25`, `STRIPE_PRICE_PACK_50`, `CHECKOUT_SUCCESS_URL`, and `CHECKOUT_CANCEL_URL`. Its accepted body is `{ "pack": "p10" | "p25" | "p50" }`.

`delete-account` also uses `STRIPE_SECRET_KEY`. It fences checkout first, expires the fully collected registered and customer-scoped open Sessions, then runs a bounded registry discovery fixpoint. After discovery stabilizes, a database finalizer takes the same per-user advisory lock as registration and reconciliation, rejects any unsafe row, and prevents later registrations from creating pending work. Stripe customers are deleted only after that locked finalization; failure to stabilize or finalize preserves both customers and auth with retryable `deletion_incomplete`.
Requesting deletion is terminal: once the fence exists, checkout stays disabled and the deletion endpoint is retry-only until every cleanup or refund finishes and auth deletion succeeds.
Registry state `open` means “registered and not yet reconciled or durably marked expired”; it does not assert that Stripe still reports the Session as open.

The lifecycle-aware helpers require a `0.9.0` package publish before deploying functions that import them. `isCheckoutDeletionFenced`, `registerCheckoutSession`, and `markCheckoutSessionExpired` wrap the `checkout_lifecycle_is_deletion_fenced`, `checkout_lifecycle_register_session`, and `checkout_lifecycle_mark_expired` RPCs used by `createRegisteredCheckoutSession`'s callbacks, so a Checkout Session creation adapter never re-implements that RPC contract.

## Cross-repo imports

Supabase `_shared/` relative imports only work inside one functions tree. Pickforge app-specific Edge Functions live in other repos, so shared Edge utilities ship as `@pickforge/edge-shared` and are imported with `npm:` specifiers from each repo.
