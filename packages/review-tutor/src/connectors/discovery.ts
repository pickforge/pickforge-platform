import { execFile as nodeExecFile } from "node:child_process";
import type { DiscoveryExecFile } from "./types.ts";

export const MAX_DISCOVERY_BYTES = 1024 * 1024;
export const DISCOVERY_TIMEOUT_MS = 10_000;

/** Keys every harness may read; a connector adds only the ones its own CLI needs. */
export const BASE_DISCOVERY_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL"] as const;

export function scrubbedEnvironment(
  keys: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = source[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

export function createDiscoveryExecFile(keys: readonly string[]): DiscoveryExecFile {
  return (file, args, options) => new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      args,
      { ...options, env: scrubbedEnvironment(keys), shell: false },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });
}

export function discoveryOptions(): {
  encoding: "utf8";
  maxBuffer: number;
  signal: AbortSignal;
  timeout: number;
} {
  return {
    encoding: "utf8",
    maxBuffer: MAX_DISCOVERY_BYTES,
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    timeout: DISCOVERY_TIMEOUT_MS,
  };
}
