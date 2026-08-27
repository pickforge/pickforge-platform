import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBinary, postinstall } from "../src/postinstall.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("binary downloader", () => {
  it("vendors the binary from the cargo-dist archive directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "complexity-archive-"));
    roots.push(root);
    const stem = "complexity-gate-x86_64-unknown-linux-gnu";
    await mkdir(join(root, stem));
    await writeFile(join(root, stem, "complexity-gate"), "#!/bin/sh\necho fake\n");
    await chmod(join(root, stem, "complexity-gate"), 0o755);
    await promisify(execFile)("tar", ["-cJf", join(root, `${stem}.tar.xz`), "-C", root, stem]);
    const archive = await readFile(join(root, `${stem}.tar.xz`));
    const checksum = createHash("sha256").update(archive).digest("hex");
    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith("sha256.sum")
      ? `${checksum} *${stem}.tar.xz\n`
      : new Uint8Array(archive)));
    const vendorDir = join(root, "vendor");
    const destination = await downloadBinary({ vendorDir, platform: "linux", arch: "x64", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(destination).toBe(join(vendorDir, "complexity-gate"));
    expect((await stat(destination)).mode & 0o111).not.toBe(0);
  });


  it("uses the configurable cargo-dist asset name with fake fetch", async () => {
    const vendorDir = await mkdtemp(join(tmpdir(), "complexity-download-"));
    roots.push(vendorDir);
    const archive = new TextEncoder().encode("not an archive");
    const checksum = createHash("sha256").update(archive).digest("hex");
    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith("sha256.sum")
      ? `${checksum}  complexity-gate-x86_64-unknown-linux-gnu.tar.xz\n`
      : archive));
    await expect(downloadBinary({ vendorDir, platform: "linux", arch: "x64", tag: "v9.8.7", fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow("tar exited");
    expect(fetchImpl.mock.calls[0]![0]).toContain("/v9.8.7/complexity-gate-x86_64-unknown-linux-gnu.tar.xz");
  });

  it("rejects a checksum mismatch before extraction", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith("sha256.sum")
      ? `${"0".repeat(64)}  complexity-gate-x86_64-unknown-linux-gnu.tar.xz\n`
      : "archive"));
    await expect(downloadBinary({ vendorDir: "/unused", platform: "linux", arch: "x64", fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow("checksum mismatch");
  });

  it("skips download when the binary override is set", async () => {
    const previous = process.env.COMPLEXITY_GATE_BIN;
    process.env.COMPLEXITY_GATE_BIN = "/custom/gate";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await postinstall();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipping binary download"));
    warn.mockRestore();
    if (previous === undefined) delete process.env.COMPLEXITY_GATE_BIN; else process.env.COMPLEXITY_GATE_BIN = previous;
  });
});
