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
Pending or action-required Refunds keep deletion fenced and retryable until a signed `refund.created`/`refund.updated` event reports success. Signed events are matched to the durably stored Refund id; processing inspects the PaymentIntent’s aggregate Refund history, blocks while another Refund is nonterminal, and automatically continues any succeeded shortfall by refunding exactly the remaining amount with a persisted attempt-specific idempotency key. Attached Refunds are recoverable after crashes, unknown Refunds are ignored, and lifecycle becomes terminal only after cumulative succeeded Refunds cover the full Checkout amount.
`checkout.session.async_payment_failed` terminalizes the registered Session as non-credit `payment_failed`. Missing-user refund success keeps late-customer cleanup durable until the webhook deletes the Stripe Customer (or confirms it missing) and clears `customer_cleanup_pending`; replayed or concurrent cleanup is idempotent.
The package is UI-free and secret-free: Stripe is injected, and service-role Supabase clients stay server-side.
App UI, offline behavior, and purchase presentation stay in app repos.
