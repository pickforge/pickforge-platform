import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_CONFIG_FILE = "pickforge.release.json";

export const PLATFORM_KEYS = [
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "linux-x86_64-rpm",
  "windows-x86_64",
  "windows-x86_64-msi",
  "windows-x86_64-nsis",
  "darwin-x86_64",
  "darwin-aarch64",
] as const;

const TOOL_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
const WAYLAND_LIBRARY_ROOTS = ["usr/lib", "usr/lib64", "lib", "lib64"] as const;
const WAYLAND_LIBRARY_NAME = /^libwayland-.*\.so/u;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export interface ReleaseCollectConfig {
  artifactRoot: string;
  outputDir: string;
  patterns: string[];
  prefix?: string;
}

export interface ReleaseChannelConfig {
  latestJsonAsset?: string;
  tagPrefix?: string;
}

export interface NightlyChannelConfig extends ReleaseChannelConfig {
  enabled: boolean;
  branch?: string;
}

export interface UpdaterConfig {
  requiredPlatforms?: PlatformKey[];
}

export interface TauriReleaseConfig {
  schemaVersion: 1;
  repository: string;
  appName: string;
  tauriConfig?: string;
  collect: ReleaseCollectConfig;
  stable: ReleaseChannelConfig;
  nightly?: NightlyChannelConfig;
  updater?: UpdaterConfig;
}

export interface NightlyVersionInput {
  baseVersion: string;
  sha: string;
  date?: Date | string;
}

export interface NightlyVersionResult {
  version: string;
  tag: string;
  date: string;
  shortSha: string;
}

export interface CollectedAsset {
  source: string;
  destination: string;
  name: string;
}

export interface CollectAssetsOptions {
  repoRoot?: string;
  artifactRoot?: string;
  outputDir?: string;
  prefix?: string;
  dryRun?: boolean;
}

export interface LatestJsonPlatform {
  signature: string;
  url: string;
}

export interface LatestJson {
  version: string;
  pub_date?: string;
  platforms: Record<string, LatestJsonPlatform>;
  notes?: string;
}

export interface GenerateLatestJsonOptions {
  assetsDir: string;
  version: string;
  downloadBaseUrl: string;
  pubDate?: Date | string;
  notes?: string;
  requiredPlatforms?: PlatformKey[];
}

export interface GenerateLatestJsonReport {
  latestJson: LatestJson;
  excludedStaleAssets: string[];
}

export interface LatestJsonVerification {
  ok: boolean;
  platforms: string[];
  errors: string[];
}

export type SquashfsCompression = "gzip" | "lzo" | "xz" | "lz4" | "zstd";

export interface FixAppImageOptions {
  appimage: string;
  latestJson?: string;
  signCommand?: string;
  keepTemp?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface FixAppImageResult {
  appimage: string;
  strippedCount: number;
  compression: SquashfsCompression;
  signed: boolean;
  latestJsonPatched: boolean;
  platformsPatched: string[];
}

type JsonRecord = Record<string, unknown>;

interface PlatformCandidate {
  platform: PlatformKey;
  assetName: string;
  signatureFile: string;
  priority: number;
}

interface LatestJsonPatchTarget {
  parsed: JsonRecord;
  platforms: Array<{ platform: string; value: JsonRecord }>;
}

interface ReleaseFileContents {
  path: string;
  data: Buffer;
  mode: number;
}

type ExistingReleaseFileSnapshot =
  | (ReleaseFileContents & { kind: "file" })
  | (ReleaseFileContents & { kind: "symlink"; linkTarget: string });

type ReleaseFileSnapshot =
  | ExistingReleaseFileSnapshot
  | { path: string; kind: "dangling-symlink"; linkTarget: string }
  | { path: string; kind: "missing" };

export class ReleaseToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseToolError";
  }
}

export function loadReleaseConfig(path = DEFAULT_CONFIG_FILE): TauriReleaseConfig {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return validateReleaseConfig(parsed);
}

export function validateReleaseConfig(input: unknown): TauriReleaseConfig {
  const record = asRecord(input, "config");
  const schemaVersion = record.schemaVersion;
  const repository = record.repository;
  const appName = record.appName;
  const tauriConfig = optionalString(record.tauriConfig, "tauriConfig");
  const collect = asRecord(record.collect, "collect");
  const stable = asRecord(record.stable, "stable");
  const nightly =
    record.nightly === undefined ? undefined : asRecord(record.nightly, "nightly");
  const updater =
    record.updater === undefined ? undefined : asRecord(record.updater, "updater");

  if (schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }
  if (!isNonEmptyString(repository) || !/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error("repository must be in owner/name form");
  }
  if (!isNonEmptyString(appName)) {
    throw new Error("appName must be a non-empty string");
  }

  const config: TauriReleaseConfig = {
    schemaVersion: 1,
    repository,
    appName,
    collect: {
      artifactRoot: requiredString(collect.artifactRoot, "collect.artifactRoot"),
      outputDir: requiredString(collect.outputDir, "collect.outputDir"),
      patterns: requiredStringArray(collect.patterns, "collect.patterns"),
      prefix: optionalString(collect.prefix, "collect.prefix"),
    },
    stable: {
      latestJsonAsset: optionalString(stable.latestJsonAsset, "stable.latestJsonAsset"),
      tagPrefix: optionalString(stable.tagPrefix, "stable.tagPrefix"),
    },
  };

  if (tauriConfig !== undefined) {
    config.tauriConfig = tauriConfig;
  }

  if (nightly !== undefined) {
    const enabled = nightly.enabled;
    if (typeof enabled !== "boolean") {
      throw new Error("nightly.enabled must be a boolean");
    }
    config.nightly = {
      enabled,
      branch: optionalString(nightly.branch, "nightly.branch"),
      latestJsonAsset: optionalString(nightly.latestJsonAsset, "nightly.latestJsonAsset"),
      tagPrefix: optionalString(nightly.tagPrefix, "nightly.tagPrefix"),
    };
  }

  if (updater !== undefined) {
    const requiredPlatforms =
      updater.requiredPlatforms === undefined
        ? undefined
        : requiredPlatformArray(updater.requiredPlatforms, "updater.requiredPlatforms");
    config.updater = { requiredPlatforms };
  }

  return config;
}

