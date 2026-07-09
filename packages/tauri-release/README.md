# @pickforge/tauri-release

CLI and library helpers for signed Tauri releases.

```bash
pickforge-tauri-release validate-config --config pickforge.release.json
pickforge-tauri-release compute-nightly-version --base-version 1.2.3 --sha "$GITHUB_SHA"
pickforge-tauri-release collect-assets --config pickforge.release.json --prefix linux-appimage
pickforge-tauri-release generate-latest-json --version 1.2.3 --download-base-url "$DOWNLOAD_BASE" --out latest.json
pickforge-tauri-release verify-latest-json --input latest.json
pickforge-tauri-release fix-appimage --appimage PickGauge_1.2.3_amd64.AppImage --latest-json latest.json
```

Stable releases remain semver tag-driven. Nightly releases should publish to a
separate opt-in feed such as `nightly.json`.

`generate-latest-json` ignores signed assets whose filename contains a stale
SemVer token when `--version` is provided, so old artifacts left in the release
directory cannot win platform selection. Unversioned assets such as macOS app
tarballs remain eligible, and the command reports skipped files on stderr as
`excludedStaleAssets` while keeping stdout as the latest.json document.

`fix-appimage` removes bundled `usr/lib/libwayland-*.so*` files from an AppImage,
rebuilds it with the original SquashFS compression, verifies the result, and
re-signs it when `TAURI_SIGNING_PRIVATE_KEY` is set. Pass `--sign-command` to
override the default `bun run tauri signer sign <appimage>` command, and
`--latest-json` to patch matching platform signatures after signing.
