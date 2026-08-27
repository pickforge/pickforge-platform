import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hookFragments, install, mergeHookFragment, spawnPi } from "../src/install.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("hook installation", () => {
  it("preserves hooks and is idempotent", () => {
    const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] }, other: true };
    const once = mergeHookFragment(existing, hookFragments.claude);
    expect(mergeHookFragment(once, hookFragments.claude)).toEqual(once);
    expect(once.other).toBe(true);
    expect((once.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);
  });

  it("writes the same file only once", async () => {
    const home = await mkdtemp(join(tmpdir(), "complexity-install-"));
    roots.push(home);
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude", "settings.json"), "{\"theme\":\"dark\"}\n");
    await install(["--harness", "claude", "--home", home]);
    const once = await readFile(join(home, ".claude", "settings.json"), "utf8");
    await install(["--harness", "claude", "--home", home]);
    expect(await readFile(join(home, ".claude", "settings.json"), "utf8")).toBe(once);
    expect(JSON.parse(once).theme).toBe("dark");
  });

  it.each(["[]", "42", '{"hooks":"invalid"}', '{"hooks":{"Stop":"x"}}'])("rejects invalid settings without changing %s", async (contents) => {
    const home = await mkdtemp(join(tmpdir(), "complexity-invalid-"));
    roots.push(home);
    const path = join(home, ".claude", "settings.json");
    await mkdir(join(home, ".claude"));
    await writeFile(path, contents);
    const result = spawnSync(process.execPath, [resolve("packages/complexity-gate/src/install.ts"), "--harness", "claude", "--home", home], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(path);
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("preserves unrelated keys and hooks", async () => {
    const home = await mkdtemp(join(tmpdir(), "complexity-preserve-"));
    roots.push(home);
    const path = join(home, ".claude", "settings.json");
    const existing = { theme: "dark", hooks: { Custom: [{ command: "keep" }], Stop: [{ hooks: [{ command: "other" }] }] } };
    await mkdir(join(home, ".claude"));
    await writeFile(path, JSON.stringify(existing));
    await install(["--harness", "claude", "--home", home]);
    const installed = JSON.parse(await readFile(path, "utf8"));
    expect(installed.theme).toBe(existing.theme);
    expect(installed.hooks.Custom).toEqual(existing.hooks.Custom);
    expect(installed.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
  });

  it("runs pi.cmd through cmd.exe on Windows", async () => {
    const spawn = vi.fn();
    spawnPi("pi.cmd", "win32", spawn as never);
    expect(spawn).toHaveBeenCalledWith("cmd.exe", ["/d", "/s", "/c", "pi.cmd", "install", "npm:@pickforge/complexity-gate"], { stdio: "inherit" });
  });

  it("prints fragments without writing", async () => {
    const home = await mkdtemp(join(tmpdir(), "complexity-print-"));
    roots.push(home);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await install(["--print", "--all", "--home", home]);
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.flat().join("\n")).toContain("complexity-gate hook codex");
    await expect(readFile(join(home, ".claude", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    log.mockRestore();
  });
});
