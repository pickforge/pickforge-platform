import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { Readable } from "node:stream";
import {
  createExecFileAdapter,
  openInBrowser,
  resolveRepository,
  sourceFromArgument,
} from "./cli-support.ts";
import { createConnectorRegistry, type ConnectorRegistry } from "./connectors/registry.ts";
import type { ExecFile } from "./inputs.ts";
import { defaultSkillPath } from "./paths.ts";
import type { SourceRequest } from "./protocol.ts";
import { startReviewTutorServer, type StartedReviewTutorServer } from "./server.ts";

export const USAGE = [
  "Usage: review-tutor [source] [--no-open] [--detach] [--home <dir>]",
  "",
  "  source     worktree (default), staged, <revision>, <from>...<to>, or a GitHub PR URL",
  "  --no-open  print the URL without opening a browser",
  "  --detach   leave the server running in the background and return immediately",
  "  --home     store Review Tutor state under this absolute directory",
].join("\n");

/** A detached server with no page attached for this long has been abandoned. */
export const IDLE_EXIT_MS = 30 * 60_000;
const IDLE_CHECK_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

export class UsageError extends Error {}

export interface CliOptions {
  source?: SourceRequest;
  open: boolean;
  detach: boolean;
  serveDetached: boolean;
  help: boolean;
  home?: string;
}

export interface DetachedChild {
  readonly stdout: Readable | null;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  unref(): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CliDeps {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd(): string;
  execFile: ExecFile;
  createRegistry(): ConnectorRegistry;
  startServer(options: Parameters<typeof startReviewTutorServer>[0]): Promise<StartedReviewTutorServer>;
  openInBrowser(url: string): Promise<boolean>;
  signals(handler: () => void): void;
  spawnDetached(args: string[]): DetachedChild;
}

function applyFlag(options: CliOptions, argv: readonly string[], index: number): number {
  const flag = argv[index]!;
  if (flag === "--no-open") options.open = false;
  else if (flag === "--detach") options.detach = true;
  else if (flag === "--serve-detached") options.serveDetached = true;
  else if (flag === "--help" || flag === "-h") options.help = true;
  else if (flag === "--home") {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new UsageError("--home requires an absolute directory path");
    }
    options.home = value;
    return index + 1;
  } else throw new UsageError(`unknown option ${flag}`);
  return index;
}

export function parseArguments(argv: readonly string[]): CliOptions {
  const options: CliOptions = { open: true, detach: false, serveDetached: false, help: false };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument.startsWith("-")) index = applyFlag(options, argv, index);
    else positional.push(argument);
  }
  if (positional.length > 1) throw new UsageError(`unexpected argument ${positional[1]!}`);
  options.source = sourceFromArgument(positional[0] ?? "worktree");
  return options;
}

/**
 * Zero clients for one whole window. A page that connects and leaves entirely
 * between two polls still shows up as a new connection generation, so it
 * restarts the window instead of being missed.
 */
export class IdleTracker {
  private idleSince: number | undefined;
  private generation: number | undefined;

  constructor(private readonly windowMs = IDLE_EXIT_MS) {}

  expired(clientCount: number, generation: number, now: number): boolean {
    const moved = this.generation !== undefined && generation !== this.generation;
    this.generation = generation;
    if (clientCount > 0 || moved) {
      this.idleSince = undefined;
      return false;
    }
    this.idleSince ??= now;
    return now - this.idleSince >= this.windowMs;
  }
}

