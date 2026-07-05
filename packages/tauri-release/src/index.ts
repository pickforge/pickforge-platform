import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_CONFIG_FILE = "pickforge.release.json";

export const PLATFORM_KEYS = [
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "windows-x86_64",
  "darwin-x86_64",
  "darwin-aarch64",
] as const;

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
  pub_date: string;
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

export interface LatestJsonVerification {
  ok: boolean;
  platforms: string[];
  errors: string[];
}

type JsonRecord = Record<string, unknown>;

interface PlatformCandidate {
  platform: PlatformKey;
  assetName: string;
  signatureFile: string;
  priority: number;
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

  return assets.map((source) => {
    const name = prefix ? `${prefix}-${basename(source)}` : basename(source);
    const destination = join(outputDir, name);
    if (!options.dryRun) {
      copyFileSync(source, destination);
    }
    return { source, destination, name };
  });
}

export function generateLatestJson(options: GenerateLatestJsonOptions): LatestJson {
  const assetsDir = resolve(options.assetsDir);
  const pubDate = normalizePubDate(options.pubDate ?? new Date());
  const sigFiles = listFiles(assetsDir).filter((file) => file.endsWith(".sig"));
  const candidates = sigFiles.flatMap((file) => toPlatformCandidates(file));
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
  return latest;
}

export function writeLatestJson(path: string, latest: LatestJson): void {
  writeFileSync(path, `${JSON.stringify(latest, null, 2)}\n`);
}

export function verifyLatestJson(input: string | LatestJson): LatestJsonVerification {
  const errors: string[] = [];
  let latest: LatestJson | null = null;

  try {
    latest = typeof input === "string" ? (JSON.parse(input) as LatestJson) : input;
  } catch (error) {
    errors.push(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (latest !== null) {
    if (!isNonEmptyString(latest.version)) {
      errors.push("version must be a non-empty string");
    }
    if (!isNonEmptyString(latest.pub_date) || Number.isNaN(Date.parse(latest.pub_date))) {
      errors.push("pub_date must be an ISO date string");
    }
    if (!isRecord(latest.platforms) || Object.keys(latest.platforms).length === 0) {
      errors.push("platforms must contain at least one platform");
    } else {
      for (const [platform, value] of Object.entries(latest.platforms)) {
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
    platforms: latest?.platforms !== undefined ? Object.keys(latest.platforms) : [],
    errors,
  };
}

export function platformKeyForAssetName(assetName: string): PlatformKey | null {
  return platformKeysForAssetName(assetName)[0] ?? null;
}

export function platformKeysForAssetName(assetName: string): PlatformKey[] {
  if (assetName.endsWith(".AppImage")) {
    return ["linux-x86_64", "linux-x86_64-appimage"];
  }
  if (assetName.endsWith(".deb")) {
    return ["linux-x86_64-deb"];
  }
  if (assetName.endsWith(".msi") || assetName.endsWith(".exe")) {
    return ["windows-x86_64"];
  }
  if (assetName.endsWith(".app.tar.gz")) {
    const lowered = assetName.toLowerCase();
    if (/apple-silicon|aarch64|arm64/u.test(lowered)) {
      return ["darwin-aarch64"];
    }
    if (/intel|x86_64|x64|amd64/u.test(lowered)) {
      return ["darwin-x86_64"];
    }
  }
  return [];
}

function toPlatformCandidates(signatureFile: string): PlatformCandidate[] {
  const assetName = basename(signatureFile.slice(0, -".sig".length));
  return platformKeysForAssetName(assetName).map((platform) => ({
    platform,
    assetName,
    signatureFile,
    priority: platformPriority(assetName),
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

function platformPriority(assetName: string): number {
  const lowered = assetName.toLowerCase();
  if (lowered.endsWith("-setup.exe")) {
    return 0;
  }
  if (lowered.endsWith(".exe")) {
    return 1;
  }
  if (lowered.endsWith(".msi")) {
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
  return `${normalizedBase}/${encodeURIComponent(assetName)}`;
}

function normalizeSemver(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("baseVersion must be a semver string");
  }
  return version.split("+")[0] ?? version;
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
  if (Number.isNaN(Date.parse(date))) {
    throw new Error("pubDate must be parseable as a date");
  }
  return date;
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
