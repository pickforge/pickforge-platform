# pickforge-platform

Shared `@pickforge/*` TypeScript packages (auth, billing, brand, flags, sync, edge-shared, tauri-release, tauri-updater, review-tutor, complexity-gate) plus the platform Supabase migrations and Edge Functions. No app UI lives here.

```
bun install
bun run check        # typecheck, lint, test, coverage, build; the same gate as CI
bun run test         # vitest only, no database
supabase db start && PICKFORGE_ALLOW_LOCAL_DB_TESTS=1 bun run test:supabase
supabase db advisors --local --type security --fail-on warn
```

`*.contract.test.ts` files are excluded from plain vitest on purpose. They only run in the database suite, against Postgres.

Worth knowing:

- Tests go in the same PR as the behavior change. Coverage thresholds in `vitest.config.ts` don't get lowered without asking me.
- Packages publish to npm on a `v*` tag and every version has to bump together or the publish fails. Release steps for the apps are in `RELEASING.md`.
- In `packages/tauri-updater`, stateful DOM nodes (the dialog, live regions) must survive a re-render. Rebuilding `innerHTML` on a state tick replays `showModal` and breaks assistive-tech announcements.
- Skills shipped inside packages must not combine a pre-approved `allowed-tools: Bash(...)` rule with a command argument the model supplies. Permission matching doesn't split on `$(...)`, so that pair is a shell-injection path. Keep the skill human-invocable or drop the pre-approval.
