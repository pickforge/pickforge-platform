---
name: ci
description: Drive and watch GitHub CI for Pickforge repos — trigger workflows, watch runs and PR checks, rerun transient failures, run CI-equivalent checks locally before pushing. Use when waiting on CI, debugging a red check, or asked to "run CI".
---

# Drive CI, don't replace it

CI is the trust anchor: clean runners, cross-platform builds, signing secrets,
phone-visible checks. Local runs are a preflight, never the proof.

## Watch

```bash
gh pr checks <n> --watch          # PR gate
gh run list --workflow=<wf> --limit 5
gh run watch <run-id>
gh run view <run-id> --log-failed # read failures without downloading everything
```

Read state, then decide, then act — never chain a status check and a mutation
(`checks && merge`) in one command.

## Trigger

```bash
gh workflow run <workflow>.yml --ref <branch>
```

Common dispatches: `update-vrt-baselines.yml` in pickforge after an intentional
UI change (baselines are CI-canonical — never commit locally rendered PNGs);
`release.yml` runs on `v*` tags (use the `release` skill, not a bare dispatch).

## Rerun

Transient failures (429 downloads, runner hiccups): `gh run rerun <run-id> --failed`.
If the same step fails twice, it's not transient — read the log.

## Local preflight

Before pushing, run what the repo's `ci.yml` runs — the repo's `CLAUDE.md` and
`package.json` scripts are authoritative. Typical for the Tauri apps:
`bun run build`, `bun run test:unit`, `cargo check --workspace --locked`. Skip
what you can't run locally (VRT baselines, cross-platform legs) and say so
instead of faking it.