function waitForIdle(server: StartedReviewTutorServer): Promise<void> {
  return new Promise((resolve) => {
    const tracker = new IdleTracker();
    const timer = setInterval(() => {
      if (!tracker.expired(server.clientCount(), server.connectionGeneration(), Date.now())) return;
      clearInterval(timer);
      resolve();
    }, IDLE_CHECK_MS);
    timer.unref?.();
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function discoverySummary(registry: ConnectorRegistry): Promise<string> {
  const discoveries = await registry.discoveries();
  return discoveries.map(({ connector, discovery }) => discovery.available
    ? `${connector.label}: ${discovery.models.length} model${discovery.models.length === 1 ? "" : "s"}`
    : `${connector.label} unavailable: ${discovery.reason}`).join("\n");
}

/** The startup summary and the server must share one discovery pass so no harness is probed twice. */
function memoizeDiscoveries(registry: ConnectorRegistry): ConnectorRegistry {
  let cached: ReturnType<ConnectorRegistry["discoveries"]> | undefined;
  return { ...registry, discoveries: () => (cached ??= registry.discoveries()) };
}

async function runServer(options: CliOptions, deps: CliDeps): Promise<number> {
  const cwd = await realpath(deps.cwd());
  const canonicalRepo = await resolveRepository(cwd, deps.execFile);
  const registry = memoizeDiscoveries(deps.createRegistry());
  const server = await deps.startServer({
    cwd,
    canonicalRepo,
    registry,
    execFile: deps.execFile,
    skillPath: defaultSkillPath(),
    ...(options.source ? { initialSource: options.source } : {}),
    ...(options.home ? { home: options.home } : {}),
  });
  // Armed before the browser call so a signal during that call still shuts the server down once.
  const stopped = Promise.race([
    new Promise<void>((resolve) => deps.signals(resolve)),
    ...(options.serveDetached ? [waitForIdle(server)] : []),
  ]);
  deps.stderr(`${await discoverySummary(registry)}\n`);
  deps.stdout(`${server.url}\n`);
  if (options.open && !options.serveDetached && !await deps.openInBrowser(server.url)) {
    deps.stderr("Could not open a browser. Open the URL above.\n");
  }
  await stopped;
  await server.close();
  return 0;
}

function readUrlLine(child: DetachedChild, timeoutMs: number): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) {
    return Promise.reject(new Error(
      "detached start failed: expected a pipe on the detached server's stdout; retry without --detach",
    ));
  }
  return new Promise((resolve, reject) => {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout>;
    const onData = (chunk: unknown): void => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      stdout.off("data", onData);
      resolve(buffer.slice(0, newline));
    };
    const fail = (reason: string): void => {
      clearTimeout(timer);
      stdout.off("data", onData);
      stdout.destroy();
      child.unref();
      reject(new Error(reason));
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(`detached start failed: expected a URL within ${timeoutMs / 1000} seconds, received none; retry without --detach`);
    }, timeoutMs);
    stdout.on("data", onData);
    child.once("error", () => fail("detached start failed: the detached server could not be started; retry without --detach"));
    child.once("exit", () => fail("detached start failed: the detached server exited before reporting a URL; retry without --detach"));
  });
}

async function runDetachedParent(
  argv: readonly string[],
  options: CliOptions,
  deps: CliDeps,
): Promise<number> {
  const child = deps.spawnDetached(["--serve-detached", ...argv]);
  const url = await readUrlLine(child, HANDSHAKE_TIMEOUT_MS);
  child.stdout?.destroy();
  child.unref();
  deps.stdout(`${url}\n`);
  if (options.open && !await deps.openInBrowser(url)) {
    deps.stderr("Could not open a browser. Open the URL above.\n");
  }
  return 0;
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(argv);
  } catch (error) {
    deps.stderr(`review-tutor: ${message(error)}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    deps.stdout(`${USAGE}\n`);
    return 0;
  }
  try {
    return options.detach && !options.serveDetached
      ? await runDetachedParent(argv, options, deps)
      : await runServer(options, deps);
  } catch (error) {
    deps.stderr(`review-tutor failed: ${message(error)}\n`);
    return 1;
  }
}

export function nodeCliDeps(scriptPath: string): CliDeps {
  const execFile = createExecFileAdapter();
  return {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    cwd: () => process.cwd(),
    execFile,
    createRegistry: () => createConnectorRegistry({}),
    startServer: startReviewTutorServer,
    openInBrowser: (url) => openInBrowser(url, process.platform, execFile),
    signals: (handler) => {
      process.once("SIGINT", handler);
      process.once("SIGTERM", handler);
    },
    spawnDetached: (args) => spawn(process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  };
}
