# pi-kit lanes

pi-kit runs asynchronous model lanes behind a shared `LaneCoordinator`. The coordinator owns one active run, validation, status, wait detachment, abandonment, shutdown, and JSON-safe snapshots. `LaneRunner` owns adapter selection, detached child process groups, concurrency, normalized events, journaling, transcript capture, SIGTERM-to-SIGKILL escalation, and reaping. Pi keeps presentation, widgets, nudges, and commands in `extensions/lanes.ts`.

## Origins, routes, and policy

Callers select a logical model, effort, and task; route and runtime model IDs come only from [`src/table.ts`](src/table.ts). Every lane requires an explicit full model selector and effort. `max` is invalid and `xhigh` is the ceiling. Grok is pinned to `high`; Opus is pinned to `xhigh`.

Pi-origin lanes accept every table model. Fable, Sonnet, and Opus run through the genuine Claude Code executable. Sol, `xai/grok-4.5` at `high`, and GLM run through Pi directly; Grok does not use the Grok CLI. MCP-origin lanes run Sol, Grok, and GLM through Pi and reject Anthropic selectors because Claude Code must use its native Claude-to-Claude workflow.

Pi callers may omit `mode`, which defaults to `workspace-write`; MCP callers must explicitly choose `read-only` or `workspace-write`. Read-only Pi workers receive only `read,grep,find,ls`; read-only Claude workers receive only `Read,Glob,Grep`. Workspace-write workers receive the normal tools of their harness: Pi keeps its normal tool set, while Claude receives `Read,Glob,Grep,Edit,Write,Bash`. Existing parent-session plan, local, and ship gates are separate and unchanged.

Routes fail rather than substitute when a selector, effort, origin, executable, version, or authentication path is unavailable. Claude executable preflight requires a real executable file, rejects wrappers containing permission-bypass flags, and requires Claude Code 2.1.216 or newer. It does not read or copy OAuth credentials; authentication remains the genuine CLI's responsibility.

## Child boundary

Children receive a scrubbed environment containing only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TMP`, `TEMP`, locale variables (`LANG`, `LANGUAGE`, and supported `LC_*` keys), terminal variables (`TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`), and supported `XDG_*` paths. Pi children additionally receive `PIKIT_CHILD=1`. Provider keys, cloud credentials, cookies, and agent sockets are not inherited.

Lane IDs must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Transcript paths are resolved beneath the configured run directory and rejected if they escape it. Commands use fixed argument arrays rather than shell interpolation, and task text is passed as a positional literal.

## Lane tools

Pi and the session-local stdio MCP server expose exactly four operations:

- `lanes_spawn` starts one run non-blockingly and rejects another spawn while it remains active.
- `lanes_status` returns the current run without blocking; an optional lane ID selects one lane.
- `lanes_wait` waits for settlement; cancelling the wait detaches the caller without cancelling lanes.
- `lanes_abandon` stops one named lane or all lanes with an optional reason.

Pi and MCP handlers contain exceptions and return tool errors instead of throwing into the parent session. Error text is whitespace-normalized, bounded, and text-only. Status, wait, or abandon before spawn is an error. Lanes survive turn cancellation, but session shutdown abandons active work, sends SIGTERM, escalates to SIGKILL after five seconds, and waits for child `close`.

## MCP wire DTO

Every successful MCP call returns concise text in `content` and this JSON-safe shape in `structuredContent`; optional fields are omitted when absent:

```ts
interface LaneSnapshotDto {
  lane: string;
  model: string;
  effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  mode: "read-only" | "workspace-write";
  state: "queued" | "running" | "done" | "failed" | "abandoned";
  currentTool?: string;
  lastStatus?: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  context: number;
  answer?: string;
  durationMs?: number;
  abandonReason?: string;
}

interface RunSnapshotDto {
  run: string;
  state: "active" | "ended";
  ok?: boolean;
  totals: {
    cost: number;
    tokensIn: number;
    tokensOut: number;
  };
  lanes: LaneSnapshotDto[];
}
```

The DTO deliberately excludes task text, cwd, rationale, PID, origin, and timestamps. Every numeric field is normalized with `Number.isFinite(value) ? value : 0`. Failures return bounded text with `isError: true` and no `structuredContent`.

## Stdio invocation

From the repository root:

```sh
bun packages/pi-kit/mcp/server.ts
```

From `packages/pi-kit`:

```sh
bun run mcp
```

Stdout is reserved for protocol traffic; diagnostics use stderr. Closing stdin triggers coordinated shutdown and must not leave child process groups running.

## Journals, transcripts, and stream limits

Run journals are append-only JSONL at `~/.pickforge/pi-kit/runs/<run>.jsonl`; canonical per-lane transcripts are at `~/.pickforge/pi-kit/raw/<run>/<lane>.jsonl`. Set `PIKIT_DATA_DIR` to move both roots. Journal and transcript writes are best-effort and never determine lane settlement or crash the parent.

Canonical transcript events are `task`, `thinking_delta`, `text_delta`, `tool_start`, `tool_end`, cumulative `usage`, and `assistant_end`. `LaneTranscript` also reads archived Pi JSONL. Canonical transcript capture is capped at 4 MiB per lane, and child stdout over 4 MiB fails the lane. Stored final answers are capped at 4,000 characters; rendered text/thinking entries at 20,000 characters and tool inputs/results at 4,000 characters. Parser and spawn failures become failed lanes; missing routes fail before child spawn.

## Validation

These checks are synthetic and do not invoke a model:

```sh
bun test packages/pi-kit/test
bun run typecheck
bun packages/pi-kit/mcp/server.ts </dev/null
pi --list-models grok
claude --version
```

Provider-backed smoke tests are billable and require approval for the exact prompts and usage. The smoke matrix is Pi to an Anthropic lane and MCP to Sol, Grok, and GLM with minimal read-only prompts. Each must prove the requested route, one terminal journaled lane, and no orphan child; fallback is failure.

Deployment remains a separate prerequisite-gated change. Do not register the MCP server until this runtime is reviewed and merged, the reviewed commit is checked out at `$HOME/Projects/Pickforge/pickforge-platform`, frozen dependencies are installed there, and the deployed SHA is recorded.
