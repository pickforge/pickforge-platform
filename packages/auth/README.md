# @pickforge/auth

UI-free Supabase Auth wrapper for Pickforge apps.

```ts
import { createPickforgeAuthClient } from "@pickforge/auth";

const auth = createPickforgeAuthClient({
  supabaseUrl,
  supabaseAnonKey,
  redirectUri: "pickforge://auth/callback",
  storage,
  openExternalUrl,
});

await auth.startOAuth("github");
```

The package handles PKCE OAuth redirects and reads entitlements from Supabase.
App UI, billing, teams, and offline product behavior stay in app repos.
