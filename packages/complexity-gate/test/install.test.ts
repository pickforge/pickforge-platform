import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hookFragments, install, mergeHookFragment } from "../src/install.ts";

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
