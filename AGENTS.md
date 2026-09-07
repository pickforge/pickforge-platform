Shared `@pickforge/*` packages and platform Supabase migrations and Edge Functions belong here. No app UI.

Plain vitest excludes `*.contract.test.ts` deliberately. Database contracts run through `bun run test:supabase` against local Postgres, with `PICKFORGE_ALLOW_LOCAL_DB_TESTS=1`. Do not point them at production. Coverage thresholds in `vitest.config.ts` cannot be lowered without asking.

Package versions are independent. The publish workflow skips versions already on npm; bump changed packages and affected internal dependency ranges. App release guidance is in `RELEASING.md`.

In `packages/tauri-updater`, stateful DOM nodes such as the dialog and live regions must survive re-renders. Replacing `innerHTML` on a state tick replays `showModal` and breaks assistive-tech announcements.

Shipped skills must not combine a pre-approved `allowed-tools: Bash(...)` rule with a model-supplied command argument. Permission matching does not split on `$(...)`; that combination permits shell injection. Keep the skill human-invocable or remove the pre-approval.
