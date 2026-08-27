#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export type Harness = "claude" | "codex" | "pi";
type Json = Record<string, unknown>;

export const hookFragments: Record<Exclude<Harness, "pi">, Json> = {
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
};

function stable(value: unknown): string { return JSON.stringify(value); }

export function mergeHookFragment(existing: Json, fragment: Json): Json {
  const currentHooks = (existing.hooks ?? {}) as Json;
  const incomingHooks = (fragment.hooks ?? {}) as Json;
  const hooks: Json = { ...currentHooks };
  for (const [event, entries] of Object.entries(incomingHooks)) {
    const current = Array.isArray(currentHooks[event]) ? currentHooks[event] as unknown[] : [];
    const additions = (entries as unknown[]).filter((entry) => !current.some((item) => stable(item) === stable(entry)));
    hooks[event] = [...current, ...additions];
  }
  return { ...existing, hooks };
}

async function readJson(path: string): Promise<Json> {
  try { return JSON.parse(await readFile(path, "utf8")) as Json; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
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

async function executable(name: string): Promise<boolean> {
  const paths = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const path of paths) {
    try { await access(join(path, name), constants.X_OK); return true; } catch {}
  }
  return false;
}

async function runPi(): Promise<void> {
  const command = "pi install npm:@pickforge/complexity-gate";
  if (!(await executable(process.platform === "win32" ? "pi.cmd" : "pi"))) {
    console.log(command);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pi", ["install", "npm:@pickforge/complexity-gate"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`pi install exited ${code}`)));
  });
}

export function parseArgs(argv: string[]): { harnesses: Harness[]; print: boolean; home: string } {
  let home = homedir();
  let print = false;
  const harnesses: Harness[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--print") print = true;
    else if (arg === "--all") harnesses.push("claude", "codex", "pi");
    else if (arg === "--home" && argv[index + 1]) home = argv[index += 1]!;
    else if (arg === "--harness" && argv[index + 1]) harnesses.push(...argv[index += 1]!.split(",") as Harness[]);
    else throw new Error(`unknown or incomplete option: ${arg}`);
  }
  const unique = [...new Set(harnesses)];
  if (unique.some((value) => !["claude", "codex", "pi"].includes(value))) throw new Error("--harness expects claude,codex,pi");
  return { harnesses: unique, print, home };
}

async function promptHarnesses(): Promise<Harness[]> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await input.question("Install for harnesses (claude,codex,pi; comma-separated): ");
  input.close();
  return parseArgs(["--harness", answer]).harnesses;
}

export async function install(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const harnesses = options.harnesses.length ? options.harnesses : await promptHarnesses();
  if (options.print) {
    for (const harness of harnesses) console.log(harness === "pi" ? "pi install npm:@pickforge/complexity-gate" : JSON.stringify(hookFragments[harness], null, 2));
    return;
  }
  if (harnesses.includes("claude")) await mergeFile(join(options.home, ".claude", "settings.json"), hookFragments.claude);
  if (harnesses.includes("codex")) await mergeFile(join(options.home, ".codex", "hooks.json"), hookFragments.codex);
  if (harnesses.includes("pi")) await runPi();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) install().catch((error) => { console.error(`complexity-gate-install: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; });
