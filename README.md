# Pickforge Platform

Shared platform packages for Pickforge desktop apps.

## Packages

- `@pickforge/tauri-release`: signed Tauri release and updater-feed helpers.
- `@pickforge/brand`: CSS tokens, fonts, reset, and framework-neutral primitives.
- `@pickforge/auth`: UI-free Supabase Auth wrapper and entitlement reader.
- `@pickforge/complexity-gate`: cross-harness function complexity checks and stop gates.

Desktop apps keep updating from signed Tauri artifacts and signed `latest.json`
feeds. Stable releases stay tag-driven; nightly builds use a separate opt-in
feed.

## Releasing

Release steps and gotchas for every Tauri app live in [`RELEASING.md`](RELEASING.md).

## CI conventions

Apply to every workspace repo; new repos adopt them on day one.

- `bun-version` is pinned in all workflows, never `latest`. Current pin: 1.3.12.
  To bump: `grep -rn bun-version ~/Projects/Pickforge/*/.github/workflows/*.yml`,
  update every hit in the same wave (one PR per repo), and update this line.
- `Swatinem/rust-cache@v2` goes in every Rust workflow, **including release**
  (uncached release builds ran 12–35 min; cached 5–8). Repos where the Cargo
  manifest lives under `src-tauri/` (not a workspace) need
  `with: workspaces: src-tauri`.
- Tagged releases follow the shared `@pickforge/tauri-release` pipeline; the runbook is [`RELEASING.md`](RELEASING.md).

## Commands

```bash
bun install
bun run build
bun run test
bun run typecheck
```

Each package is public under the `@pickforge` npm scope.