export function computeNightlyVersion(input: NightlyVersionInput): NightlyVersionResult {
  const baseVersion = normalizeSemver(input.baseVersion);
  const shortSha = normalizeShortSha(input.sha);
  const date = normalizeDate(input.date ?? new Date());
  const compactDate = date.replaceAll("-", "");

  return {
    version: `${baseVersion}-nightly.${compactDate}.${shortSha}`,
    tag: `nightly-${date}-${shortSha}`,
    date,
    shortSha,
  };
}

export function collectAssets(
  config: TauriReleaseConfig,
  options: CollectAssetsOptions = {},
): CollectedAsset[] {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const artifactRoot = resolvePath(repoRoot, options.artifactRoot ?? config.collect.artifactRoot);
  const outputDir = resolvePath(repoRoot, options.outputDir ?? config.collect.outputDir);
  const prefix = options.prefix ?? config.collect.prefix;
  const matchers = config.collect.patterns.map(globToRegExp);
  const assets = listFiles(artifactRoot)
    .filter((file) => {
      const rel = normalizePath(relative(artifactRoot, file));
      const name = basename(file);
      return matchers.some((matcher, index) => {
        const pattern = config.collect.patterns[index];
        if (pattern === undefined) {
          return false;
        }
        return matcher.test(pattern.includes("/") ? rel : name);
      });
    })
    .sort((left, right) => left.localeCompare(right));

  if (!options.dryRun) {
    mkdirSync(outputDir, { recursive: true });
  }

  const collected: CollectedAsset[] = [];
  const destinations = new Map<string, string>();

  for (const source of assets) {
    const name = prefix ? `${prefix}-${basename(source)}` : basename(source);
    const destination = join(outputDir, name);
    const existingSource = destinations.get(destination);
    if (existingSource !== undefined) {
      throw new Error(
        `duplicate collected asset destination ${name}: ${existingSource} and ${source}`,
      );
    }
    destinations.set(destination, source);
    if (!options.dryRun) {
      copyFileSync(source, destination);
    }
    collected.push({ source, destination, name });
  }

  return collected;
}

export function generateLatestJson(options: GenerateLatestJsonOptions): LatestJson {
  return generateLatestJsonReport(options).latestJson;
}

export function generateLatestJsonReport(
  options: GenerateLatestJsonOptions,
): GenerateLatestJsonReport {
  const assetsDir = resolve(options.assetsDir);
  if (!isSemver(options.version)) {
    throw new Error("version must be SemVer");
  }
  const pubDate = normalizePubDate(options.pubDate ?? new Date());
  const filteredSignatures = filterStaleSignatureFiles(
    listFiles(assetsDir).filter((file) => file.endsWith(".sig")),
    options.version,
  );
  const sigFiles = filteredSignatures.sigFiles;
  const orphanSignatures = sigFiles.filter((file) => !existsSync(file.slice(0, -".sig".length)));
  if (orphanSignatures.length > 0) {
    throw new Error(
      `signature files are missing matching assets: ${orphanSignatures
        .map((file) => basename(file))
        .join(", ")}`,
    );
  }
  const assetNames = new Map<string, string>();
  for (const sigFile of sigFiles) {
    const assetPath = sigFile.slice(0, -".sig".length);
    const assetName = basename(assetPath);
    const existingPath = assetNames.get(assetName);
    if (existingPath !== undefined && existingPath !== assetPath) {
      throw new Error(
        `duplicate updater asset name ${assetName}: ${existingPath} and ${assetPath}`,
      );
    }
    assetNames.set(assetName, assetPath);
  }
  const candidates = sigFiles.flatMap((file) => toPlatformCandidates(file, assetsDir));
  const selected = selectPlatformCandidates(candidates);
  const platforms: Record<string, LatestJsonPlatform> = {};

  for (const candidate of selected) {
    const signature = readFileSync(candidate.signatureFile, "utf8").trim();
    if (signature.length === 0) {
      continue;
    }
    platforms[candidate.platform] = {
      signature,
      url: joinUrl(options.downloadBaseUrl, candidate.assetName),
    };
  }

  const missing = (options.requiredPlatforms ?? []).filter(
    (platform) => platforms[platform] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(`missing required updater platforms: ${missing.join(", ")}`);
  }

  const latest: LatestJson = {
    version: options.version,
    pub_date: pubDate,
    platforms,
  };
  if (options.notes !== undefined) {
    latest.notes = options.notes;
  }
  return {
    latestJson: latest,
    excludedStaleAssets: filteredSignatures.excludedStaleAssets,
  };
}

