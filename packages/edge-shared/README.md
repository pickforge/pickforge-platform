# @pickforge/edge-shared

Deno-compatible helpers for Pickforge Edge Functions. Clients are injected structurally, so app functions can use Supabase service clients without coupling this package to a specific SDK import.

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
} from "npm:@pickforge/edge-shared@0.4.0";

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

- Apply the platform Supabase migrations, including `20260709030000_debit_credits.sql`.
- Use `SUPABASE_SERVICE_ROLE_KEY` only in server-side Edge Functions.
- Deploy app Edge Functions with access to `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Cross-repo imports

Supabase `_shared/` relative imports only work inside one functions tree. Pickforge app-specific Edge Functions live in other repos, so shared Edge utilities ship as `@pickforge/edge-shared` and are imported with `npm:` specifiers from each repo.
