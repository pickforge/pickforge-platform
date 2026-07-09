# Supabase

Canonical platform migrations live in `migrations/`.

`functions/` contains Edge Functions deployed to the shared platform Supabase project. App-specific Edge Functions live in app repos and import shared helpers with `npm:` specifiers.

Deploy shared functions to the shared platform project. `stripe-webhook` has `verify_jwt = false` in `config.toml` because Stripe does not send Supabase JWTs; the equivalent deploy override is `supabase functions deploy stripe-webhook --no-verify-jwt`.

Run migrations with the target Supabase project before integrating apps.
