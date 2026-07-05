# Pickforge Platform

Shared platform packages for Pickforge desktop apps.

## Packages

- `@pickforge/tauri-release`: signed Tauri release and updater-feed helpers.
- `@pickforge/brand`: CSS tokens, fonts, reset, and framework-neutral primitives.
- `@pickforge/auth`: UI-free Supabase Auth wrapper and entitlement reader.

Desktop apps keep updating from signed Tauri artifacts and signed `latest.json`
feeds. Stable releases stay tag-driven; nightly builds use a separate opt-in
feed.

## Commands

```bash
bun install
bun run build
bun run test
bun run typecheck
```

Each package is public under the `@pickforge` npm scope.
