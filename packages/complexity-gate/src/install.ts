#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export type Harness = "claude" | "codex" | "pi" | "omp" | "grok" | "cursor" | "opencode";
type Json = Record<string, unknown>;

const harnessNames: Harness[] = ["claude", "codex", "pi", "omp", "grok", "cursor", "opencode"];

export const hookFragments: Record<"claude" | "codex" | "grok" | "cursor", Json> = {
  claude: {
    hooks: {
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "complexity-gate hook claude" }] }],
      Stop: [{ hooks: [{ type: "command", command: "complexity-gate hook claude" }] }],
    },
  },
  codex: {
    hooks: {
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "complexity-gate hook codex" }] }],
      Stop: [{ hooks: [{ type: "command", command: "complexity-gate hook codex" }] }],
    },
  },
  grok: {
    hooks: {
      PostToolUse: [{ matcher: "edit|write|apply_patch|Edit|Write|MultiEdit", hooks: [{ type: "command", command: "complexity-gate hook grok" }] }],
      Stop: [{ hooks: [{ type: "command", command: "complexity-gate hook grok" }] }],
    },
  },
  cursor: {
    version: 1,
    hooks: {
      afterFileEdit: [{ command: "complexity-gate hook cursor" }],
      stop: [{ command: "complexity-gate hook cursor", loop_limit: 3 }],
    },
  },
};

function stable(value: unknown): string { return JSON.stringify(value); }

function isPlainObject(value: unknown): value is Json {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function validateDocument(value: unknown, source: string): asserts value is Json {
  if (!isPlainObject(value)) throw new Error(`${source}: expected a JSON object`);
  if (value.hooks !== undefined) {
    if (!isPlainObject(value.hooks)) throw new Error(`${source}: expected "hooks" to be an object`);
    for (const [event, entries] of Object.entries(value.hooks)) {
      if (!Array.isArray(entries)) throw new Error(`${source}: expected "hooks.${event}" to be an array`);
    }
  }
}

export function mergeHookFragment(existing: Json, fragment: Json): Json {
  validateDocument(existing, "existing document");
  validateDocument(fragment, "hook fragment");
  const currentHooks = (existing.hooks ?? {}) as Json;
  const incomingHooks = (fragment.hooks ?? {}) as Json;
  const hooks: Json = { ...currentHooks };
  for (const [event, entries] of Object.entries(incomingHooks)) {
    const current = Array.isArray(currentHooks[event]) ? currentHooks[event] as unknown[] : [];
    const additions = (entries as unknown[]).filter((entry) => !current.some((item) => stable(item) === stable(entry)));
    hooks[event] = [...current, ...additions];
  }
  const merged = { ...fragment, ...existing };
  if (Object.keys(hooks).length) merged.hooks = hooks;
  return merged;
}

async function readJson(path: string): Promise<Json> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    validateDocument(parsed, path);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error(`${path}: invalid JSON: ${error.message}`);
    throw error;
  }
}