export function writeLatestJson(path: string, latest: LatestJson): void {
  writeFileSync(path, `${JSON.stringify(latest, null, 2)}\n`);
}

export function fixAppImage(options: FixAppImageOptions): FixAppImageResult {
  const env = options.env ?? process.env;
  const signed = isSigningEnabled(env);
  if (options.latestJson !== undefined && !signed) {
    throw new ReleaseToolError("--latest-json requires TAURI_SIGNING_PRIVATE_KEY");
  }

  requireTool("unsquashfs", env);
  requireTool("mksquashfs", env);

  const appimage = resolve(options.appimage);
  const signaturePath = `${appimage}.sig`;
  const appimageSnapshot = snapshotReleaseFile(appimage, true);
  const signatureSnapshot = snapshotReleaseFile(signaturePath, false);
  const latestJsonSnapshot =
    options.latestJson === undefined ? undefined : snapshotReleaseFile(options.latestJson, true);
  const latestJsonTarget =
    options.latestJson === undefined
      ? undefined
      : readLatestJsonPatchTarget(options.latestJson, appimage);
  const original = appimageSnapshot.data;
  const offset = findSquashfsOffset(original);
  const runtimePrefix = original.subarray(0, offset);
  const compression = squashfsCompression(original, offset);
  const tempDir = mkdtempSync(join(tmpdir(), "pickforge-appimage-"));

  try {
    const appDir = join(tempDir, "AppDir");
    const squashfs = join(tempDir, "fixed.squashfs");
    const stagedAppimage = join(tempDir, basename(appimage));
    const stagedSignature = `${stagedAppimage}.sig`;
    const stagedLatestJson =
      options.latestJson === undefined ? undefined : join(tempDir, basename(options.latestJson));

    runTool("unsquashfs", ["-dest", appDir, "-offset", String(offset), appimage], env);
    const strippedCount = stripWaylandLibraries(appDir);
    runTool(
      "mksquashfs",
      [appDir, squashfs, "-comp", compression, "-root-owned", "-noappend"],
      env,
    );
    writeFileSync(stagedAppimage, Buffer.concat([runtimePrefix, readFileSync(squashfs)]));
    chmodSync(stagedAppimage, appimageSnapshot.mode);

    let signature: string | undefined;
    if (signed) {
      runSignCommand(stagedAppimage, options.signCommand, env);
      signature = readSignatureFile(stagedSignature);
    }

    const platformsPatched =
      latestJsonTarget === undefined || stagedLatestJson === undefined || signature === undefined
        ? []
        : stageLatestJsonSignatures(latestJsonTarget, signature, stagedLatestJson);
    verifyStagedReleaseSet({
      appimage: stagedAppimage,
      appimageMode: appimageSnapshot.mode,
      appimageOffset: runtimePrefix.length,
      env,
      latestJson: stagedLatestJson,
      liveAppimage: appimage,
      signature,
      signaturePath: signed ? stagedSignature : undefined,
    });

    commitReleaseSet({
      appimage,
      appimageMode: appimageSnapshot.mode,
      appimageData: readFileSync(stagedAppimage),
      latestJson: options.latestJson,
      latestJsonData:
        stagedLatestJson === undefined ? undefined : readFileSync(stagedLatestJson),
      latestJsonMode: latestJsonSnapshot?.mode,
      signatureData: signed ? readFileSync(stagedSignature) : undefined,
      signatureMode: signed ? statSync(stagedSignature).mode & 0o7777 : undefined,
      signaturePath,
      snapshots: {
        appimage: appimageSnapshot,
        latestJson: latestJsonSnapshot,
        signature: signatureSnapshot,
      },
    });

    return {
      appimage,
      strippedCount,
      compression,
      signed,
      latestJsonPatched: platformsPatched.length > 0,
      platformsPatched,
    };
  } finally {
    if (options.keepTemp !== true) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  }
}

