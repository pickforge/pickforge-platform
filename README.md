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
Run `scripts/link-workspace-skills.sh` to symlink them into the workspace root
and every sibling repo (rerun after adding a repo or a skill) — skill discovery
does not traverse parent directories, so each repo needs its own link.

App-local skills (like each app's `run` skill) live canonically in that repo's
`.agents/skills/<name>/SKILL.md`, with `.claude/skills/<name>` committed as a
relative symlink (`../../.agents/skills/<name>`) so both Claude and other
agents discover the same file. If the repo ignores `.claude/`, carve the skill
out (see pickforge's `.gitignore`).

## CI conventions

Apply to every workspace repo; new repos adopt them on day one.

- `bun-version` is pinned in all workflows, never `latest` — current pin and
  bump procedure live in [`skills/ci/SKILL.md`](skills/ci/SKILL.md).
- `Swatinem/rust-cache@v2` goes in every Rust workflow, **including release**
  (uncached release builds ran 12–35 min; cached 5–8). Repos where the Cargo
  manifest lives under `src-tauri/` (not a workspace) need
  `with: workspaces: src-tauri`.
- Tagged releases follow the shared `@pickforge/tauri-release` pipeline; the
  runbook is the `release` skill.

## Commands

```bash
bun install
bun run build
bun run test
bun run typecheck
```

Each package is public under the `@pickforge` npm scope.
