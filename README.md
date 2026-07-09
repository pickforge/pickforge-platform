# Pickforge Platform

Shared platform packages for Pickforge desktop apps.

## Packages

- `@pickforge/tauri-release`: signed Tauri release and updater-feed helpers.
- `@pickforge/brand`: CSS tokens, fonts, reset, and framework-neutral primitives.
- `@pickforge/auth`: UI-free Supabase Auth wrapper and entitlement reader.

Desktop apps keep updating from signed Tauri artifacts and signed `latest.json`
feeds. Stable releases stay tag-driven; nightly builds use a separate opt-in
feed.

## Workspace skills

`skills/` holds agent runbooks shared across the workspace (`release`, `ci`).
Run `scripts/link-workspace-skills.sh` once per machine to symlink them into
the workspace root and every sibling repo — skill discovery does not traverse
parent directories, so each repo needs its own link.

## Commands

```bash
bun install
bun run build
bun run test
bun run typecheck
```

Each package is public under the `@pickforge` npm scope.
