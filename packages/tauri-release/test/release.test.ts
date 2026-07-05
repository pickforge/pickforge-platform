import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    expect(platformKeysForAssetName("PickGauge_1.0.0_amd64.AppImage.tar.gz")).toEqual([
      "linux-x86_64",
      "linux-x86_64-appimage",
    ]);
    expect(platformKeysForAssetName("PickScribe_1.0.0_amd64.deb")).toEqual([
      "linux-x86_64-deb",
    ]);
    expect(platformKeysForAssetName("PickScribe_1.0.0_x86_64.rpm")).toEqual([
      "linux-x86_64-rpm",
    ]);
    expect(platformKeysForAssetName("windows-PickGauge_1.0.0_x64-setup.exe")).toEqual([
      "windows-x86_64",
      "windows-x86_64-nsis",
    ]);
    expect(platformKeysForAssetName("windows-PickGauge_1.0.0_x64-setup.exe.zip")).toEqual([
      "windows-x86_64",
      "windows-x86_64-nsis",
    ]);
    expect(platformKeysForAssetName("windows-PickGauge_1.0.0_x64-setup.nsis.zip")).toEqual([
      "windows-x86_64",
      "windows-x86_64-nsis",
    ]);
    expect(platformKeysForAssetName("windows-PickGauge_1.0.0_x64_en-US.msi")).toEqual([
      "windows-x86_64",
      "windows-x86_64-msi",
    ]);
    expect(platformKeysForAssetName("windows-PickGauge_1.0.0_x64_en-US.msi.zip")).toEqual([
      "windows-x86_64",
      "windows-x86_64-msi",
    ]);
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

  it("rejects duplicate collected basenames", () => {
    const root = tempRoot();
    writeFileSyncRecursive(join(root, "target/release/bundle/macos-intel/PickGauge.app.tar.gz"), "intel");
    writeFileSyncRecursive(
      join(root, "target/release/bundle/macos-apple-silicon/PickGauge.app.tar.gz"),
      "arm",
    );
    const config = baseConfig({
      artifactRoot: "target/release/bundle",
      outputDir: "release-assets",
      patterns: ["*.app.tar.gz"],
    });

    expect(() => collectAssets(config, { repoRoot: root })).toThrow(/duplicate collected asset/u);
  });

  it("generates and verifies latest.json for Linux, macOS, and Windows fixtures", () => {
    const root = tempRoot();
    writeSignedAsset(root, "linux-appimage-PickGauge_1.0.0_amd64.AppImage", "linux-signature");
    writeSignedAsset(root, "linux-deb-PickGauge_1.0.0_amd64.deb", "deb-signature");
    writeSignedAsset(root, "linux-rpm-PickGauge_1.0.0_x86_64.rpm", "rpm-signature");
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
    expect(latest.platforms["linux-x86_64-rpm"]?.signature).toBe("rpm-signature");
    expect(latest.platforms["windows-x86_64"]?.signature).toBe("exe-signature");
    expect(latest.platforms["windows-x86_64-nsis"]?.signature).toBe("exe-signature");
    expect(latest.platforms["windows-x86_64-msi"]?.signature).toBe("msi-signature");
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
        "linux-x86_64-rpm",
        "windows-x86_64",
        "windows-x86_64-msi",
        "windows-x86_64-nsis",
      ],
      errors: [],
    });
  });

  it("uses AppImage bundles as default Linux updater targets and keeps debs package-specific", () => {
    const debRoot = tempRoot();
    writeSignedAsset(debRoot, "PickScribe_1.0.0_amd64.deb", "deb-signature");

    const debLatest = generateLatestJson({
      assetsDir: debRoot,
      downloadBaseUrl: "https://github.com/pickforge/pickscribe/releases/download/v1.0.0",
      pubDate: "2026-07-05T12:00:00Z",
      version: "1.0.0",
    });

    expect(debLatest.platforms["linux-x86_64"]).toBeUndefined();
    expect(debLatest.platforms["linux-x86_64-deb"]?.signature).toBe("deb-signature");

    const appImageRoot = tempRoot();
    writeSignedAsset(appImageRoot, "PickGauge_1.0.0_amd64.AppImage.tar.gz", "appimage-signature");

    const appImageLatest = generateLatestJson({
      assetsDir: appImageRoot,
      downloadBaseUrl: "https://github.com/pickforge/pickgauge/releases/download/v1.0.0",
      pubDate: "2026-07-05T12:00:00Z",
      version: "1.0.0",
    });

    expect(appImageLatest.platforms["linux-x86_64"]?.signature).toBe("appimage-signature");
    expect(appImageLatest.platforms["linux-x86_64-appimage"]?.signature).toBe(
      "appimage-signature",
    );
  });

  it("emits package-specific Linux and Windows updater targets", () => {
    const root = tempRoot();
    writeSignedAsset(root, "PickForge_1.0.0_x86_64.rpm", "rpm-signature");
    writeSignedAsset(root, "PickForge_1.0.0_x64-setup.nsis.zip", "nsis-signature");
    writeSignedAsset(root, "PickForge_1.0.0_x64_en-US.msi.zip", "msi-signature");

    const latest = generateLatestJson({
      assetsDir: root,
      downloadBaseUrl: "https://github.com/pickforge/pickforge/releases/download/v1.0.0",
      pubDate: "2026-07-05T12:00:00Z",
      version: "1.0.0",
    });

    expect(latest.platforms["linux-x86_64"]).toBeUndefined();
    expect(latest.platforms["linux-x86_64-rpm"]?.signature).toBe("rpm-signature");
    expect(latest.platforms["windows-x86_64"]?.signature).toBe("nsis-signature");
    expect(latest.platforms["windows-x86_64-nsis"]?.signature).toBe("nsis-signature");
    expect(latest.platforms["windows-x86_64-msi"]?.signature).toBe("msi-signature");
  });

  it("rejects unsupported Linux updater architectures instead of mislabeling them", () => {
    const root = tempRoot();
    writeSignedAsset(root, "PickForge_1.0.0_arm64.AppImage", "arm-signature");

    expect(() =>
      generateLatestJson({
        assetsDir: root,
        downloadBaseUrl: "https://github.com/pickforge/pickforge/releases/download/v1.0.0",
        pubDate: "2026-07-05T12:00:00Z",
        version: "1.0.0",
      }),
    ).toThrow(/unsupported Linux updater architecture/u);
  });

  it("rejects unsupported Windows updater architectures instead of mislabeling them", () => {
    const root = tempRoot();
    writeSignedAsset(root, "PickForge_1.0.0_arm64-setup.exe", "arm-signature");

    expect(() =>
      generateLatestJson({
        assetsDir: root,
        downloadBaseUrl: "https://github.com/pickforge/pickforge/releases/download/v1.0.0",
        pubDate: "2026-07-05T12:00:00Z",
        version: "1.0.0",
      }),
    ).toThrow(/unsupported Windows updater architecture/u);
  });

  it("infers macOS updater platform keys from artifact paths", () => {
    const root = tempRoot();
    writeSignedAsset(root, "macos-apple-silicon/PickGauge.app.tar.gz", "mac-arm-signature");

    const latest = generateLatestJson({
      assetsDir: root,
      downloadBaseUrl: "https://github.com/pickforge/pickgauge/releases/download/v1.0.0",
      pubDate: "2026-07-05T12:00:00Z",
      version: "1.0.0",
    });

    expect(latest.platforms["darwin-aarch64"]?.signature).toBe("mac-arm-signature");
    expect(latest.platforms["darwin-aarch64"]?.url).toBe(
      "https://github.com/pickforge/pickgauge/releases/download/v1.0.0/macos-apple-silicon/PickGauge.app.tar.gz",
    );
  });

  it("rejects duplicate updater basenames before generating latest.json", () => {
    const root = tempRoot();
    writeSignedAsset(root, "macos-intel/PickGauge.app.tar.gz", "mac-intel-signature");
    writeSignedAsset(root, "macos-apple-silicon/PickGauge.app.tar.gz", "mac-arm-signature");

    expect(() =>
      generateLatestJson({
        assetsDir: root,
        downloadBaseUrl: "https://github.com/pickforge/pickgauge/releases/download/v1.0.0",
        pubDate: "2026-07-05T12:00:00Z",
        version: "1.0.0",
      }),
    ).toThrow(/duplicate updater asset name/u);
  });

  it("rejects orphan signatures before generating latest.json", () => {
    const root = tempRoot();
    writeFileSync(join(root, "PickGauge_1.0.0_amd64.AppImage.sig"), "signature");

    expect(() =>
      generateLatestJson({
        assetsDir: root,
        downloadBaseUrl: "https://github.com/pickforge/pickgauge/releases/download/v1.0.0",
        pubDate: "2026-07-05T12:00:00Z",
        version: "1.0.0",
      }),
    ).toThrow(/missing matching assets/u);
  });

  it("rejects malformed latest.json documents", () => {
    expect(verifyLatestJson("null")).toMatchObject({
      ok: false,
      errors: ["latest.json must be an object"],
    });
    expect(
      verifyLatestJson({
        pub_date: "2026-07-05",
        version: "next",
        platforms: {
          "windwos-x86_64": {
            signature: "signature",
            url: "https://example.com/app.exe",
          },
        },
      }),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "version must be SemVer",
        "pub_date must be an RFC3339 date-time string",
        "windwos-x86_64 is not a supported updater platform",
      ]),
    });
    expect(
      verifyLatestJson({
        pub_date: "2026-02-31T00:00:00Z",
        version: "1.2.3",
        platforms: {
          "linux-x86_64": {
            signature: "signature",
            url: "https://example.com/app.AppImage",
          },
        },
      }),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["pub_date must be an RFC3339 date-time string"]),
    });
    expect(() =>
      generateLatestJson({
        assetsDir: tempRoot(),
        downloadBaseUrl: "https://example.com",
        pubDate: "2026-02-31T00:00:00Z",
        version: "1.2.3",
      }),
    ).toThrow(/pubDate must be an RFC3339 date-time string/u);
    expect(() =>
      generateLatestJson({
        assetsDir: tempRoot(),
        downloadBaseUrl: "https://example.com",
        pubDate: "2026-07-05T12:00:00Z",
        version: "release-1.2.3",
      }),
    ).toThrow(/version must be SemVer/u);
    expect(
      verifyLatestJson({
        version: "v1.2.3",
        platforms: {
          "linux-x86_64": {
            signature: "signature",
            url: "https://example.com/app.AppImage",
          },
        },
      }),
    ).toMatchObject({
      ok: true,
    });
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pickforge-release-"));
  tempRoots.push(root);
  return root;
}

function writeSignedAsset(root: string, name: string, signature: string): void {
  writeFileSyncRecursive(join(root, name), "bundle");
  writeFileSyncRecursive(join(root, `${name}.sig`), signature);
}

function writeFileSyncRecursive(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
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
