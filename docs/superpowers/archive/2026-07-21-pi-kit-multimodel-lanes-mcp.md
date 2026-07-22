pi-kit extracted to ElbertePlinio/pi-kit per issue #54.

# pi-kit Multi-Model Lanes MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pi-kit's lane runtime provider-aware and expose its cross-provider operations to Claude Code through a session-local stdio MCP server while preserving Pi's current UX.

**Architecture:** Keep `LaneRunner` as the deep process-owning module, add a real execution-adapter seam for Pi and Claude Code, and extract a harness-neutral `LaneCoordinator`. Pi and MCP become thin adapters over the same coordinator. Logical model selectors remain stable; route metadata lives in the model table.

**Tech Stack:** TypeScript, Bun, Vitest, `@modelcontextprotocol/sdk` 1.29.0, Zod, Pi extension API, Claude Code 2.1.216 CLI.

**Spec:** `docs/superpowers/specs/2026-07-21-cross-harness-multimodel-lanes-design.md`

---

## File map

### Create

- `packages/pi-kit/src/execution-adapter.ts` — normalized events, process plans, parser and asynchronous adapter interfaces.
- `packages/pi-kit/src/adapters/pi.ts` — Pi command construction and JSON stream normalization.
- `packages/pi-kit/src/child-env.ts` — minimal child-environment allowlist.
- `packages/pi-kit/src/adapters/claude-code.ts` — genuine Claude Code command construction, asynchronous preflight, and stream normalization.
- `packages/pi-kit/src/lane-coordinator.ts` — one-active-run lifecycle and JSON-safe snapshots.
- `packages/pi-kit/mcp/create-server.ts` — testable MCP server factory and tool registration.
- `packages/pi-kit/mcp/server.ts` — stdio entrypoint and shutdown handling.
- `packages/pi-kit/test/execution-adapters.test.ts` — route resolution and mode command contracts.
- `packages/pi-kit/test/child-env.test.ts` — child-environment scrubbing coverage.
- `packages/pi-kit/test/claude-code-adapter.test.ts` — Claude parser, effort, mode, and asynchronous preflight tests.
- `packages/pi-kit/test/lane-coordinator.test.ts` — shared lifecycle tests.
- `packages/pi-kit/test/mcp-server.test.ts` — in-memory MCP protocol tests.
- `packages/pi-kit/test/fixtures/claude-lane-stream.jsonl` — sanitized Claude 2.1.216 stream fixture.
- `packages/pi-kit/test/fixtures/normalized-lane-stream.jsonl` — canonical transcript fixture.
- `packages/pi-kit/README.md` — runtime, MCP and safety documentation.

### Modify

- `packages/pi-kit/src/schema.ts` — `LaneMode` and optional `LaneSpec.mode`.
- `packages/pi-kit/src/table.ts` — route, runtime model, origin and allowed-effort metadata; add Grok.
- `packages/pi-kit/src/runner.ts` — consume adapters and normalized events while retaining process ownership.
- `packages/pi-kit/src/transcript.ts` — parse canonical transcripts and legacy Pi JSONL.
- `packages/pi-kit/extensions/lanes.ts` — use `LaneCoordinator`; keep UI and Pi tool contract.
- `packages/pi-kit/test/runner.test.ts` — preserve process behavior through injected adapters.
- `packages/pi-kit/test/lanes-extension.test.ts` — compatibility and exception-containment coverage.
- `packages/pi-kit/test/table.test.ts` — route/origin/effort/mode validation.
- `packages/pi-kit/package.json` — MCP runtime dependencies, bin and scripts.
- `bun.lock` — dependency lock.

## Issue checklist

- [ ] Delivery mode, canonical issue and commit authority established
- [ ] Shared schema and route policy
- [ ] Pi and Claude execution adapters
- [ ] Provider-neutral runner and canonical transcript
- [ ] Shared lane coordinator
- [ ] Pi compatibility and handler containment
- [ ] Stdio MCP surface
- [ ] Documentation and package entrypoint
- [ ] Non-billable validation
- [ ] User-approved live smoke tests

---

### Task 0: Establish the Pickforge delivery workflow

**Files:**
- Read: `AGENTS.md`
- Attempt to read: `../AGENTS.md`
- Track externally: canonical GitHub Issue

