# Releasing a Pickforge app

CI builds and signs on a `v*` tag (`release.yml`). Never build release artifacts locally. Every app releases through `@pickforge/tauri-release` with `<app>.release.json` at the repo root. The GitHub release stays a draft until a human publishes it.

## 1. Prep PR

- Draft notes from `docs/releases/UNRELEASED.md`.
- Bump the version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `Cargo.lock` (run `cargo check` to refresh it). Stage per file; a batched `git add a b c` aborts on one bad path and release PRs have missed the cargo bumps that way.
- Check `gh issue list --label flagged`. Flipping a flag on means changing its `default` in this PR. List flipped flags in the notes and tick "enabled in vX.Y.Z" on their issues.
- Open the PR as `chore: release vX.Y.Z`.

## 2. Tag

```bash
git checkout main && git fetch && git pull --ff-only
git log -1        # must be the merged release PR
git tag vX.Y.Z && git push origin vX.Y.Z
```

## 3. Watch

```bash
gh run list --workflow=release.yml --limit 1
gh run watch <run-id>
```

linuxdeploy downloads can 429: `gh run rerun <run-id> --failed`. A cancelled run may already have created the draft and uploaded assets. That's fine, the good run reuses it, but check step 4 carefully.

## 4. Verify the draft

```bash
gh release view vX.Y.Z --json assets --jq '.assets[].name'
```

- Every asset in `collect.patterns` and `updater.requiredPlatforms` of `<app>.release.json` is present.
- No assets with an older version in the name. Delete leftovers: `gh release delete-asset vX.Y.Z <name>`.
- `latest.json` URLs all point at vX.Y.Z. This feed is the one thing a bad release breaks for every existing user.

To repair `latest.json`:

```bash
rm -rf release-assets
gh release download vX.Y.Z --dir release-assets --pattern '*'
bun run pickforge-tauri-release generate-latest-json \
  --config <app>.release.json --assets-dir release-assets --version X.Y.Z \
  --download-base-url "https://github.com/pickforge/<app>/releases/download/vX.Y.Z" \
  --out latest.json
bun run pickforge-tauri-release verify-latest-json --input latest.json
gh release upload vX.Y.Z latest.json --clobber
```

`--config` matters: the CLI defaults to `pickforge.release.json`.

## 5. Hand off

Report the draft URL and what you verified. After publish, reset `docs/releases/UNRELEASED.md`.

## Gotchas

- Bundle paths differ: pickforge and pickscribe are Cargo workspaces (`target/release/bundle`); pickgauge is not (`src-tauri/target/release/bundle`). `collect.artifactRoot` is authoritative.
- Platform packages publish with `npm publish --workspaces` on tag. Every package version must bump together or publish fails.
- Signing runs in CI from `TAURI_SIGNING_PRIVATE_KEY`. Local updater keys live in `~/.pickforge-keys`. Never move or print them.
- CI is the proof, local runs are preflight. Transient failure twice in a row is not transient. Read the log.
