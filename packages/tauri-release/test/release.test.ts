import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import {
  collectAssets,
  computeNightlyVersion,
  fixAppImage,
  generateLatestJson,
  generateLatestJsonReport,
  platformKeyForAssetName,
  platformKeysForAssetName,
  ReleaseToolError,
  validateReleaseConfig,
  verifyLatestJson,
  type SquashfsCompression,
  type TauriReleaseConfig,
} from "../src/index.js";

const injectedWriteFailure = vi.hoisted(() => ({ path: null as string | null, remaining: 0 }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeFileSync(path: Parameters<typeof actual.writeFileSync>[0], ...args: unknown[]) {
      if (
        typeof path === "string" &&
        path === injectedWriteFailure.path &&
        injectedWriteFailure.remaining > 0
      ) {
        injectedWriteFailure.remaining -= 1;
        throw new Error(`injected write failure for ${path}`);
      }
      return Reflect.apply(actual.writeFileSync, actual, [path, ...args]);
    },
  };
});

const tempRoots: string[] = [];
const squashfsToolsAvailable = hasCommand("mksquashfs") && hasCommand("unsquashfs");
const zstdSquashfsAvailable = squashfsToolsAvailable && hasSquashfsCompressor("zstd");
const toolOutputMaxBuffer = 64 * 1024 * 1024;

