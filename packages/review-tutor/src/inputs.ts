import { createHash, randomUUID } from "node:crypto";
import type { InputSnapshot, SourceRequest } from "./protocol.ts";
import { LIMITS, validateSourceRequest } from "./protocol.ts";

export type ExecFile = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    maxBuffer: number;
    encoding: "utf8";
    signal?: AbortSignal;
  },
) => Promise<{ stdout: string; stderr: string }>;

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/~^{}@+-]{0,255}$/;

function revision(value: string): string {
  if (value.startsWith("-") || !REVISION.test(value)) {
    throw new Error(
      `revision validation failed: expected a bounded Git revision without option syntax, received '${value}'; provide a commit or ref name`,
    );
  }
  return value;
}

function prUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "PR URL validation failed: expected a GitHub pull-request URL; paste its full URL",
    );
  }

  const exactPath = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/;
  if (
    url.protocol !== "https:"
    || url.hostname !== "github.com"
    || url.username
    || url.password
    || url.port
    || /^https:\/\/github\.com:\d+(?:\/|$)/i.test(value)
    || url.search
    || url.hash
    || !exactPath.test(url.pathname)
  ) {
    throw new Error(
      "PR URL validation failed: expected an exact https://github.com/owner/repo/pull/number URL; correct it and retry",
    );
  }
  return url;
}

async function run(
  exec: ExecFile,
  file: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  let result: Awaited<ReturnType<ExecFile>>;
  try {
    result = await exec(file, args, {
      cwd,
      maxBuffer: LIMITS.source + LIMITS.stderr,
      encoding: "utf8",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const failure = error as { code?: string; message?: string; stderr?: string };
    if (
      failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      && /stdout maxBuffer/i.test(failure.message ?? "")
    ) {
      throw new Error(
        `source content failed: expected at most ${LIMITS.source} bytes, received more than ${LIMITS.source + LIMITS.stderr}; narrow the source and retry`,
      );
    }
    const tail = (failure.stderr ?? "").slice(-LIMITS.stderr);
    throw new Error(
      `source command failed: expected ${file} ${args.join(" ")} to succeed; ${failure.message ?? String(error)}${tail ? `; stderr tail: ${tail}` : ""}; verify the source and authentication, then retry`,
    );
  }

  const bytes = Buffer.byteLength(result.stdout);
  if (bytes > LIMITS.source) {
    throw new Error(
      `source content failed: expected at most ${LIMITS.source} bytes, received ${bytes}; narrow the source and retry`,
    );
  }
  return result.stdout;
}

function snapshot(
  kind: SourceRequest["kind"],
  label: string,
  content: string,
  extra: Partial<InputSnapshot> = {},
): InputSnapshot {
  const bytes = Buffer.from(content);
  if (bytes.length > LIMITS.source) {
    throw new Error(
      `source content failed: expected at most ${LIMITS.source} bytes, received ${bytes.length}; narrow it and retry`,
    );
  }
  return {
    id: randomUUID(),
    kind,
    label,
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.length,
    content,
    ...extra,
  };
}

export async function loadInput(
  raw: SourceRequest,
  cwd: string,
  exec: ExecFile,
  signal?: AbortSignal,
): Promise<InputSnapshot> {
  const request = validateSourceRequest(raw);
  if (request.kind === "paste") {
    return snapshot("paste", request.label ?? "Pasted code", request.content);
  }
  if (request.kind === "worktree") {
    return snapshot(
      "worktree",
      "Local worktree diff",
      await run(
        exec,
        "git",
        ["diff", "--no-ext-diff", "--no-color", "--"],
        cwd,
        signal,
      ),
    );
  }
  if (request.kind === "staged") {
    return snapshot(
      "staged",
      "Staged diff",
      await run(
        exec,
        "git",
        ["diff", "--cached", "--no-ext-diff", "--no-color", "--"],
        cwd,
        signal,
      ),
    );
  }
  if (request.kind === "commit") {
    const rev = revision(request.revision);
    return snapshot(
      "commit",
      `Commit ${rev}`,
      await run(
        exec,
        "git",
        ["show", "--no-ext-diff", "--no-color", "--format=fuller", rev, "--"],
        cwd,
        signal,
      ),
    );
  }
  if (request.kind === "range") {
    const from = revision(request.from);
    const to = revision(request.to);
    return snapshot(
      "range",
      `${from}...${to}`,
      await run(
        exec,
        "git",
        ["diff", "--no-ext-diff", "--no-color", `${from}...${to}`, "--"],
        cwd,
        signal,
      ),
    );
  }

  const pr = request as Extract<SourceRequest, { kind: "pr" }>;
  const url = prUrl(pr.url).toString().replace(/\/$/, "");
  const viewArgs = ["pr", "view", url, "--json", "number,title,url,headRefOid,author"];
  const before = JSON.parse(await run(exec, "gh", viewArgs, cwd, signal)) as {
    number: number;
    title: string;
    url: string;
    headRefOid: string;
    author: { login: string };
  };
  const content = await run(
    exec,
    "gh",
    ["pr", "diff", url, "--patch"],
    cwd,
    signal,
  );
  const after = JSON.parse(
    await run(exec, "gh", viewArgs, cwd, signal),
  ) as typeof before;
  if (before.headRefOid !== after.headRefOid) {
    throw new Error(
      `PR source failed: expected head ${before.headRefOid} to remain stable, received ${after.headRefOid}; the PR head changed, retry to load one exact revision`,
    );
  }
  return snapshot(
    "pr",
    `#${before.number} ${before.title} by ${before.author.login}`,
    content,
    {
      githubUrl: `${before.url}/commits/${before.headRefOid}`,
      headSha: before.headRefOid,
    },
  );
}