async function mergeFile(path: string, fragment: Json): Promise<void> {
  const existing = await readJson(path);
  const merged = mergeHookFragment(existing, fragment);
  if (stable(existing) === stable(merged)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`);
}

function containsGateHook(value: unknown): boolean {
  if (typeof value === "string") return value.includes("complexity-gate hook ");
  if (Array.isArray(value)) return value.some(containsGateHook);
  return isPlainObject(value) && Object.values(value).some(containsGateHook);
}

async function hasGateHook(path: string): Promise<boolean> {
  try {
    return containsGateHook(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return false;
  }
}

async function hasGrokCompatibleHook(home: string, harnesses: Harness[]): Promise<boolean> {
  if (harnesses.includes("claude") || harnesses.includes("cursor")) return true;
  return await hasGateHook(join(home, ".claude", "settings.json"))
    || await hasGateHook(join(home, ".cursor", "hooks.json"));
}

async function executable(name: string): Promise<boolean> {
  const paths = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const path of paths) {
    try { await access(join(path, name), constants.X_OK); return true; } catch {}
  }
  return false;
}

export function spawnPi(command: string, platform = process.platform, spawnProcess = spawn): ReturnType<typeof spawn> {
  const args = ["install", "npm:@pickforge/complexity-gate"];
  return platform === "win32"
    ? spawnProcess("cmd.exe", ["/d", "/s", "/c", command, ...args], { stdio: "inherit" })
    : spawnProcess(command, args, { stdio: "inherit" });
}

export function spawnOmp(command: string, platform = process.platform, spawnProcess = spawn): ReturnType<typeof spawn> {
  const args = ["plugin", "install", "npm:@pickforge/complexity-gate"];
  return platform === "win32"
    ? spawnProcess("cmd.exe", ["/d", "/s", "/c", command, ...args], { stdio: "inherit" })
    : spawnProcess(command, args, { stdio: "inherit" });
}

export function spawnOpenCode(command: string, platform = process.platform, spawnProcess = spawn): ReturnType<typeof spawn> {
  const args = ["plugin", "@pickforge/complexity-gate", "--global"];
  return platform === "win32"
    ? spawnProcess("cmd.exe", ["/d", "/s", "/c", command, ...args], { stdio: "inherit" })
    : spawnProcess(command, args, { stdio: "inherit" });
}

async function runPi(): Promise<void> {
  const command = process.platform === "win32" ? "pi.cmd" : "pi";
  if (!(await executable(command))) {
    console.log("pi install npm:@pickforge/complexity-gate");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawnPi(command);
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`pi install exited ${code}`)));
  });
}

async function runOmp(): Promise<void> {
  const command = process.platform === "win32" ? "omp.cmd" : "omp";
  if (!(await executable(command))) {
    console.log("omp plugin install npm:@pickforge/complexity-gate");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawnOmp(command);
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`omp plugin install exited ${code}`)));
  });
}

async function runOpenCode(): Promise<void> {
  const command = process.platform === "win32" ? "opencode.cmd" : "opencode";
  if (!(await executable(command))) {
    console.log("opencode plugin @pickforge/complexity-gate --global");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawnOpenCode(command);
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`opencode plugin exited ${code}`)));
  });
}

export function parseArgs(argv: string[]): { harnesses: Harness[]; print: boolean; home: string } {
  let home = homedir();
  let print = false;
  const harnesses: Harness[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--print") print = true;
    else if (arg === "--all") harnesses.push(...harnessNames);
    else if (arg === "--home" && argv[index + 1]) home = argv[index += 1]!;
    else if (arg === "--harness" && argv[index + 1]) {
      harnesses.push(...argv[index += 1]!.split(",").map((value) => value.trim()).filter(Boolean) as Harness[]);
    } else throw new Error(`unknown or incomplete option: ${arg}`);
  }
  const unique = [...new Set(harnesses)];
  if (unique.some((value) => !harnessNames.includes(value))) {
    throw new Error(`--harness expects ${harnessNames.join(",")}`);
  }
  return { harnesses: unique, print, home };
}

export function parseHarnessSelection(answer: string): Harness[] {
  const selection = answer.trim().toLowerCase();
  if (selection === "none" || selection === "") return [];
  if (selection === "all") return [...harnessNames];
  return parseArgs(["--harness", selection]).harnesses;
}

async function promptHarnesses(): Promise<Harness[]> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await input.question(`Install hooks/plugins for harnesses (${harnessNames.join(",")}; comma-separated, all, or none): `);
  input.close();
  return parseHarnessSelection(answer);
}

function printHarness(harness: Harness): void {
  if (harness === "pi") console.log("pi install npm:@pickforge/complexity-gate");
  else if (harness === "omp") console.log("omp plugin install npm:@pickforge/complexity-gate");
  else if (harness === "opencode") console.log("opencode plugin @pickforge/complexity-gate --global");
  else console.log(JSON.stringify(hookFragments[harness], null, 2));
}

async function installHarnesses(harnesses: Harness[], home: string): Promise<void> {
  if (harnesses.includes("claude")) await mergeFile(join(home, ".claude", "settings.json"), hookFragments.claude);
  if (harnesses.includes("codex")) await mergeFile(join(home, ".codex", "hooks.json"), hookFragments.codex);
  if (harnesses.includes("pi")) await runPi();
  if (harnesses.includes("omp")) await runOmp();
  if (harnesses.includes("grok")) {
    if (await hasGrokCompatibleHook(home, harnesses)) {
      console.log("grok: using the installed Claude Code or Cursor complexity-gate hooks");
    } else {
      await mergeFile(join(home, ".grok", "hooks", "complexity-gate.json"), hookFragments.grok);
    }
  }
  if (harnesses.includes("cursor")) await mergeFile(join(home, ".cursor", "hooks.json"), hookFragments.cursor);
  if (harnesses.includes("opencode")) await runOpenCode();
}

export async function install(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const harnesses = options.harnesses.length ? options.harnesses : await promptHarnesses();
  if (options.print) {
    harnesses.forEach(printHarness);
    return;
  }
  await installHarnesses(harnesses, options.home);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) install().catch((error) => { console.error(`complexity-gate-install: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; });