afterEach(() => {
  injectedWriteFailure.path = null;
  injectedWriteFailure.remaining = 0;
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

  it("excludes stale versioned updater assets while keeping unversioned assets eligible", () => {
    const root = tempRoot();
    writeSignedAsset(root, "PickGauge_0.1.2_amd64.AppImage", "current-linux-signature");
    writeSignedAsset(root, "PickGauge_0.1.1_amd64.AppImage", "stale-linux-signature");
    writeSignedAsset(root, "macos-apple-silicon/PickGauge.app.tar.gz", "mac-arm-signature");

    const report = generateLatestJsonReport({
      assetsDir: root,
      downloadBaseUrl: "https://github.com/pickforge/pickgauge/releases/download/v0.1.2",
      pubDate: "2026-07-05T12:00:00Z",
      requiredPlatforms: ["linux-x86_64", "darwin-aarch64"],
      version: "0.1.2",
    });

    expect(report.latestJson.platforms["linux-x86_64"]?.signature).toBe(
      "current-linux-signature",
    );
    expect(report.latestJson.platforms["linux-x86_64-appimage"]?.signature).toBe(
      "current-linux-signature",
    );
    expect(report.latestJson.platforms["darwin-aarch64"]?.signature).toBe("mac-arm-signature");
    expect(report.excludedStaleAssets).toEqual([
      "PickGauge_0.1.1_amd64.AppImage",
      "PickGauge_0.1.1_amd64.AppImage.sig",
    ]);
  });

  it("excludes stale v-prefixed updater asset versions", () => {
    const root = tempRoot();
    writeSignedAsset(root, "App_v0.1.1_amd64.AppImage", "stale-linux-signature");
    writeSignedAsset(root, "App_0.1.2_amd64.AppImage", "current-linux-signature");

    const report = generateLatestJsonReport({
      assetsDir: root,
      downloadBaseUrl: "https://github.com/pickforge/app/releases/download/v0.1.2",
      pubDate: "2026-07-05T12:00:00Z",
      requiredPlatforms: ["linux-x86_64"],
      version: "0.1.2",
    });

    expect(report.latestJson.platforms["linux-x86_64"]?.signature).toBe(
      "current-linux-signature",
    );
    expect(report.excludedStaleAssets).toEqual([
      "App_v0.1.1_amd64.AppImage",
      "App_v0.1.1_amd64.AppImage.sig",
    ]);
  });

  it("keeps SemVer build metadata in version token comparisons", () => {
    const root = tempRoot();
    writeSignedAsset(root, "App_1.2.3-beta+build_amd64.AppImage", "current-linux-signature");
    writeSignedAsset(root, "App_1.2.3-beta+old_amd64.AppImage", "stale-linux-signature");

    const report = generateLatestJsonReport({
      assetsDir: root,
      downloadBaseUrl: "https://github.com/pickforge/app/releases/download/v1.2.3-beta+build",
      pubDate: "2026-07-05T12:00:00Z",
      requiredPlatforms: ["linux-x86_64"],
      version: "1.2.3-beta+build",
    });

    expect(report.latestJson.platforms["linux-x86_64"]?.signature).toBe(
      "current-linux-signature",
    );
    expect(report.excludedStaleAssets).toEqual([
      "App_1.2.3-beta+old_amd64.AppImage",
      "App_1.2.3-beta+old_amd64.AppImage.sig",
    ]);
  });

  it("reports required platform errors after stale updater assets are filtered", () => {
    const root = tempRoot();
    writeSignedAsset(root, "PickGauge_0.1.1_amd64.AppImage", "stale-linux-signature");

    expect(() =>
      generateLatestJsonReport({
        assetsDir: root,
        downloadBaseUrl: "https://github.com/pickforge/pickgauge/releases/download/v0.1.2",
        pubDate: "2026-07-05T12:00:00Z",
        requiredPlatforms: ["linux-x86_64"],
        version: "0.1.2",
      }),
    ).toThrow(/missing required updater platforms: linux-x86_64/u);
  });

  it("filters stale orphan signatures and accepts rpm release suffixes for the current version", () => {
    const root = tempRoot();
    writeSignedAsset(root, "PickGauge-0.1.2-1.x86_64.rpm", "rpm-signature");
    writeFileSync(join(root, "PickGauge_0.1.1_x64-setup.exe.sig"), "stale-orphan-signature");

    const report = generateLatestJsonReport({
      assetsDir: root,
      downloadBaseUrl: "https://github.com/pickforge/pickgauge/releases/download/v0.1.2",
      pubDate: "2026-07-05T12:00:00Z",
      requiredPlatforms: ["linux-x86_64-rpm"],
      version: "v0.1.2",
    });

    expect(report.latestJson.platforms["linux-x86_64-rpm"]?.signature).toBe("rpm-signature");
    expect(report.excludedStaleAssets).toEqual(["PickGauge_0.1.1_x64-setup.exe.sig"]);
  });

  it("excludes stale rpm release suffix assets that do not start with the current version", () => {
    const root = tempRoot();
    writeSignedAsset(root, "PickForge-0.1.8-1.x86_64.rpm", "stale-rpm-signature");
    writeSignedAsset(root, "PickForge-0.1.9-1.x86_64.rpm", "current-rpm-signature");

    const report = generateLatestJsonReport({
      assetsDir: root,
      downloadBaseUrl: "https://github.com/pickforge/pickforge/releases/download/v0.1.9",
      pubDate: "2026-07-05T12:00:00Z",
      requiredPlatforms: ["linux-x86_64-rpm"],
      version: "0.1.9",
    });

    expect(report.latestJson.platforms["linux-x86_64-rpm"]?.signature).toBe(
      "current-rpm-signature",
    );
    expect(report.excludedStaleAssets).toEqual([
      "PickForge-0.1.8-1.x86_64.rpm",
      "PickForge-0.1.8-1.x86_64.rpm.sig",
    ]);
  });

  it("does not apply rpm release suffix matching to AppImage assets", () => {
    const root = tempRoot();
    writeSignedAsset(root, "PickGauge_0.1.9_amd64.AppImage", "current-appimage-signature");
    writeSignedAsset(root, "PickGauge_0.1.9-1_amd64.AppImage", "stale-appimage-signature");

    const report = generateLatestJsonReport({
      assetsDir: root,
      downloadBaseUrl: "https://github.com/pickforge/pickgauge/releases/download/v0.1.9",
      pubDate: "2026-07-05T12:00:00Z",
      requiredPlatforms: ["linux-x86_64"],
      version: "0.1.9",
    });

    expect(report.latestJson.platforms["linux-x86_64"]?.signature).toBe(
      "current-appimage-signature",
    );
    expect(report.excludedStaleAssets).toEqual([
      "PickGauge_0.1.9-1_amd64.AppImage",
      "PickGauge_0.1.9-1_amd64.AppImage.sig",
    ]);
  });

  it("keeps generate-latest-json stdout as the manifest and reports stale assets on stderr", async () => {
    const root = tempRoot();
    const configPath = join(root, "pickforge.release.json");
    writeSignedAsset(root, "PickGauge_0.1.2_amd64.AppImage", "current-linux-signature");
    writeSignedAsset(root, "PickGauge_0.1.1_amd64.AppImage", "stale-linux-signature");
    writeFileSync(configPath, `${JSON.stringify(baseConfig({ artifactRoot: ".", outputDir: root, patterns: ["*"] }))}\n`);

    const result = await captureCli([
      "generate-latest-json",
      "--config",
      configPath,
      "--assets-dir",
      root,
      "--version",
      "0.1.2",
      "--download-base-url",
      "https://github.com/pickforge/pickgauge/releases/download/v0.1.2",
    ]);
    const stdout = JSON.parse(result.stdout) as { excludedStaleAssets?: string[]; platforms: Record<string, { signature: string }> };
    const stderr = JSON.parse(result.stderr) as { excludedStaleAssets: string[] };

    expect(result.code).toBe(0);
    expect(stdout.excludedStaleAssets).toBeUndefined();
    expect(stdout.platforms["linux-x86_64"]?.signature).toBe("current-linux-signature");
    expect(stderr.excludedStaleAssets).toEqual([
      "PickGauge_0.1.1_amd64.AppImage",
      "PickGauge_0.1.1_amd64.AppImage.sig",
    ]);
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
    expect(
      verifyLatestJson(
        JSON.stringify({
          version: "1.2.3",
          platforms: {
            "darwin-x86_64": {
              signature: "signature",
              url: "not-a-url",
            },
            "linux-x86_64": null,
            "windows-x86_64": {
              signature: "",
              url: "ftp://example.com/app.exe",
            },
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "darwin-x86_64.url must be a valid URL",
        "linux-x86_64 must be an object",
        "windows-x86_64.signature must be a non-empty string",
        "windows-x86_64.url must use http or https",
      ]),
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

  it.skipIf(!squashfsToolsAvailable)(
    "strips AppImage Wayland libraries, repacks, and keeps the runtime prefix intact",
    () => {
      const root = tempRoot();
      const { appimage, runtimePrefix } = createSyntheticAppImage(root, { mode: 0o744 });
      writeFileSync(`${appimage}.sig`, "stale-signature");

      const result = fixAppImage({
        appimage,
        env: envWithoutSigning(),
      });

      expect(result).toMatchObject({
        appimage,
        compression: "gzip",
        latestJsonPatched: false,
        platformsPatched: [],
        signed: false,
        strippedCount: 1,
      });
      expect(readFileSync(appimage).subarray(0, runtimePrefix.length)).toEqual(runtimePrefix);
      expect(listAppImage(appimage, runtimePrefix.length)).not.toContain("libwayland-client.so.0");
      expect(statSync(appimage).mode & 0o777).toBe(0o744);
      expect(existsSync(`${appimage}.sig`)).toBe(false);

      const second = fixAppImage({
        appimage,
        env: envWithoutSigning(),
      });

      expect(second.strippedCount).toBe(0);
      expect(readFileSync(appimage).subarray(0, runtimePrefix.length)).toEqual(runtimePrefix);
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "strips nested Debian multi-arch Wayland libraries",
    () => {
      const root = tempRoot();
      const appDir = join(root, "AppDir");
      mkdirSync(join(appDir, "usr/lib/x86_64-linux-gnu"), { recursive: true });
      mkdirSync(join(appDir, "usr/bin"), { recursive: true });
      writeFileSync(
        join(appDir, "usr/lib/x86_64-linux-gnu/libwayland-client.so.0"),
        "wayland",
      );
      writeFileSync(join(appDir, "usr/bin/app"), "#!/bin/sh\n");
      const { appimage, runtimePrefix } = packSyntheticAppImage(root, appDir);

      const result = fixAppImage({
        appimage,
        env: envWithoutSigning(),
      });

      expect(result.strippedCount).toBe(1);
      expect(listAppImage(appimage, runtimePrefix.length)).not.toContain("libwayland-client.so.0");
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "allows non-library resource paths containing libwayland names",
    () => {
      const root = tempRoot();
      const appDir = join(root, "AppDir");
      mkdirSync(join(appDir, "usr/share/doc"), { recursive: true });
      mkdirSync(join(appDir, "usr/bin"), { recursive: true });
      writeFileSync(join(appDir, "usr/share/doc/libwayland-client.so.0.txt"), "docs");
      writeFileSync(join(appDir, "usr/bin/app"), "#!/bin/sh\n");
      const { appimage, runtimePrefix } = packSyntheticAppImage(root, appDir);

      const result = fixAppImage({
        appimage,
        env: envWithoutSigning(),
      });

      expect(result.strippedCount).toBe(0);
      expect(listAppImage(appimage, runtimePrefix.length)).toContain(
        "usr/share/doc/libwayland-client.so.0.txt",
      );
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "does not follow a symlinked usr/lib while stripping AppImage libraries",
    () => {
      const root = tempRoot();
      const appDir = join(root, "AppDir");
      const hostLibDir = join(root, "host-lib");
      const hostLib = join(hostLibDir, "libwayland-client.so.0");
      mkdirSync(join(appDir, "usr/bin"), { recursive: true });
      mkdirSync(hostLibDir, { recursive: true });
      symlinkSync(hostLibDir, join(appDir, "usr/lib"), "dir");
      writeFileSync(hostLib, "host-wayland");
      writeFileSync(join(appDir, "usr/bin/app"), "#!/bin/sh\n");
      const { appimage } = packSyntheticAppImage(root, appDir);

      const result = fixAppImage({
        appimage,
        env: envWithoutSigning(),
      });

      expect(result.strippedCount).toBe(0);
      expect(readFileSync(hostLib, "utf8")).toBe("host-wayland");
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "uses the ELF-derived SquashFS offset before scanning for magic bytes",
    () => {
      const root = tempRoot();
      const runtimePrefix = elfRuntimePrefixWithDecoy(512);
      const { appimage } = createSyntheticAppImage(root, { runtimePrefix });

      const result = fixAppImage({
        appimage,
        env: envWithoutSigning(),
      });

      expect(result.strippedCount).toBe(1);
      expect(listAppImage(appimage, runtimePrefix.length)).not.toContain("libwayland-client.so.0");
    },
  );

  it.skipIf(!zstdSquashfsAvailable)("rebuilds zstd-compressed AppImages as zstd", () => {
    const root = tempRoot();
    const { appimage, runtimePrefix } = createSyntheticAppImage(root, { compression: "zstd" });

    const result = fixAppImage({
      appimage,
      env: envWithoutSigning(),
    });

    expect(result.compression).toBe("zstd");
    expect(listAppImage(appimage, runtimePrefix.length)).not.toContain("libwayland-client.so.0");
  });

  it.skipIf(!squashfsToolsAvailable)("rejects lzma-compressed SquashFS payloads", () => {
    const root = tempRoot();
    const appimage = join(root, "PickGauge_1.0.0_amd64.AppImage");
    const payload = Buffer.alloc(128);
    writeFakeSquashfsSuperblock(payload, 0, 2);
    writeFileSync(appimage, Buffer.concat([Buffer.from("runtime\n"), payload]));
    chmodSync(appimage, 0o755);

    expect(() =>
      fixAppImage({
        appimage,
        env: envWithoutSigning(),
      }),
    ).toThrow(/lzma compression is not supported/u);
  });

  it.skipIf(!squashfsToolsAvailable)(
    "patches latest.json platform signatures after signing a fixed AppImage",
    () => {
      const root = tempRoot();
      const { appimage } = createSyntheticAppImage(root);
      const signStub = join(root, "sign-stub.sh");
      const latestJson = join(root, "latest.json");
      writeFileSync(signStub, "#!/bin/sh\nprintf 'new-signature\\n' > \"$1.sig\"\n");
      chmodSync(signStub, 0o755);
      writeFileSync(
        latestJson,
        `${JSON.stringify(
          {
            platforms: {
              "linux-x86_64": {
                signature: "old-linux-signature",
                url: "https://github.com/pickforge/pickgauge/releases/download/v1.0.0/PickGauge_1.0.0_amd64.AppImage",
              },
              "linux-x86_64-appimage": {
                signature: "old-appimage-signature",
                url: "https://github.com/pickforge/pickgauge/releases/download/v1.0.0/PickGauge_1.0.0_amd64.AppImage",
              },
              "windows-x86_64": {
                signature: "windows-signature",
                url: "https://github.com/pickforge/pickgauge/releases/download/v1.0.0/PickGauge_1.0.0_x64-setup.exe",
              },
            },
            version: "1.0.0",
          },
          null,
          2,
        )}\n`,
      );

      const result = fixAppImage({
        appimage,
        env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: "test-key" },
        latestJson,
        signCommand: signStub,
      });
      const patched = JSON.parse(readFileSync(latestJson, "utf8")) as {
        platforms: Record<string, { signature: string }>;
      };

      expect(result.signed).toBe(true);
      expect(result.latestJsonPatched).toBe(true);
      expect(result.platformsPatched).toEqual(["linux-x86_64", "linux-x86_64-appimage"]);
      expect(patched.platforms["linux-x86_64"]?.signature).toBe("new-signature");
      expect(patched.platforms["linux-x86_64-appimage"]?.signature).toBe("new-signature");
      expect(patched.platforms["windows-x86_64"]?.signature).toBe("windows-signature");
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "signs when TAURI_SIGNING_PRIVATE_KEY_PATH is set",
    () => {
      const root = tempRoot();
      const { appimage } = createSyntheticAppImage(root);
      const signStub = join(root, "sign-stub.sh");
      writeFileSync(signStub, "#!/bin/sh\nprintf 'path-signature\\n' > \"$1.sig\"\n");
      chmodSync(signStub, 0o755);

      const result = fixAppImage({
        appimage,
        env: {
          ...envWithoutSigning(),
          TAURI_SIGNING_PRIVATE_KEY_PATH: join(root, "tauri.key"),
        },
        signCommand: signStub,
      });

      expect(result.signed).toBe(true);
      expect(readFileSync(`${appimage}.sig`, "utf8")).toBe("path-signature\n");
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "currently replaces the AppImage and removes its stale signature when signing fails",
    () => {
      const root = tempRoot();
      const { appimage } = createSyntheticAppImage(root);
      const signStub = join(root, "failing-sign-stub.sh");
      const latestJson = join(root, "latest.json");
      writeFileSync(signStub, "#!/bin/sh\nexit 7\n");
      writeFileSync(`${appimage}.sig`, "stale-signature");
      writeLatestJsonFixture(latestJson, "PickGauge_1.0.0_amd64.AppImage");
      chmodSync(signStub, 0o755);
      const artifactBefore = readFileSync(appimage);
      const feedBefore = readFileSync(latestJson);

      expect(() =>
        fixAppImage({
          appimage,
          env: { ...envWithoutSigning(), TAURI_SIGNING_PRIVATE_KEY: "test-key" },
          latestJson,
          signCommand: signStub,
        }),
      ).toThrow(/sign command failed with exit code 7/u);
      expect(readFileSync(appimage)).not.toEqual(artifactBefore);
      expect(existsSync(`${appimage}.sig`)).toBe(false);
      expect(readFileSync(latestJson)).toEqual(feedBefore);
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "currently leaves the release set unchanged when rebuilding fails",
    () => {
      const root = tempRoot();
      const { appimage } = createSyntheticAppImage(root);
      const latestJson = join(root, "latest.json");
      writeFileSync(`${appimage}.sig`, "stale-signature");
      writeLatestJsonFixture(latestJson, "PickGauge_1.0.0_amd64.AppImage");
      const artifactBefore = readFileSync(appimage);
      const signatureBefore = readFileSync(`${appimage}.sig`);
      const feedBefore = readFileSync(latestJson);

      expect(() =>
        fixAppImage({
          appimage,
          env: failingMksquashfsEnv(root),
          latestJson,
        }),
      ).toThrow(/mksquashfs failed with exit code 19/u);
      expect(readFileSync(appimage)).toEqual(artifactBefore);
      expect(readFileSync(`${appimage}.sig`)).toEqual(signatureBefore);
      expect(readFileSync(latestJson)).toEqual(feedBefore);
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "currently leaves earlier release entries changed when the feed write fails",
    () => {
      const root = tempRoot();
      const { appimage } = createSyntheticAppImage(root);
      const signStub = join(root, "sign-stub.sh");
      const latestJson = join(root, "latest.json");
      writeFileSync(signStub, "#!/bin/sh\nprintf 'new-signature\\n' > \"$1.sig\"\n");
      writeFileSync(`${appimage}.sig`, "stale-signature");
      writeLatestJsonFixture(latestJson, "PickGauge_1.0.0_amd64.AppImage");
      chmodSync(signStub, 0o755);
      const artifactBefore = readFileSync(appimage);
      const feedBefore = readFileSync(latestJson);
      failNextWrite(latestJson);

      expect(() =>
        fixAppImage({
          appimage,
          env: { ...envWithoutSigning(), TAURI_SIGNING_PRIVATE_KEY: "test-key" },
          latestJson,
          signCommand: signStub,
        }),
      ).toThrow(/injected write failure/u);
      expect(readFileSync(appimage)).not.toEqual(artifactBefore);
      expect(readFileSync(`${appimage}.sig`, "utf8")).toBe("new-signature\n");
      expect(readFileSync(latestJson)).toEqual(feedBefore);
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "currently stops before changing the signature or feed when the artifact write fails",
    () => {
      const root = tempRoot();
      const { appimage } = createSyntheticAppImage(root);
      const latestJson = join(root, "latest.json");
      writeFileSync(`${appimage}.sig`, "stale-signature");
      writeLatestJsonFixture(latestJson, "PickGauge_1.0.0_amd64.AppImage");
      const artifactBefore = readFileSync(appimage);
      const signatureBefore = readFileSync(`${appimage}.sig`);
      const feedBefore = readFileSync(latestJson);
      failNextWrite(appimage);

      expect(() =>
        fixAppImage({
          appimage,
          env: envWithoutSigning(),
        }),
      ).toThrow(/injected write failure/u);
      expect(readFileSync(appimage)).toEqual(artifactBefore);
      expect(readFileSync(`${appimage}.sig`)).toEqual(signatureBefore);
      expect(readFileSync(latestJson)).toEqual(feedBefore);
    },
  );

  it.skipIf(!squashfsToolsAvailable)("rejects empty signatures after signing", () => {
    const root = tempRoot();
    const { appimage } = createSyntheticAppImage(root);
    const signStub = join(root, "empty-sign-stub.sh");
    writeFileSync(signStub, "#!/bin/sh\n: > \"$1.sig\"\n");
    chmodSync(signStub, 0o755);

    expect(() =>
      fixAppImage({
        appimage,
        env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: "test-key" },
        signCommand: signStub,
      }),
    ).toThrow(/signature file PickGauge_1\.0\.0_amd64\.AppImage\.sig is empty/u);
  });

  it.skipIf(!squashfsToolsAvailable)("rejects AppImages without a SquashFS payload", () => {
    const root = tempRoot();
    const appimage = join(root, "broken.AppImage");
    writeFileSync(appimage, "not-a-squashfs-appimage");
    chmodSync(appimage, 0o755);

    expect(() =>
      fixAppImage({
        appimage,
        env: envWithoutSigning(),
      }),
    ).toThrow(/valid SquashFS payload/u);
  });

  it.skipIf(!squashfsToolsAvailable)(
    "requires signing before patching latest.json",
    () => {
      const root = tempRoot();
      const { appimage } = createSyntheticAppImage(root);
      const latestJson = join(root, "latest.json");
      writeLatestJsonFixture(latestJson, "PickGauge_1.0.0_amd64.AppImage");
      const before = readFileSync(appimage);

      expect(() =>
        fixAppImage({
          appimage,
          env: envWithoutSigning(),
          latestJson,
        }),
      ).toThrow(/--latest-json requires TAURI_SIGNING_PRIVATE_KEY/u);
      expect(readFileSync(appimage)).toEqual(before);
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "rejects malformed latest.json before modifying the AppImage",
    () => {
      const root = tempRoot();
      const { appimage } = createSyntheticAppImage(root);
      const latestJson = join(root, "latest.json");
      writeFileSync(latestJson, "not-json");
      const before = readFileSync(appimage);

      expect(() =>
        fixAppImage({
          appimage,
          env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: "test-key" },
          latestJson,
          signCommand: "unused-sign-command",
        }),
      ).toThrow(/invalid latest\.json/u);
      expect(readFileSync(appimage)).toEqual(before);
      expect(existsSync(`${appimage}.sig`)).toBe(false);
    },
  );

  it.skipIf(!squashfsToolsAvailable)(
    "fails when latest.json has no platform URL for the fixed AppImage",
    () => {
      const root = tempRoot();
      const { appimage } = createSyntheticAppImage(root);
      const signStub = join(root, "sign-stub.sh");
      const latestJson = join(root, "latest.json");
      writeFileSync(signStub, "#!/bin/sh\nprintf 'new-signature\\n' > \"$1.sig\"\n");
      chmodSync(signStub, 0o755);
      writeLatestJsonFixture(latestJson, "Other_1.0.0_amd64.AppImage");
      const before = readFileSync(appimage);

      expect(() =>
        fixAppImage({
          appimage,
          env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: "test-key" },
          latestJson,
          signCommand: signStub,
        }),
      ).toThrow(/latest\.json has no platform URL matching PickGauge_1\.0\.0_amd64\.AppImage/u);
      expect(readFileSync(appimage)).toEqual(before);
      expect(existsSync(`${appimage}.sig`)).toBe(false);
    },
  );

  it("throws a release tool error when required SquashFS tools are missing", () => {
    const root = tempRoot();
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin);

    expect(() =>
      fixAppImage({
        appimage: join(root, "missing.AppImage"),
        env: { PATH: emptyBin },
      }),
    ).toThrow(ReleaseToolError);
    expect(() =>
      fixAppImage({
        appimage: join(root, "missing.AppImage"),
        env: { PATH: emptyBin },
      }),
    ).toThrow(/missing required tool: unsquashfs/u);
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

function hasCommand(command: string): boolean {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).error === undefined;
}

function hasSquashfsCompressor(compressor: string): boolean {
  const result = spawnSync("mksquashfs", ["-help-section", "compression"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes(compressor);
}

function createSyntheticAppImage(
  root: string,
  options: {
    compression?: SquashfsCompression;
    mode?: number;
    runtimePrefix?: Buffer;
  } = {},
): { appimage: string; runtimePrefix: Buffer } {
  const appDir = join(root, "AppDir");
  mkdirSync(join(appDir, "usr/lib"), { recursive: true });
  mkdirSync(join(appDir, "usr/bin"), { recursive: true });
  writeFileSync(join(appDir, "usr/lib/libwayland-client.so.0"), "wayland");
  writeFileSync(join(appDir, "usr/bin/app"), "#!/bin/sh\n");
  return packSyntheticAppImage(root, appDir, options);
}

function packSyntheticAppImage(
  root: string,
  appDir: string,
  options: {
    compression?: SquashfsCompression;
    mode?: number;
    runtimePrefix?: Buffer;
  } = {},
): { appimage: string; runtimePrefix: Buffer } {
  const squashfs = join(root, "payload.squashfs");
  const appimage = join(root, "PickGauge_1.0.0_amd64.AppImage");
  const runtimePrefix = options.runtimePrefix ?? Buffer.from("pickforge-runtime-prefix\n");
  runFixtureTool("mksquashfs", [
    appDir,
    squashfs,
    "-comp",
    options.compression ?? "gzip",
    "-root-owned",
    "-noappend",
    "-quiet",
  ]);
  writeFileSync(appimage, Buffer.concat([runtimePrefix, readFileSync(squashfs)]));
  chmodSync(appimage, options.mode ?? 0o755);
  return { appimage, runtimePrefix };
}

function elfRuntimePrefixWithDecoy(payloadOffset: number): Buffer {
  const runtimePrefix = Buffer.alloc(payloadOffset);
  runtimePrefix[0] = 0x7f;
  runtimePrefix.write("ELF", 1, "ascii");
  runtimePrefix[4] = 2;
  runtimePrefix[5] = 1;
  runtimePrefix.writeBigUInt64LE(BigInt(payloadOffset), 40);
  runtimePrefix.writeUInt16LE(0, 58);
  runtimePrefix.writeUInt16LE(0, 60);
  writeFakeSquashfsSuperblock(runtimePrefix, 128, 1);
  return runtimePrefix;
}

function writeFakeSquashfsSuperblock(buffer: Buffer, offset: number, compressionId: number): void {
  buffer.write("hsqs", offset, "ascii");
  buffer.writeUInt32LE(1, offset + 4);
  buffer.writeUInt32LE(4096, offset + 12);
  buffer.writeUInt16LE(compressionId, offset + 20);
  buffer.writeUInt16LE(4, offset + 28);
  buffer.writeUInt16LE(0, offset + 30);
}

function listAppImage(appimage: string, offset: number): string {
  return runFixtureTool("unsquashfs", ["-ls", "-offset", String(offset), appimage]);
}

function runFixtureTool(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: toolOutputMaxBuffer });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.stderr.trim() ?? result.status}`,
    );
  }
  return result.stdout;
}

function writeLatestJsonFixture(path: string, assetName: string): void {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        platforms: {
          "linux-x86_64": {
            signature: "old-signature",
            url: `https://github.com/pickforge/pickgauge/releases/download/v1.0.0/${assetName}`,
          },
        },
        version: "1.0.0",
      },
      null,
      2,
    )}\n`,
  );
}

async function captureCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const code = await runCli(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

function failNextWrite(path: string): void {
  injectedWriteFailure.path = path;
  injectedWriteFailure.remaining = 1;
}

function failingMksquashfsEnv(root: string): NodeJS.ProcessEnv {
  const bin = join(root, "failing-tools");
  const mksquashfs = commandPath("mksquashfs");
  const unsquashfs = commandPath("unsquashfs");
  if (mksquashfs === null || unsquashfs === null) {
    throw new Error("SquashFS tools are required for this fixture");
  }
  mkdirSync(bin);
  writeFileSync(
    join(bin, "mksquashfs"),
    `#!/bin/sh\nif [ "\${1:-}" = "-version" ]; then exec ${JSON.stringify(mksquashfs)} "$@"; fi\nexit 19\n`,
  );
  chmodSync(join(bin, "mksquashfs"), 0o755);
  symlinkSync(unsquashfs, join(bin, "unsquashfs"));
  return {
    ...envWithoutSigning(),
    PATH: bin,
    TAURI_SIGNING_PRIVATE_KEY: "test-key",
  };
}

function commandPath(command: string): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function envWithoutSigning(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: undefined,
    TAURI_SIGNING_PRIVATE_KEY_PATH: undefined,
  };
}
