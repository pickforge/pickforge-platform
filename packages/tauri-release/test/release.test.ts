import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectAssets,
  computeNightlyVersion,
  generateLatestJson,
  platformKeyForAssetName,
  platformKeysForAssetName,
  validateReleaseConfig,
  verifyLatestJson,
  type TauriReleaseConfig,
} from "../src/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("@pickforge/tauri-release", () => {
  it("validates app release config", () => {
    const config = validateReleaseConfig({
      schemaVersion: 1,
      repository: "pickforge/pickgauge",
      appName: "PickGauge",
      collect: {
        artifactRoot: "src-tauri/target/release/bundle",
        outputDir: "release-assets",
        patterns: ["*.AppImage", "*.AppImage.sig"],
        prefix: "linux-appimage",
      },
      stable: {
        latestJsonAsset: "latest.json",
      },
      nightly: {
        enabled: true,
        branch: "main",
        latestJsonAsset: "nightly.json",
      },
      updater: {
        requiredPlatforms: ["linux-x86_64"],
      },
    });

    expect(config.repository).toBe("pickforge/pickgauge");
    expect(config.nightly?.enabled).toBe(true);
  });

  it("computes deterministic nightly versions and tags", () => {
    expect(
      computeNightlyVersion({
        baseVersion: "1.2.3",
        date: "2026-07-05",
        sha: "ABCDEF1234567890",
      }),
    ).toEqual({
      version: "1.2.3-nightly.20260705.abcdef123456",
      tag: "nightly-2026-07-05-abcdef123456",
      date: "2026-07-05",
      shortSha: "abcdef123456",
    });
  });

  it("maps signed Tauri artifact names to updater platform keys", () => {
    expect(platformKeysForAssetName("linux-appimage-PickGauge_1.0.0_amd64.AppImage")).toEqual([
      "linux-x86_64",
      "linux-x86_64-appimage",
    ]);
    expect(platformKeyForAssetName("PickScribe_1.0.0_amd64.deb")).toBe("linux-x86_64-deb");
    expect(platformKeyForAssetName("windows-PickGauge_1.0.0_x64-setup.exe")).toBe(
      "windows-x86_64",
    );
    expect(platformKeyForAssetName("windows-PickGauge_1.0.0_x64_en-US.msi")).toBe(
      "windows-x86_64",
    );
    expect(platformKeyForAssetName("macos-intel-PickGauge.app.tar.gz")).toBe("darwin-x86_64");
    expect(platformKeyForAssetName("macos-apple-silicon-PickGauge.app.tar.gz")).toBe(
      "darwin-aarch64",
    );
  });

  it("collects configured build assets into a release directory", () => {
    const root = tempRoot();
    const bundle = join(root, "target/release/bundle/appimage");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "PickGauge_1.0.0_amd64.AppImage"), "appimage");
    writeFileSync(join(bundle, "PickGauge_1.0.0_amd64.AppImage.sig"), "sig");
    writeFileSync(join(bundle, "ignored.txt"), "ignored");

    const config = baseConfig({
      artifactRoot: "target/release/bundle",
      outputDir: "release-assets",
      patterns: ["*.AppImage", "*.AppImage.sig"],
      prefix: "linux-appimage",
    });

    const assets = collectAssets(config, { repoRoot: root });

    expect(assets.map((asset) => asset.name)).toEqual([
      "linux-appimage-PickGauge_1.0.0_amd64.AppImage",
      "linux-appimage-PickGauge_1.0.0_amd64.AppImage.sig",
    ]);
    expect(readFileSync(join(root, "release-assets", assets[0]?.name ?? ""), "utf8")).toBe(
      "appimage",
    );
  });

  it("generates and verifies latest.json for Linux, macOS, and Windows fixtures", () => {
    const root = tempRoot();
    writeSignedAsset(root, "linux-appimage-PickGauge_1.0.0_amd64.AppImage", "linux-signature");
    writeSignedAsset(root, "linux-deb-PickGauge_1.0.0_amd64.deb", "deb-signature");
    writeSignedAsset(root, "windows-PickGauge_1.0.0_x64-setup.exe", "exe-signature");
    writeSignedAsset(root, "windows-PickGauge_1.0.0_x64_en-US.msi", "msi-signature");
    writeSignedAsset(root, "macos-intel-PickGauge.app.tar.gz", "mac-intel-signature");
    writeSignedAsset(root, "macos-apple-silicon-PickGauge.app.tar.gz", "mac-arm-signature");

    const latest = generateLatestJson({
      assetsDir: root,
      downloadBaseUrl: "https://github.com/pickforge/pickgauge/releases/download/v1.0.0",
      pubDate: "2026-07-05T12:00:00Z",
      requiredPlatforms: ["linux-x86_64", "windows-x86_64", "darwin-x86_64", "darwin-aarch64"],
      version: "1.0.0",
    });

    expect(latest.platforms["linux-x86_64"]?.signature).toBe("linux-signature");
    expect(latest.platforms["linux-x86_64-appimage"]?.signature).toBe("linux-signature");
    expect(latest.platforms["linux-x86_64-deb"]?.signature).toBe("deb-signature");
    expect(latest.platforms["windows-x86_64"]?.signature).toBe("exe-signature");
    expect(latest.platforms["darwin-x86_64"]?.signature).toBe("mac-intel-signature");
    expect(latest.platforms["darwin-aarch64"]?.signature).toBe("mac-arm-signature");
    expect(verifyLatestJson(latest)).toEqual({
      ok: true,
      platforms: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-x86_64",
        "linux-x86_64-appimage",
        "linux-x86_64-deb",
        "windows-x86_64",
      ],
      errors: [],
    });
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pickforge-release-"));
  tempRoots.push(root);
  return root;
}

function writeSignedAsset(root: string, name: string, signature: string): void {
  writeFileSync(join(root, name), "bundle");
  writeFileSync(join(root, `${name}.sig`), signature);
}

function baseConfig(collect: TauriReleaseConfig["collect"]): TauriReleaseConfig {
  return {
    appName: "PickGauge",
    collect,
    repository: "pickforge/pickgauge",
    schemaVersion: 1,
    stable: {},
  };
}