- [ ] **Step 1: Re-read applicable instructions in the implementation worktree**

Record that `AGENTS.md` is binding. If `../AGENTS.md` is still absent, report that precisely rather than inventing workspace rules.

- [ ] **Step 2: Establish delivery mode**

Ask the user to choose `local-implement` or `ship`. Do not create commits until local implementation authority is explicit.

- [ ] **Step 3: Create or link the canonical Issue**

Use `plan-issue` when available. Otherwise create a phone-friendly issue draft/checklist from this plan and let the user perform any public action unless the active Pickforge workflow explicitly authorizes it. Record the Issue URL in the branch/PR description once created.

- [ ] **Step 4: Verify baseline**

Run:

```bash
bun install --frozen-lockfile
bun test packages/pi-kit/test
bun run typecheck
```

Expected: 90 existing tests pass and typecheck exits 0 before source changes.

---

### Task 1: Encode route, origin, effort and mode policy

**Files:**
- Modify: `packages/pi-kit/src/schema.ts`
- Modify: `packages/pi-kit/src/table.ts`
- Test: `packages/pi-kit/test/table.test.ts`

- [ ] **Step 1: Write failing schema and table tests**

Add tests covering:

```ts
expect(findModel("anthropic/claude-fable-5")).toMatchObject({
  route: "claude-code",
  runtimeModel: "fable",
  allowedEfforts: ["low", "medium", "high"],
  origins: ["pi"],
});
expect(findModel("xai/grok-4.5")).toMatchObject({
  route: "pi",
  runtimeModel: "grok-4.5",
  allowedEfforts: ["high"],
  origins: ["pi", "mcp"],
});
expect(validateLaneSpec(validAnthropic, { origin: "mcp" })).toContain("native Claude workflow");
expect(validateLaneSpec({ ...validAnthropic, effort: "minimal" }, { origin: "pi" })).toContain("unsupported effort");
expect(normalizeLaneSpec(validPi, { origin: "pi" }).mode).toBe("workspace-write");
expect(validateLaneSpec({ ...validPi, mode: undefined }, { origin: "mcp" })).toContain("mode is required");
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `bun test packages/pi-kit/test/table.test.ts`
Expected: FAIL because route metadata, origin-aware validation and mode normalization do not exist.

- [ ] **Step 3: Add the minimal policy types**

Add:

```ts
export type LaneMode = "read-only" | "workspace-write";
export type LaneOrigin = "pi" | "mcp";
export type ExecutionRoute = "pi" | "claude-code";
```

Extend `LaneSpec` with optional `mode`. Extend `ModelRow` with `route`, `runtimeModel`, `allowedEfforts`, and `origins`. Keep logical selectors unchanged. Add `xai/grok-4.5`, pinned to high and routed through Pi.

Implement `normalizeLaneSpec(spec, { origin })` and origin-aware `validateLaneSpec`. Never accept `max`, Haiku, Luna or Terra.

- [ ] **Step 4: Run focused tests**

Run: `bun test packages/pi-kit/test/table.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-kit/src/schema.ts packages/pi-kit/src/table.ts packages/pi-kit/test/table.test.ts
git commit -m "feat(pi-kit): encode lane execution policy"
```

---

### Task 2: Introduce the execution-adapter seam

**Files:**
- Create: `packages/pi-kit/src/execution-adapter.ts`
- Create: `packages/pi-kit/src/adapters/pi.ts`
- Create: `packages/pi-kit/src/child-env.ts`
- Create: `packages/pi-kit/test/execution-adapters.test.ts`
- Create: `packages/pi-kit/test/child-env.test.ts`
- Modify: `packages/pi-kit/test/runner.test.ts`

- [ ] **Step 1: Write failing adapter contract tests**

Define test expectations around this interface:

```ts
export type NormalizedLaneEvent =
  | { v: 1; type: "task"; text: string }
  | { v: 1; type: "text_delta"; delta: string }
  | { v: 1; type: "thinking_delta"; delta: string }
  | { v: 1; type: "tool_start"; tool: string; input: unknown }
  | { v: 1; type: "tool_end"; tool: string; text: string; isError: boolean }
  | { v: 1; type: "usage"; input: number; output: number; cacheRead: number; context: number }
  | { v: 1; type: "assistant_end"; text: string };

