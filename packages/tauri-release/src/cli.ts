#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  collectAssets,
  computeNightlyVersion,
  generateLatestJson,
  loadReleaseConfig,
  verifyLatestJson,
  writeLatestJson,
  type CollectAssetsOptions,
} from "./index.js";

type CliCommand =
  | "validate-config"
  | "compute-nightly-version"
  | "collect-assets"
  | "generate-latest-json"
  | "verify-latest-json";

const COMMANDS = new Set<CliCommand>([
  "validate-config",
  "compute-nightly-version",
  "collect-assets",
  "generate-latest-json",
  "verify-latest-json",
]);

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] as CliCommand | undefined;
  if (command === undefined || !COMMANDS.has(command)) {
    usage();
    return 2;
  }

  try {
    switch (command) {
      case "validate-config":
        return validateConfig(argv.slice(1));
      case "compute-nightly-version":
        return computeNightly(argv.slice(1));
      case "collect-assets":
        return collect(argv.slice(1));
      case "generate-latest-json":
        return generate(argv.slice(1));
      case "verify-latest-json":
        return verify(argv.slice(1));
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function validateConfig(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", default: "pickforge.release.json" },
    },
  });
  const config = loadReleaseConfig(values.config);
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  return 0;
}

function computeNightly(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-version": { type: "string" },
      sha: { type: "string" },
      date: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (values["base-version"] === undefined || values.sha === undefined) {
    throw new Error("compute-nightly-version requires --base-version and --sha");
  }
  const result = computeNightlyVersion({
    baseVersion: values["base-version"],
    sha: values.sha,
    date: values.date,
  });
  process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.version}\n`);
  return 0;
}

function collect(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", default: "pickforge.release.json" },
      "artifact-root": { type: "string" },
      out: { type: "string" },
      prefix: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const config = loadReleaseConfig(values.config);
  const options: CollectAssetsOptions = {
    artifactRoot: values["artifact-root"],
    outputDir: values.out,
    prefix: values.prefix,
    dryRun: values["dry-run"],
  };
  const assets = collectAssets(config, options);
  process.stdout.write(`${JSON.stringify({ count: assets.length, assets }, null, 2)}\n`);
  return assets.length === 0 ? 1 : 0;
}

function generate(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", default: "pickforge.release.json" },
      "assets-dir": { type: "string" },
      version: { type: "string" },
      "download-base-url": { type: "string" },
      "pub-date": { type: "string" },
      notes: { type: "string" },
      out: { type: "string" },
    },
  });
  if (values.version === undefined || values["download-base-url"] === undefined) {
    throw new Error("generate-latest-json requires --version and --download-base-url");
  }
  const config = loadReleaseConfig(values.config);
  const latest = generateLatestJson({
    assetsDir: values["assets-dir"] ?? config.collect.outputDir,
    version: values.version,
    downloadBaseUrl: values["download-base-url"],
    pubDate: values["pub-date"],
    notes: values.notes,
    requiredPlatforms: config.updater?.requiredPlatforms,
  });
  if (values.out !== undefined) {
    writeLatestJson(values.out, latest);
  }
  process.stdout.write(`${JSON.stringify(latest, null, 2)}\n`);
  return Object.keys(latest.platforms).length === 0 ? 1 : 0;
}

function verify(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string", default: "latest.json" },
    },
  });
  const result = verifyLatestJson(readFileSync(values.input, "utf8"));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

function usage(): void {
  process.stderr.write(
    [
      "Usage: pickforge-tauri-release <command> [options]",
      "",
      "Commands:",
      "  validate-config --config pickforge.release.json",
      "  compute-nightly-version --base-version 1.2.3 --sha <git-sha> [--date YYYY-MM-DD]",
      "  collect-assets --config pickforge.release.json [--prefix linux-appimage]",
      "  generate-latest-json --version 1.2.3 --download-base-url <url>",
      "  verify-latest-json --input latest.json",
      "",
    ].join("\n"),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runCli();
  process.exitCode = code;
}