export function verifyLatestJson(input: string | LatestJson): LatestJsonVerification {
  const errors: string[] = [];
  let parsed: unknown = null;

  try {
    parsed = typeof input === "string" ? JSON.parse(input) : input;
  } catch (error) {
    errors.push(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length === 0 && !isRecord(parsed)) {
    errors.push("latest.json must be an object");
  }

  const latest = errors.length === 0 ? (parsed as LatestJson) : null;

  if (latest !== null) {
    if (!isNonEmptyString(latest.version)) {
      errors.push("version must be a non-empty string");
    } else if (!isSemver(latest.version)) {
      errors.push("version must be SemVer");
    }
    if (
      latest.pub_date !== undefined &&
      (!isNonEmptyString(latest.pub_date) || !isRfc3339(latest.pub_date))
    ) {
      errors.push("pub_date must be an RFC3339 date-time string");
    }
    if (!isRecord(latest.platforms) || Object.keys(latest.platforms).length === 0) {
      errors.push("platforms must contain at least one platform");
    } else {
      for (const [platform, value] of Object.entries(latest.platforms)) {
        if (!PLATFORM_KEYS.includes(platform as PlatformKey)) {
          errors.push(`${platform} is not a supported updater platform`);
        }
        const platformRecord = isRecord(value) ? value : null;
        if (platformRecord === null) {
          errors.push(`${platform} must be an object`);
          continue;
        }
        if (!isNonEmptyString(platformRecord.signature)) {
          errors.push(`${platform}.signature must be a non-empty string`);
        }
        if (!isNonEmptyString(platformRecord.url)) {
          errors.push(`${platform}.url must be a non-empty string`);
        } else {
          try {
            const url = new URL(platformRecord.url);
            if (url.protocol !== "https:" && url.protocol !== "http:") {
              errors.push(`${platform}.url must use http or https`);
            }
          } catch {
            errors.push(`${platform}.url must be a valid URL`);
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    platforms: isRecord(latest?.platforms) ? Object.keys(latest.platforms) : [],
    errors,
  };
}

export function platformKeyForAssetName(assetName: string): PlatformKey | null {
  return platformKeysForAssetName(assetName)[0] ?? null;
}

export function platformKeysForAssetName(assetName: string): PlatformKey[] {
  return platformKeysForAssetPath(assetName);
}

function platformKeysForAssetPath(assetPath: string): PlatformKey[] {
  const assetName = basename(assetPath);
  const loweredPath = normalizePath(assetPath).toLowerCase();

  if (isUnsupportedLinuxArchitecture(assetPath)) {
    return [];
  }
  if (isUnsupportedWindowsArchitecture(assetPath)) {
    return [];
  }
  if (assetName.endsWith(".AppImage") || assetName.endsWith(".AppImage.tar.gz")) {
    return ["linux-x86_64", "linux-x86_64-appimage"];
  }
  if (assetName.endsWith(".deb")) {
    return ["linux-x86_64-deb"];
  }
  if (assetName.endsWith(".rpm")) {
    return ["linux-x86_64-rpm"];
  }
  if (assetName.endsWith(".msi") || assetName.endsWith(".msi.zip")) {
    return ["windows-x86_64", "windows-x86_64-msi"];
  }
  if (
    assetName.endsWith(".exe") ||
    assetName.endsWith(".exe.zip") ||
    assetName.endsWith(".nsis.zip")
  ) {
    return ["windows-x86_64", "windows-x86_64-nsis"];
  }
  if (assetName.endsWith(".app.tar.gz")) {
    if (/apple-silicon|aarch64|arm64/u.test(loweredPath)) {
      return ["darwin-aarch64"];
    }
    if (/intel|x86_64|x64|amd64/u.test(loweredPath)) {
      return ["darwin-x86_64"];
    }
  }
  return [];
}

function toPlatformCandidates(signatureFile: string, assetsDir: string): PlatformCandidate[] {
  const assetPath = signatureFile.slice(0, -".sig".length);
  const assetName = normalizePath(relative(assetsDir, assetPath));
  const platforms = platformKeysForAssetPath(assetPath);
  if (
    platforms.length === 0 &&
    isLinuxUpdaterAsset(assetPath) &&
    isUnsupportedLinuxArchitecture(assetPath)
  ) {
    throw new Error(
      `unsupported Linux updater architecture for ${assetName}; only x86_64 is supported`,
    );
  }
  if (
    platforms.length === 0 &&
    isWindowsUpdaterAsset(assetPath) &&
    isUnsupportedWindowsArchitecture(assetPath)
  ) {
    throw new Error(
      `unsupported Windows updater architecture for ${assetName}; only x86_64 is supported`,
    );
  }
  return platforms.map((platform) => ({
    platform,
    assetName,
    signatureFile,
    priority: platformPriority(assetName, platform),
  }));
}

function selectPlatformCandidates(candidates: PlatformCandidate[]): PlatformCandidate[] {
  const byPlatform = new Map<PlatformKey, PlatformCandidate>();

  for (const candidate of candidates) {
    const existing = byPlatform.get(candidate.platform);
    if (
      existing === undefined ||
      candidate.priority < existing.priority ||
      (candidate.priority === existing.priority &&
        candidate.assetName.localeCompare(existing.assetName) < 0)
    ) {
      byPlatform.set(candidate.platform, candidate);
    }
  }

  return [...byPlatform.values()].sort((left, right) => left.platform.localeCompare(right.platform));
}

function filterStaleSignatureFiles(
  sigFiles: string[],
  version: string,
): { sigFiles: string[]; excludedStaleAssets: string[] } {
  const currentVersion = normalizeVersionToken(version);
  const included: string[] = [];
  const excluded = new Set<string>();

  for (const sigFile of sigFiles.sort((left, right) => left.localeCompare(right))) {
    const assetPath = sigFile.slice(0, -".sig".length);
    const assetName = basename(assetPath);
    if (hasStaleVersionToken(assetName, currentVersion)) {
      if (existsSync(assetPath)) {
        excluded.add(assetName);
      }
      excluded.add(basename(sigFile));
    } else {
      included.push(sigFile);
    }
  }

  return {
    sigFiles: included,
    excludedStaleAssets: [...excluded].sort((left, right) => left.localeCompare(right)),
  };
}

function hasStaleVersionToken(assetName: string, currentVersion: string): boolean {
  const tokens = versionTokens(assetName);
  const allowRpmSuffix = assetName.endsWith(".rpm");
  return (
    tokens.length > 0 &&
    tokens.some((token) => !versionTokenMatches(token, currentVersion, allowRpmSuffix))
  );
}

function versionTokens(assetName: string): string[] {
  const scanName = trimKnownArtifactSuffix(assetName);
  const matches = scanName.matchAll(
    /(?:^|[^0-9A-Za-z])[vV]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z])/gu,
  );
  return [...matches].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function versionTokenMatches(
  token: string,
  currentVersion: string,
  allowRpmSuffix: boolean,
): boolean {
  if (token === currentVersion) {
    return true;
  }
  if (!allowRpmSuffix || !token.startsWith(currentVersion)) {
    return false;
  }
  const rpmSuffix = token.slice(currentVersion.length);
  return rpmSuffix.length > 1 && /^-\d/u.test(rpmSuffix);
}

function normalizeVersionToken(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

function trimKnownArtifactSuffix(assetName: string): string {
  const suffixes = [
    ".AppImage.tar.gz",
    ".app.tar.gz",
    ".setup.nsis.zip",
    ".nsis.zip",
    ".msi.zip",
    ".exe.zip",
    ".AppImage",
    ".deb",
    ".rpm",
    ".msi",
    ".exe",
  ];
  const suffix = suffixes.find((value) => assetName.endsWith(value));
  return suffix === undefined ? assetName : assetName.slice(0, -suffix.length);
}

function stripWaylandLibraries(appDir: string): number {
  const appDirReal = realpathSync(appDir);
  let strippedCount = 0;
  for (const root of WAYLAND_LIBRARY_ROOTS) {
    strippedCount += stripWaylandLibrariesInDirectory(join(appDir, root), appDirReal);
  }
  return strippedCount;
}

function stripWaylandLibrariesInDirectory(directory: string, appDirReal: string): number {
  if (!existsSync(directory)) {
    return 0;
  }
  const directoryStats = lstatSync(directory);
  if (!directoryStats.isDirectory()) {
    return 0;
  }
  if (!isPathInside(appDirReal, realpathSync(directory))) {
    return 0;
  }

  let strippedCount = 0;
  for (const entry of readdirSync(directory)) {
    const entryPath = join(directory, entry);
    const entryStats = lstatSync(entryPath);
    if (WAYLAND_LIBRARY_NAME.test(entry)) {
      if (entryStats.isFile() || entryStats.isSymbolicLink()) {
        unlinkSync(entryPath);
        strippedCount += 1;
      }
    } else if (entryStats.isDirectory()) {
      strippedCount += stripWaylandLibrariesInDirectory(entryPath, appDirReal);
    }
  }
  return strippedCount;
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function findSquashfsOffset(input: Buffer): number {
  const elfOffset = squashfsOffsetFromElf(input);
  if (elfOffset !== null) {
    return elfOffset;
  }

  const magic = Buffer.from("hsqs");
  let offset = input.indexOf(magic);
  while (offset !== -1) {
    if (isValidSquashfsSuperblock(input, offset)) {
      return offset;
    }
    offset = input.indexOf(magic, offset + 1);
  }
  throw new ReleaseToolError("AppImage does not contain a valid SquashFS payload");
}

function squashfsOffsetFromElf(input: Buffer): number | null {
  if (
    input.length < 64 ||
    input[0] !== 0x7f ||
    input[1] !== 0x45 ||
    input[2] !== 0x4c ||
    input[3] !== 0x46 ||
    input[4] !== 2 ||
    input[5] !== 1
  ) {
    return null;
  }

  const sectionHeaderOffset = input.readBigUInt64LE(40);
  const sectionHeaderEntrySize = input.readUInt16LE(58);
  const sectionHeaderCount = input.readUInt16LE(60);
  const offset =
    sectionHeaderOffset + BigInt(sectionHeaderEntrySize) * BigInt(sectionHeaderCount);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  const numericOffset = Number(offset);
  return isValidSquashfsSuperblock(input, numericOffset) ? numericOffset : null;
}

function isValidSquashfsSuperblock(input: Buffer, offset: number): boolean {
  if (offset + 96 > input.length) {
    return false;
  }
  const blockSize = input.readUInt32LE(offset + 12);
  const compression = input.readUInt16LE(offset + 20);
  const major = input.readUInt16LE(offset + 28);
  const minor = input.readUInt16LE(offset + 30);
  return (
    major === 4 &&
    minor === 0 &&
    compression >= 1 &&
    compression <= 6 &&
    blockSize >= 4096 &&
    blockSize <= 1048576 &&
    (blockSize & (blockSize - 1)) === 0
  );
}

function squashfsCompression(input: Buffer, offset: number): SquashfsCompression {
  const id = input.readUInt16LE(offset + 20);
  switch (id) {
    case 1:
      return "gzip";
    case 2:
      throw new ReleaseToolError("SquashFS lzma compression is not supported for repacking");
    case 3:
      return "lzo";
    case 4:
      return "xz";
    case 5:
      return "lz4";
    case 6:
      return "zstd";
    default:
      throw new ReleaseToolError(`unsupported SquashFS compression id ${id}`);
  }
}

function verifyNoWaylandLibraries(appimage: string, offset: number, env: NodeJS.ProcessEnv): void {
  const listing = runTool("unsquashfs", ["-ls", "-offset", String(offset), appimage], env);
  if (listing.split(/\r?\n/u).some(isWaylandLibraryListingEntry)) {
    throw new ReleaseToolError("rebuilt AppImage still contains libwayland libraries");
  }
}

function isWaylandLibraryListingEntry(line: string): boolean {
  const path = normalizePath(line.trim()).replace(/^squashfs-root\/?/u, "");
  const parts = path.split("/").filter((part) => part.length > 0);
  const file = parts.at(-1);
  if (file === undefined || !WAYLAND_LIBRARY_NAME.test(file)) {
    return false;
  }
  const dir = parts.slice(0, -1).join("/");
  return WAYLAND_LIBRARY_ROOTS.some((root) => dir === root || dir.startsWith(`${root}/`));
}

function isSigningEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    isNonEmptyString(env.TAURI_SIGNING_PRIVATE_KEY) ||
    isNonEmptyString(env.TAURI_SIGNING_PRIVATE_KEY_PATH)
  );
}

function runSignCommand(
  appimage: string,
  signCommand: string | undefined,
  env: NodeJS.ProcessEnv,
): void {
  if (signCommand === undefined) {
    runTool("bun", ["run", "tauri", "signer", "sign", appimage], env);
    return;
  }
  runShellCommand(`${signCommand} ${shellQuote(appimage)}`, env);
}

function stageLatestJsonSignatures(
  target: LatestJsonPatchTarget,
  signature: string,
  stagedLatestJson: string,
): string[] {
  for (const { value } of target.platforms) {
    value.signature = signature;
  }

  writeFileSync(stagedLatestJson, `${JSON.stringify(target.parsed, null, 2)}\n`);
  return target.platforms
    .map(({ platform }) => platform)
    .sort((left, right) => left.localeCompare(right));
}

function verifyStagedReleaseSet(options: {
  appimage: string;
  appimageMode: number;
  appimageOffset: number;
  env: NodeJS.ProcessEnv;
  latestJson?: string;
  liveAppimage: string;
  signature?: string;
  signaturePath?: string;
}): void {
  verifyNoWaylandLibraries(options.appimage, options.appimageOffset, options.env);
  if ((statSync(options.appimage).mode & 0o7777) !== options.appimageMode) {
    throw new ReleaseToolError("staged AppImage did not preserve its executable mode");
  }

  if (options.signaturePath !== undefined) {
    const stagedSignature = readSignatureFile(options.signaturePath);
    if (stagedSignature !== options.signature) {
      throw new ReleaseToolError("staged AppImage signature changed during verification");
    }
  }

  if (options.latestJson !== undefined) {
    if (options.signature === undefined) {
      throw new ReleaseToolError("staged latest.json is missing its AppImage signature");
    }
    const target = readLatestJsonPatchTarget(options.latestJson, options.liveAppimage);
    if (target.platforms.some(({ value }) => value.signature !== options.signature)) {
      throw new ReleaseToolError("staged latest.json does not contain the AppImage signature");
    }
  }
}

function commitReleaseSet(options: {
  appimage: string;
  appimageData: Buffer;
  appimageMode: number;
  signaturePath: string;
  signatureData?: Buffer;
  signatureMode?: number;
  latestJson?: string;
  latestJsonData?: Buffer;
  latestJsonMode?: number;
  snapshots: {
    appimage: ExistingReleaseFileSnapshot;
    signature: ReleaseFileSnapshot;
    latestJson?: ExistingReleaseFileSnapshot;
  };
}): void {
  const rollbackJournal: ReleaseFileSnapshot[] = [];
  try {
    rollbackJournal.push(options.snapshots.appimage);
    writeReleaseFile(options.appimage, options.appimageData, options.appimageMode);

    rollbackJournal.push(options.snapshots.signature);
    rmSync(options.signaturePath, { force: true });
    if (options.signatureData !== undefined) {
      writeReleaseFile(
        options.signaturePath,
        options.signatureData,
        options.signatureMode ?? 0o644,
      );
    }

    if (
      options.latestJson !== undefined &&
      options.latestJsonData !== undefined &&
      options.snapshots.latestJson !== undefined
    ) {
      rollbackJournal.push(options.snapshots.latestJson);
      writeReleaseFile(
        options.latestJson,
        options.latestJsonData,
        options.latestJsonMode ?? 0o644,
      );
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const snapshot of rollbackJournal.reverse()) {
      try {
        restoreReleaseFile(snapshot);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${basename(snapshot.path)}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (rollbackErrors.length > 0) {
      const commitError = error instanceof Error ? error.message : String(error);
      throw new ReleaseToolError(
        `AppImage release commit failed (${commitError}) and rollback was incomplete: ${rollbackErrors.join("; ")}`,
      );
    }
    throw error;
  }
}

function writeReleaseFile(path: string, data: Buffer, mode: number): void {
  writeFileSync(path, data);
  chmodSync(path, mode);
}

function snapshotReleaseFile(path: string, required: true): ExistingReleaseFileSnapshot;
function snapshotReleaseFile(path: string, required: false): ReleaseFileSnapshot;
function snapshotReleaseFile(path: string, required: boolean): ReleaseFileSnapshot {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (isFileNotFoundError(error) && !required) {
      return { path, kind: "missing" };
    }
    throw error;
  }

  const kind = entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : null;
  if (kind === "symlink" && !existsSync(path)) {
    if (!required) {
      return { path, kind: "dangling-symlink", linkTarget: readlinkSync(path) };
    }
    throw new ReleaseToolError(`${basename(path)} must point to a file`);
  }
  const target = statSync(path);
  if (kind === null || !target.isFile()) {
    throw new ReleaseToolError(`${basename(path)} must be a file`);
  }
  const contents = {
    path,
    data: readFileSync(path),
    mode: target.mode & 0o7777,
  };
  return kind === "symlink"
    ? { ...contents, kind, linkTarget: readlinkSync(path) }
    : { ...contents, kind };
}

function restoreReleaseFile(snapshot: ReleaseFileSnapshot): void {
  rmSync(snapshot.path, { force: true });
  if (snapshot.kind === "missing") {
    return;
  }
  if (snapshot.kind === "dangling-symlink") {
    symlinkSync(snapshot.linkTarget, snapshot.path);
    return;
  }
  if (snapshot.kind === "symlink") {
    symlinkSync(snapshot.linkTarget, snapshot.path);
  }
  writeReleaseFile(snapshot.path, snapshot.data, snapshot.mode);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function readSignatureFile(signaturePath: string): string {
  if (!existsSync(signaturePath)) {
    throw new ReleaseToolError(`missing signature file ${basename(signaturePath)}`);
  }
  const signature = readFileSync(signaturePath, "utf8").trim();
  if (signature.length === 0) {
    throw new ReleaseToolError(`signature file ${basename(signaturePath)} is empty`);
  }
  return signature;
}

function readLatestJsonPatchTarget(latestJson: string, appimage: string): LatestJsonPatchTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(latestJson, "utf8")) as unknown;
  } catch (error) {
    throw new ReleaseToolError(
      `invalid latest.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ReleaseToolError("latest.json must be an object");
  }
  if (!isRecord(parsed.platforms)) {
    throw new ReleaseToolError("latest.json platforms must be an object");
  }

  const appimageName = basename(appimage);
  const platformsPatched: LatestJsonPatchTarget["platforms"] = [];
  for (const [platform, value] of Object.entries(parsed.platforms)) {
    if (!isRecord(value)) {
      throw new ReleaseToolError(`${platform} must be an object`);
    }
    if (!isNonEmptyString(value.url)) {
      throw new ReleaseToolError(`${platform}.url must be a non-empty string`);
    }
    if (basenameFromUrl(value.url) === appimageName) {
      platformsPatched.push({ platform, value });
    }
  }

  if (platformsPatched.length === 0) {
    throw new ReleaseToolError(`latest.json has no platform URL matching ${appimageName}`);
  }

  return { parsed, platforms: platformsPatched };
}

function basenameFromUrl(value: string): string {
  try {
    return basename(decodeURIComponent(new URL(value).pathname));
  } catch {
    return basename(value);
  }
}

function requireTool(command: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, ["-version"], { env, stdio: "ignore" });
  if (result.error !== undefined) {
    throw new ReleaseToolError(`missing required tool: ${command}`);
  }
}

function runTool(command: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    maxBuffer: TOOL_OUTPUT_MAX_BUFFER,
  });
  if (result.error !== undefined) {
    throw new ReleaseToolError(
      result.error.message.includes("ENOENT")
        ? `missing required tool: ${command}`
        : `${command} failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new ReleaseToolError(
      `${command} failed with exit code ${result.status ?? "unknown"}${formatToolOutput(
        result.stderr,
      )}`,
    );
  }
  return result.stdout;
}

function runShellCommand(command: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, { encoding: "utf8", env, shell: true });
  if (result.error !== undefined) {
    throw new ReleaseToolError(`sign command failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new ReleaseToolError(
      `sign command failed with exit code ${result.status ?? "unknown"}${formatToolOutput(
        result.stderr,
      )}`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function formatToolOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length === 0 ? "" : `: ${trimmed}`;
}

function platformPriority(assetName: string, platform: PlatformKey): number {
  const lowered = assetName.toLowerCase();
  if (platform === "linux-x86_64" && lowered.endsWith(".appimage")) {
    return 0;
  }
  if (platform === "linux-x86_64" && lowered.endsWith(".appimage.tar.gz")) {
    return 1;
  }
  if (platform === "linux-x86_64" && lowered.endsWith(".deb")) {
    return 2;
  }
  if (platform === "linux-x86_64" && lowered.endsWith(".rpm")) {
    return 3;
  }
  if (
    lowered.endsWith("-setup.exe") ||
    lowered.endsWith("-setup.exe.zip") ||
    lowered.endsWith("-setup.nsis.zip")
  ) {
    return 0;
  }
  if (
    lowered.endsWith(".exe") ||
    lowered.endsWith(".exe.zip") ||
    lowered.endsWith(".nsis.zip")
  ) {
    return 1;
  }
  if (lowered.endsWith(".msi") || lowered.endsWith(".msi.zip")) {
    return 2;
  }
  return 0;
}

function listFiles(root: string): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      files.push(...listFiles(path));
    } else if (stats.isFile()) {
      files.push(path);
    }
  }

  return files;
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        out += "(?:.*/)?";
        index += 2;
      } else {
        out += ".*";
        index += 1;
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(char ?? "");
    }
  }
  out += "$";
  return new RegExp(out, "u");
}

function normalizePath(path: string): string {
  return sep === "/" ? path : path.replaceAll(sep, "/");
}

function resolvePath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function joinUrl(base: string, assetName: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${normalizedBase}/${assetName.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizeSemver(version: string): string {
  if (!isSemver(version)) {
    throw new Error("baseVersion must be a semver string");
  }
  return (version.startsWith("v") ? version.slice(1) : version).split("+")[0] ?? version;
}

function normalizeShortSha(sha: string): string {
  const shortSha = sha.slice(0, 12);
  if (!/^[0-9a-fA-F]{7,12}$/u.test(shortSha)) {
    throw new Error("sha must start with 7 to 12 hexadecimal characters");
  }
  return shortSha.toLowerCase();
}

function normalizeDate(date: Date | string): string {
  if (date instanceof Date) {
    return date.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  return date;
}

function normalizePubDate(date: Date | string): string {
  if (date instanceof Date) {
    return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
  }
  if (!isRfc3339(date)) {
    throw new Error("pubDate must be an RFC3339 date-time string");
  }
  return date;
}

function isSemver(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version);
}

function isRfc3339(date: string): boolean {
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?<zone>Z|[+-]\d{2}:\d{2})$/u.exec(
      date,
    );
  if (match?.groups === undefined || Number.isNaN(Date.parse(date))) {
    return false;
  }
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const second = Number(match.groups.second);
  const zone = match.groups.zone ?? "";
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) {
      return false;
    }
  }
  return true;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isLinuxUpdaterAsset(assetPath: string): boolean {
  const assetName = basename(assetPath);
  return (
    assetName.endsWith(".AppImage") ||
    assetName.endsWith(".AppImage.tar.gz") ||
    assetName.endsWith(".deb") ||
    assetName.endsWith(".rpm")
  );
}

function isWindowsUpdaterAsset(assetPath: string): boolean {
  const assetName = basename(assetPath);
  return (
    assetName.endsWith(".msi") ||
    assetName.endsWith(".msi.zip") ||
    assetName.endsWith(".exe") ||
    assetName.endsWith(".exe.zip") ||
    assetName.endsWith(".nsis.zip")
  );
}

function isUnsupportedLinuxArchitecture(assetPath: string): boolean {
  if (!isLinuxUpdaterAsset(assetPath)) {
    return false;
  }
  const loweredPath = normalizePath(assetPath).toLowerCase();
  if (/(?:^|[^a-z0-9])(?:x86_64|amd64|x64)(?:[^a-z0-9]|$)/u.test(loweredPath)) {
    return false;
  }
  return /(?:^|[^a-z0-9])(?:aarch64|arm64|armv7l?|i686|x86)(?:[^a-z0-9]|$)/u.test(
    loweredPath,
  );
}

function isUnsupportedWindowsArchitecture(assetPath: string): boolean {
  if (!isWindowsUpdaterAsset(assetPath)) {
    return false;
  }
  const loweredPath = normalizePath(assetPath).toLowerCase();
  if (/(?:^|[^a-z0-9])(?:x86_64|amd64|x64)(?:[^a-z0-9]|$)/u.test(loweredPath)) {
    return false;
  }
  return /(?:^|[^a-z0-9])(?:aarch64|arm64|i686|x86)(?:[^a-z0-9]|$)/u.test(loweredPath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");
}

function asRecord(value: unknown, name: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isNonEmptyString(value)) {
    throw new Error(`${name} must be a non-empty string when provided`);
  }
  return value;
}

function requiredStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value;
}

function requiredPlatformArray(value: unknown, name: string): PlatformKey[] {
  const values = requiredStringArray(value, name);
  for (const platform of values) {
    if (!PLATFORM_KEYS.includes(platform as PlatformKey)) {
      throw new Error(`${name} contains unknown platform ${platform}`);
    }
  }
  return values as PlatformKey[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
