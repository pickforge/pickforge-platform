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
  event,
});
```

Prerequisites: apply the billing migration first, use a service-role Supabase client for `processStripeEvent`, and call `verifyStripeEvent` before `processStripeEvent`; processing trusts the verified event input.

The credit ledger is the source of truth for balance; balances are sums of ledger rows.
Refunds are manual v1 operator adjustments through service-role `adjustment` ledger rows.
The package is UI-free and secret-free: Stripe is injected, and service-role Supabase clients stay server-side.
App UI, offline behavior, and purchase presentation stay in app repos.
