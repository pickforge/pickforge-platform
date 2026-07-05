# @pickforge/tauri-release

CLI and library helpers for signed Tauri releases.

```bash
pickforge-tauri-release validate-config --config pickforge.release.json
pickforge-tauri-release compute-nightly-version --base-version 1.2.3 --sha "$GITHUB_SHA"
pickforge-tauri-release collect-assets --config pickforge.release.json --prefix linux-appimage
pickforge-tauri-release generate-latest-json --version 1.2.3 --download-base-url "$DOWNLOAD_BASE" --out latest.json
pickforge-tauri-release verify-latest-json --input latest.json
```

Stable releases remain semver tag-driven. Nightly releases should publish to a
separate opt-in feed such as `nightly.json`.
