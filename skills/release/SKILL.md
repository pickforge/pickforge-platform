---
name: release
description: Release a Pickforge Tauri app (pickforge, pickscribe, pickgauge, picklab) — version bump PR, tag, watch CI, verify assets and latest.json, recover from known failures. Use when asked to release, tag, or ship a new app version.
---

# Release a Pickforge app

CI does the building and signing (`release.yml` on a `v*` tag). This skill drives
and verifies it — never build release artifacts locally.

All apps release through `@pickforge/tauri-release` (config: `<app>.release.json`
at the repo root). The GitHub release stays **draft**; a human polishes notes and
publishes. That gate is not yours to skip.

## 1. Prep PR

- Draft notes from `docs/releases/UNRELEASED.md`.
- Bump the version everywhere it lives: `package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml` **and** `Cargo.lock` (run `cargo check` to refresh it).
- Stage per file or with `git add -u` — a batched `git add a b c` aborts entirely if
  one path is wrong, and release PRs have silently missed the cargo bumps this way.
- Feature flags (rule: workspace `AGENTS.md`, "Feature flags"):
  - Check `gh issue list --label flagged` for features this release enables.
    Flipping a flag on = changing its `default` in this prep PR; list flipped
    flags in the draft notes and tick "enabled in vX.Y.Z" on their issues.
  - Any flag that shipped enabled in a previous release and still exists is
    stale — file or do the removal (don't block the release on it).
- Open the PR (`chore: release vX.Y.Z`) through the normal ship-pr flow.

## 2. Tag

Main only moves via squash-merged PRs, so after the prep PR merges:

```bash
git checkout main && git fetch && git pull --ff-only   # stale local main gets tagged silently
git tag vX.Y.Z && git push origin vX.Y.Z
```

Verify `git log -1` is the merged release PR before pushing the tag.

## 3. Watch

```bash
gh run list --workflow=release.yml --limit 1
gh run watch <run-id>
```

Known transient: linuxdeploy download can 429 → `gh run rerun <run-id> --failed`.
A cancelled run may already have created the draft and uploaded assets — that's
fine, the good run reuses the draft, but check step 4 carefully afterwards.

## 4. Verify the draft release

```bash
gh release view vX.Y.Z --json assets --jq '.assets[].name'
```

- Every asset the app's `<app>.release.json` expects is present — the
  `collect.patterns` list and `updater.requiredPlatforms` are authoritative,
  not a fixed matrix (some apps ship fewer platforms).
- No assets carrying an older version in the filename (leftovers from a
  cancelled run). Delete any: `gh release delete-asset vX.Y.Z <name>`.
- `latest.json` platform URLs all point at vX.Y.Z. The generator excludes
  stale-versioned assets, but verify anyway — the updater feed is the one thing
  a bad release breaks for every existing user.

If `latest.json` needs repair, regenerate locally and re-upload:

```bash
rm -rf release-assets   # stale local assets leak into the regenerated feed
gh release download vX.Y.Z --dir release-assets --pattern '*'
bun run pickforge-tauri-release generate-latest-json \
  --config <app>.release.json \
  --assets-dir release-assets --version X.Y.Z \
  --download-base-url "https://github.com/pickforge/<app>/releases/download/vX.Y.Z" \
  --out latest.json
bun run pickforge-tauri-release verify-latest-json --input latest.json
gh release upload vX.Y.Z latest.json --clobber
```

(`--config` matters: the CLI defaults to `pickforge.release.json`, which is the
wrong app everywhere but pickforge.)

## 5. Hand off

Report the draft-release URL and the verification results. The human publishes.
After publish: reset `docs/releases/UNRELEASED.md` (the GitHub release
description is the notes' source of truth).

## Gotchas

- Bundle paths differ: pickforge/pickscribe are Cargo workspaces
  (`target/release/bundle`); pickgauge is not (`src-tauri/target/release/bundle`).
  `collect.artifactRoot` in `<app>.release.json` is authoritative.
- Platform packages (this repo) publish with `npm publish --workspaces` on tag —
  every package version must bump in lockstep or publish fails.
- Signing runs in CI from `TAURI_SIGNING_PRIVATE_KEY`; local updater keys live in
  `~/.pickforge-keys` (never move or print them).
