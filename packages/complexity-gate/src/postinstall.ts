import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const targets: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export type DownloadOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  tag?: string;
  vendorDir: string;
  fetchImpl?: typeof fetch;
};

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)));
  });
}

async function body(response: Response, url: string): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function expectedChecksum(text: string, archive: string): string {
  const line = text.split("\n").find((value) => value.trim().endsWith(archive));
  const checksum = line?.trim().split(/\s+/)[0];
  if (!checksum || !/^[a-f\d]{64}$/i.test(checksum)) throw new Error(`checksum missing for ${archive}`);
  return checksum.toLowerCase();
}

async function extract(archivePath: string, outputDir: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${outputDir.replaceAll("'", "''")}' -Force`]);
    return;
  }
  await run("tar", ["-xJf", archivePath, "-C", outputDir]);
}

export async function downloadBinary(options: DownloadOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const target = targets[`${platform}-${options.arch ?? process.arch}`];
  if (!target) throw new Error(`unsupported platform: ${platform}/${options.arch ?? process.arch}`);
  const tag = options.tag ?? process.env.COMPLEXITY_GATE_VERSION ?? "v0.2.0";
  const extension = platform === "win32" ? "zip" : "tar.xz";
  const archive = `complexity-gate-${target}.${extension}`;
  const base = `https://github.com/pickforge/complexity-gate/releases/download/${tag}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const [archiveBytes, sumsBytes] = await Promise.all([
    fetchImpl(`${base}/${archive}`).then((response) => body(response, archive)),
    fetchImpl(`${base}/sha256.sum`).then((response) => body(response, "sha256.sum")),
  ]);
  const expected = expectedChecksum(new TextDecoder().decode(sumsBytes), archive);
  const actual = createHash("sha256").update(archiveBytes).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${archive}`);
  const temp = await mkdtemp(join(tmpdir(), "complexity-gate-"));
  try {
    const archivePath = join(temp, archive);
    await writeFile(archivePath, archiveBytes);
    await extract(archivePath, temp, platform);
    const binaryName = platform === "win32" ? "complexity-gate.exe" : "complexity-gate";
    // cargo-dist archives unpack into a directory named after the archive stem.
    const source = join(temp, `complexity-gate-${target}`, binaryName);
    await mkdir(options.vendorDir, { recursive: true });
    const destination = join(options.vendorDir, binaryName);
    // copy, not rename: the temp dir may live on another filesystem (EXDEV).
    await copyFile(source, destination);
    if (platform !== "win32") await chmod(destination, 0o755);
    return destination;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function postinstall(): Promise<void> {
  if (process.env.COMPLEXITY_GATE_BIN) {
    console.warn("complexity-gate: COMPLEXITY_GATE_BIN is set; skipping binary download");
    return;
  }
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    await downloadBinary({ vendorDir: join(packageRoot, "vendor") });
  } catch (error) {
    console.warn(`complexity-gate: binary download skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (basename(process.argv[1] ?? "") === "postinstall.js") await postinstall();