export interface LaneProcessPlan {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface LaneExecutionAdapter {
  route: ExecutionRoute;
  preflight(spec: LaneSpec): Promise<void>;
  build(spec: LaneSpec): LaneProcessPlan;
  createParser(spec: LaneSpec): { feedLine(line: string): NormalizedLaneEvent[]; end(): NormalizedLaneEvent[] };
}
```

Test that the Pi adapter reproduces the current `pi --mode json --no-extensions --no-session -p` invocation, maps each logical selector to the exact provider/runtime model, uses `PIKIT_CHILD=1`, and normalizes the existing fixture. Read-only mode must expose only `read,grep,find,ls`; workspace-write must use the normal Pi tools without loading an extension or passing `--tools`.

Add child-environment tests proving that only path/home/user/shell, temporary-directory, locale, terminal, and XDG runtime variables survive. Provider keys, cloud credentials, cookies, and agent sockets must not be inherited.

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test packages/pi-kit/test/execution-adapters.test.ts packages/pi-kit/test/runner.test.ts`
Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement the interface and Pi adapter**

Move Pi-specific command and JSON interpretation out of `runner.ts` without changing output semantics. Preserve the `piBinary` test override through adapter construction rather than a global. Route Sol, `xai/grok-4.5` at `high`, and GLM directly through Pi; never invoke the Grok CLI.

Read-only mode passes `--tools read,grep,find,ls`. Workspace-write retains the normal Pi tool set with inherited extensions disabled and no child-specific gate. Build both routes from the scrubbed child environment.

- [ ] **Step 4: Preserve compatibility and run focused tests**

Keep the existing `LaneRunner` constructor and `piBinary` option green through a default compatibility Pi adapter. Defer any runner-test changes that require the full normalized-event refactor to Task 4.

Run: `bun test packages/pi-kit/test/execution-adapters.test.ts packages/pi-kit/test/child-env.test.ts packages/pi-kit/test/runner.test.ts`
Expected: all suites PASS before commit.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-kit/src/execution-adapter.ts packages/pi-kit/src/adapters/pi.ts packages/pi-kit/src/child-env.ts packages/pi-kit/test/execution-adapters.test.ts packages/pi-kit/test/child-env.test.ts packages/pi-kit/test/runner.test.ts
git commit -m "refactor(pi-kit): isolate lane execution adapters"
```

---

### Task 3: Add the safe Anthropic execution adapter

**Files:**
- Create: `packages/pi-kit/src/adapters/claude-code.ts`
- Create: `packages/pi-kit/test/claude-code-adapter.test.ts`
- Create: `packages/pi-kit/test/fixtures/claude-lane-stream.jsonl`

- [ ] **Step 1: Create a synthetic documented Claude 2.1.216 fixture**

Author a synthetic fixture from the documented `stream-json` event shape. Do not invoke a provider. Include partial text, one tool lifecycle, final result and cumulative usage without account identifiers, private paths, credentials or tokens. A real stream may be compared only during the approved live-smoke phase and must never be committed raw.

- [ ] **Step 2: Write failing command-contract tests**

Assert the complete argv for both modes. Common required flags:

```ts
[
  "-p", "--safe-mode", "--disable-slash-commands", "--no-chrome",
  "--no-session-persistence", "--permission-mode", "dontAsk",
  "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  "--model", runtimeModel, "--effort", spec.effort,
]
```

Read-only tools must be exactly `Read,Glob,Grep`. Workspace-write tools must be exactly the normal `Read,Glob,Grep,Edit,Write,Bash` set, with no child-specific command rules. Assert absence of `--bare`, `bypassPermissions`, `--dangerously-skip-permissions`, arbitrary extra args and `max`.

- [ ] **Step 3: Write failing parser tests**

Feed the synthetic fixture one complete JSONL line at a time through `feedLine`; `LaneRunner` owns byte/chunk framing. Assert normalized task/text deltas, tool events, final answer and cumulative usage. Include malformed-line, unknown-event and `end()` cases.

- [ ] **Step 4: Run tests and verify failure**

Run: `bun test packages/pi-kit/test/claude-code-adapter.test.ts`
Expected: FAIL because the adapter does not exist.

- [ ] **Step 5: Implement asynchronous executable preflight, argv construction and parser**

Resolve PATH candidates with `realpath`, require executable permission, and inspect only the candidate/wrapper script prefix for the literal dangerous flags `--dangerously-skip-permissions` and `--permission-mode bypassPermissions`; skip unsafe wrappers and fail if no safe candidate remains. Run version discovery asynchronously with a timeout and bounded output. `LaneRunner` must await every selected adapter preflight before spawning any lane, so a failed preflight owns no children and does not partially start a run. Build argv as fixed flags followed by `--` and `spec.task`, with no shell interpolation. Use the scrubbed child environment. Do not attempt to read or copy OAuth credentials. Let the genuine CLI report authentication failure as a failed lane.

- [ ] **Step 6: Run focused tests**

Run: `bun test packages/pi-kit/test/claude-code-adapter.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/pi-kit/src/adapters/claude-code.ts packages/pi-kit/test/claude-code-adapter.test.ts packages/pi-kit/test/fixtures/claude-lane-stream.jsonl
git commit -m "feat(pi-kit): add subscription-backed lane adapter"
```

---

### Task 4: Refactor LaneRunner around normalized events

**Files:**
- Modify: `packages/pi-kit/src/runner.ts`
- Modify: `packages/pi-kit/src/transcript.ts`
- Create: `packages/pi-kit/test/fixtures/normalized-lane-stream.jsonl`
- Modify: `packages/pi-kit/test/runner.test.ts`
- Modify: `packages/pi-kit/test/transcript.test.ts`

- [ ] **Step 1: Add failing compatibility and transcript tests**

Define the canonical transcript as one JSON object per line using `NormalizedLaneEvent` with `v: 1`. The first record is `{ v: 1, type: "task", text: spec.task }`. Usage records are cumulative snapshots; adapters deduplicate partial/final provider reports, and the runner replaces prior counters rather than adding snapshots.

Test that:

- `LaneRunner` resolves the adapter from model metadata;
- zero or multiple matching adapters fail before spawn;
- all asynchronous adapter preflights settle before the first child spawn, and one rejection prevents every spawn;
- adapter events produce the existing journal/projection values;
- canonical transcript JSONL renders in the TUI model;
- archived Pi JSONL fixtures still render;
- adapter/source stdout remains bounded at 4 MiB;
- success, failure and abandonment do not settle until the child emits `close`;
- abandon and exit hooks still kill the whole process group.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `bun test packages/pi-kit/test/runner.test.ts packages/pi-kit/test/transcript.test.ts`
Expected: FAIL on adapter resolution and canonical transcript cases.

- [ ] **Step 3: Implement the smallest runner refactor**

Inject an adapter registry into `RunnerOptions`, with the production default containing Pi and Claude adapters. Resolve all specs and await all route preflights before spawning the first child. Keep scheduling, process ownership, status throttling, projection mutation and cost estimation in `LaneRunner`.

Validate lane IDs before path construction and resolve canonical transcript paths beneath the configured run directory. Write normalized transcript records there. If upstream diagnostics are retained, store them under a distinct capped source path. Never write secrets or full environment values.

- [ ] **Step 4: Run focused tests**

Run: `bun test packages/pi-kit/test/runner.test.ts packages/pi-kit/test/transcript.test.ts packages/pi-kit/test/execution-adapters.test.ts packages/pi-kit/test/claude-code-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-kit/src/runner.ts packages/pi-kit/src/transcript.ts packages/pi-kit/test/runner.test.ts packages/pi-kit/test/transcript.test.ts packages/pi-kit/test/fixtures/normalized-lane-stream.jsonl
git commit -m "refactor(pi-kit): normalize lane runtime events"
```

---

### Task 5: Extract the shared LaneCoordinator

**Files:**
- Create: `packages/pi-kit/src/lane-coordinator.ts`
- Create: `packages/pi-kit/test/lane-coordinator.test.ts`
- Modify: `packages/pi-kit/src/runner.ts`
- Modify: `packages/pi-kit/test/runner.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover:

- nonblocking spawn;
- one active run per coordinator;
- Pi-origin mode default;
- MCP-origin explicit mode and Anthropic rejection;
- filtered and whole-run status;
- wait settlement;
- aborted wait detachment without lane cancellation;
- named/all abandon;
- no-run errors;
- JSON-safe snapshots with lane arrays and finite numeric normalization;
- shutdown abandonment.

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/pi-kit/test/lane-coordinator.test.ts`
Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement the coordinator interface**

Use a small interface:

```ts
spawn(specs: LaneSpec[]): Promise<RunSnapshotDto>;
status(lane?: string): RunSnapshotDto;
wait(signal?: AbortSignal): Promise<RunSnapshotDto>;
abandon(input: { lane?: string; reason?: string }): RunSnapshotDto;
shutdown(reason: string): Promise<void>;
```

Inject immutable origin (`pi` or `mcp`) at coordinator construction, plus runner creation, journaling and clock/ID generation for deterministic tests. Refine `LaneRunner` settlement so successful, failed, and abandoned lanes resolve only after child `close`; dispatch therefore cannot finish while a prior runner owns closing children. Add `LaneRunner.shutdown(reason): Promise<void>` that abandons active lanes, performs SIGTERM→SIGKILL escalation, and awaits their closes. Remove the runner from the global active set only afterward. `LaneCoordinator.shutdown` awaits it. Add a regression that completes one run, starts a second, shuts down, and proves no process group from either run remains. Keep text formatting and Pi UI out of this module.

- [ ] **Step 4: Run focused tests**

Run: `bun test packages/pi-kit/test/lane-coordinator.test.ts packages/pi-kit/test/runner.test.ts`
Expected: PASS, including assertions that shutdown does not resolve before child `close`.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-kit/src/lane-coordinator.ts packages/pi-kit/src/runner.ts packages/pi-kit/test/lane-coordinator.test.ts packages/pi-kit/test/runner.test.ts
git commit -m "feat(pi-kit): add shared lane coordinator"
```

---

### Task 6: Rewire the Pi extension without changing its UX

**Files:**
- Modify: `packages/pi-kit/extensions/lanes.ts`
- Modify: `packages/pi-kit/test/lanes-extension.test.ts`

- [ ] **Step 1: Add failing characterization tests**

Freeze existing tool names, descriptions, response wording, widget/status behavior, nudges, command behavior and shutdown semantics. Add injected failures for spawn, status, wait, abandon, UI rendering, commands and shutdown; assert no exception escapes and tool failures set `isError: true`.

- [ ] **Step 2: Run and verify the new failures**

Run: `bun test packages/pi-kit/test/lanes-extension.test.ts`
Expected: new failure-injection tests FAIL against current unwrapped handlers.

- [ ] **Step 3: Replace extension-owned lifecycle with LaneCoordinator**

Keep Pi-specific formatting, widgets, TUI and nudges in the extension. Wrap every handler body. Treat UI calls as fallible. Convert coordinator errors to concise `isError` results.

- [ ] **Step 4: Run focused tests**

Run: `bun test packages/pi-kit/test/lanes-extension.test.ts packages/pi-kit/test/lane-coordinator.test.ts`
Expected: PASS with unchanged user-facing snapshots/text.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-kit/extensions/lanes.ts packages/pi-kit/test/lanes-extension.test.ts
git commit -m "refactor(pi-kit): share lane lifecycle across harnesses"
```

---

### Task 7: Add the stdio MCP server

**Files:**
- Modify: `packages/pi-kit/package.json`
- Modify: `bun.lock`
- Create: `packages/pi-kit/mcp/create-server.ts`
- Create: `packages/pi-kit/mcp/server.ts`
- Create: `packages/pi-kit/test/mcp-server.test.ts`

- [ ] **Step 1: Add pinned runtime dependencies**

Run:

```bash
bun add --cwd packages/pi-kit @modelcontextprotocol/sdk@1.29.0 zod
```

Expected: `package.json` gains runtime dependencies and `bun.lock` changes only for resolved dependency metadata.

- [ ] **Step 2: Write failing in-memory protocol tests**

Create a real MCP `Client`, server factory and linked transports using `InMemoryTransport.createLinkedPair()`. Test all four exact tool names; the exact flattened DTO fields from the spec; omission of task, cwd, rationale, PID, origin, and timestamps; no-run errors; duplicate spawn; filtered status; detached wait cancellation; abandon; Anthropic rejection; handler exceptions; and finite numeric normalization.

- [ ] **Step 3: Run and verify failure**

Run: `bun test packages/pi-kit/test/mcp-server.test.ts`
Expected: FAIL because the server factory does not exist.

- [ ] **Step 4: Implement `createLaneMcpServer`**

Register tools with Zod input/output schemas through `McpServer.registerTool`. Use `extra.signal` for wait. Return text plus `structuredContent` on success and text-only `isError` on failures.

- [ ] **Step 5: Implement the stdio entrypoint**

Add `#!/usr/bin/env bun`. Connect `StdioServerTransport`. Write no logs to stdout. Use one idempotent async shutdown promise for SIGINT, SIGTERM, stdin `end`, stdin `close`, and transport closure: await coordinator shutdown and every child `close`, then close MCP server/transport and exit. Keep the synchronous runner exit hook only as last-resort reaping. Catch top-level failures and report only to stderr. Add a process fixture proving no child process group remains when the server exits.

- [ ] **Step 6: Add package commands**

Add:

```json
{
  "bin": { "pickforge-lanes-mcp": "./mcp/server.ts" },
  "scripts": {
    "mcp": "bun mcp/server.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 7: Run protocol and type tests**

Run:

```bash
bun test packages/pi-kit/test/mcp-server.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/pi-kit/package.json bun.lock packages/pi-kit/mcp packages/pi-kit/test/mcp-server.test.ts
git commit -m "feat(pi-kit): expose lanes over stdio MCP"
```

---

### Task 8: Document and validate the runtime

**Files:**
- Create: `packages/pi-kit/README.md`
- Modify if generalized guidance emerged: `AGENTS.md`

- [ ] **Step 1: Document interfaces and non-goals**

Document logical selectors, route ownership, mode semantics, MCP tools, Claude native-workflow rule, lifecycle, data paths, auth boundaries, failure behavior and exact local commands. Do not duplicate the comparative routing table in prose; render it from or point to the canonical table.

- [ ] **Step 2: Run all non-billable validation**

Run without wrappers:

```bash
bun test packages/pi-kit/test
bun run typecheck
```

Expected baseline plus new tests: PASS, zero failures.

- [ ] **Step 3: Verify CLI discovery without invoking a model**

Run:

```bash
bun packages/pi-kit/mcp/server.ts </dev/null
pi --list-models grok
claude --version
```

Expected: MCP exits cleanly on stdin close; Pi lists `xai/grok-4.5`; Claude reports 2.1.216 or a reviewed compatible version.

- [ ] **Step 4: Request approval for billable/live smoke tests**

Do not invoke providers until the user approves the exact prompts and expected small usage.

- [ ] **Step 5: Run approved live smoke matrix**

Use temporary repositories and minimal prompts:

- Pi extension → Fable via genuine Claude route, read-only.
- MCP client → Sol via Pi, read-only.
- MCP client → Grok via Pi, read-only/high.
- MCP client → GLM via Pi, read-only/text-only.

Expected: each returns the requested sentinel text, reports the selected logical model, journals one terminal lane, and leaves no child processes. No fallback is accepted.

- [ ] **Step 6: Run local review before shipping**

Use `$local-review` after focused behavior validation. Resolve valid findings and rerun only targeted checks.

- [ ] **Step 7: Commit documentation**

```bash
git add packages/pi-kit/README.md AGENTS.md
git commit -m "docs(pi-kit): document cross-harness lanes"
```

## Runtime plan completion gate

- [ ] All tasks above are checked.
- [ ] Every existing Pi lane behavior remains covered.
- [ ] MCP protocol tests use a real in-memory client/server connection.
- [ ] No permission bypass, OAuth copying, provider cloaking or silent fallback exists.
- [ ] All children are reaped in tests and smoke runs.
- [ ] Live provider usage was explicitly approved.
- [ ] Decision audit lists every incidental choice and unresolved alternative.
- [ ] Deployment plan remains unexecuted until this runtime is merged, the reviewed commit is checked out at `$HOME/Projects/Pickforge/pickforge-platform`, `bun install --frozen-lockfile` has run there, and the deployed commit SHA is recorded.
