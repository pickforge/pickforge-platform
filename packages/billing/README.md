# @pickforge/billing

UI-free Stripe billing and credit-ledger helpers for Pickforge apps.

```ts
import { createCreditCheckoutSession } from "@pickforge/billing";

const session = await createCreditCheckoutSession({
  stripe,
  userId,
  priceId,
  successUrl,
  cancelUrl,
});
```

```ts
import { processStripeEvent, verifyStripeEvent } from "@pickforge/billing";

const event = await verifyStripeEvent({
  payload,
  signature,
  secret: stripeWebhookSecret,
  stripe,
});

const result = await processStripeEvent({
  supabase: serviceRoleSupabase,
  stripe,
  event,
});
```

Prerequisites: apply the billing and checkout lifecycle migrations first, use a service-role Supabase client for `processStripeEvent`, and call `verifyStripeEvent` before `processStripeEvent`; processing trusts the verified event input.

The credit ledger is the source of truth for balance; balances are sums of ledger rows.
General refunds remain manual v1 operator adjustments. The lifecycle invariant separately issues an idempotent full refund when a Checkout Session completes after account deletion has been fenced or its user is already missing, and never grants credits in either path.
Pending or action-required Refunds keep deletion fenced and retryable. Terminal `failed`/`canceled` Refunds remain `refund_pending` with the Refund id and status in the private registry. The service-only manual resolution path is: verify or complete the full PaymentIntent refund in Stripe, then invoke `checkout_lifecycle_mark_refunded(checkout_session_id, event_id)` with the service role; never expose that RPC to clients.
`checkout.session.async_payment_failed` terminalizes the registered Session as non-credit `payment_failed`. Missing-user refund success keeps late-customer cleanup durable until the webhook deletes the Stripe Customer (or confirms it missing) and clears `customer_cleanup_pending`.
The package is UI-free and secret-free: Stripe is injected, and service-role Supabase clients stay server-side.
App UI, offline behavior, and purchase presentation stay in app repos.
