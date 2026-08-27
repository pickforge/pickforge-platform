import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function execute(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(file, args, { env });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("exit", (code) => resolveResult({ code, stdout }));
  });
}

describe("binary forwarding", () => {
  it("prefers COMPLEXITY_GATE_BIN and forwards argv and exit code", async () => {
    const root = await mkdtemp(join(tmpdir(), "complexity-bin-"));
    roots.push(root);
    const binary = join(root, "gate");
    await writeFile(binary, "#!/bin/sh\nprintf '%s' \"$*\"\nexit 7\n");
    await chmod(binary, 0o755);
    const result = await execute(process.execPath, [resolve("packages/complexity-gate/bin/complexity-gate"), "check", "a.ts"], { ...process.env, COMPLEXITY_GATE_BIN: binary });
    expect(result).toEqual({ code: 7, stdout: "check a.ts" });
  });
});
