# Supabase

Canonical platform migrations live in `migrations/`.

`functions/` contains Edge Functions deployed to the shared platform Supabase project. App-specific Edge Functions live in app repos and import shared helpers with `npm:` specifiers.

Deploy shared functions to the shared platform project. `stripe-webhook` has `verify_jwt = false` in `config.toml` because Stripe does not send Supabase JWTs; the equivalent deploy override is `supabase functions deploy stripe-webhook --no-verify-jwt`.

Run migrations with the target Supabase project before integrating apps.

Run the local database suite with:

```sh
supabase db start
PICKFORGE_ALLOW_LOCAL_DB_TESTS=1 bun run test:supabase
supabase db advisors --local --type security --fail-on warn
```

## Launch welcome credit

The first 50 non-anonymous accounts created after the welcome-credit migration receive $1 in credits. The lifetime counter does not decrease when an account is deleted.

Disable the campaign before the limit with an operator SQL session:

```sql
update welcome_credits_private.campaigns
set enabled = false
where campaign_key = 'launch_welcome_first_50';
```

Check its status with:

```sql
select enabled, issued_count
from welcome_credits_private.campaigns
where campaign_key = 'launch_welcome_first_50';
```
