# Cross-Harness Multi-Model Lanes Design

**Status:** Approved through Plannotator feedback on 2026-07-21
**Delivery mode:** Plan-only
**Implementation order:** pi-kit runtime first, managed Claude configuration second

## Goal

Make one multi-model lane runtime available from both Pi and Claude Code without duplicating provider-routing skills. Pi keeps its current lane tools and TUI. Claude Code receives the same asynchronous lane operations through a local stdio MCP server. Pi can dispatch Anthropic lanes through the genuine Claude Code client so subscription-backed Claude models remain available as workers.

## Scope

### Included

- A harness-neutral lane execution seam in `packages/pi-kit`.
- Existing Pi tools: `lanes_spawn`, `lanes_status`, `lanes_wait`, and `lanes_abandon`.
- A stdio MCP server exposing the same four operations to Claude Code.
- Direct Pi execution for GPT-5.6 Sol, Grok 4.5, and GLM-5.2.
- Genuine Claude Code execution for Fable 5, Sonnet 5, and Opus 4.8.
- Shared model validation, effort constraints, journaling, reports, cancellation, and process ownership.
- Canonical Claude configuration and one portable procedural skill through `agent-config-sync`.
- Focused remediation of global Claude settings that directly affects safe lane operation.

### Excluded from v1

- Running Claude as Pi's primary model.
- A daemon shared across multiple Claude Code sessions.
- Cross-session recovery of active MCP lane runs.
- Provider-specific skills.
- Replacing Claude Code's native Claude-to-Claude workflows.
- Consolidating every existing Codex model-orchestration wrapper into pi-kit.
- Silent provider fallback when an executable or authentication route is unavailable.

## Architecture

### Deep module and seam

`LaneRunner` remains the process owner and public deep module. Its interface continues to provide `dispatch`, `projection`, `abandon`, and `abandonAll`. Process scheduling, detached process groups, SIGTERM-to-SIGKILL escalation, bounded buffers, raw transcripts, and projection updates stay behind that interface.

A new execution-adapter seam varies only what truly differs by provider route:

- command construction;
- executable preflight;
- output stream normalization;
- mode-specific tool permissions.

The two real adapters are:

1. **Pi adapter:** Sol, Grok, and GLM through `pi --mode json`.
2. **Claude Code adapter:** Fable, Sonnet, and Opus through `claude -p --output-format stream-json`.

A `LaneCoordinator` becomes the harness-neutral lifecycle module above `LaneRunner`. It owns the single active run, spawn/status/wait/abandon semantics, wait detachment, and run settlement. Pi and MCP become thin adapters over this interface.

### Model table

Logical selectors remain stable:

- `openai-codex/gpt-5.6-sol`
- `anthropic/claude-fable-5`
- `anthropic/claude-opus-4-8`
- `anthropic/claude-sonnet-5`
- `xai/grok-4.5`
- `ollama/glm-5.2:cloud`

Each `ModelRow` gains execution metadata: route, runtime model ID, allowed efforts, and supported origins. Callers choose a model, not a transport. Pi-origin calls accept every table row: Fable, Sonnet, and Opus route through genuine Claude Code, while Sol, GLM, and `xai/grok-4.5` at `high` route directly through Pi. Grok never routes through the Grok CLI. MCP-origin calls route Sol, Grok, and GLM through Pi and reject Anthropic rows so Claude Code uses its native Claude-to-Claude workflows. Unknown routes and missing executables fail before spawn; authentication errors that cannot be proven cheaply before spawn fail the started lane without substitution.

Claude-routed models reject `off`, `minimal`, and the globally prohibited `max` before spawn. Fable allows `low|medium|high`, Opus remains pinned to `xhigh`, and Sonnet allows `low|medium|high|xhigh`. Grok remains pinned to `high` through the Pi route.

### Lane permissions

`LaneSpec` gains an optional `mode`:

```ts
type LaneMode = "read-only" | "workspace-write";
```

Mode requirements are origin-based. Existing Pi-origin calls retain `workspace-write` as their compatibility default, including Anthropic calls. Every MCP-origin call must state a mode. Read-only is an explicit tool boundary. Workspace-write uses the normal tools of the selected harness; existing parent-session plan, local, and ship gates are outside this runtime and remain unchanged.

Claude Code command policy is explicit and deterministic. Both modes pass `--safe-mode`, `--disable-slash-commands`, `--no-chrome`, `--no-session-persistence`, and `--permission-mode dontAsk`. Claude Code 2.1.216 documents `--safe-mode` as disabling CLAUDE.md, skills, plugins, hooks, MCP servers, commands, agents, workflows, themes, keybindings, and other customizations while retaining normal authentication, model selection, built-in tools, and permissions. The worker prompt carries required repository context explicitly.

- `read-only` passes `--tools Read,Glob,Grep` and allows exactly `Read`, `Glob`, and `Grep`. It exposes no Bash, Edit, or Write tool.
- `workspace-write` passes `--tools Read,Glob,Grep,Edit,Write,Bash` and allows those normal built-in tools without a child-specific command gate.
- Pi read-only passes `--tools read,grep,find,ls`; Pi workspace-write does not narrow the normal Pi tool set.

The adapters build fixed argument arrays, never accept arbitrary extra flags, and never pass permission-bypass flags. Tests assert both mode contracts.

### MCP server

The MCP server uses `@modelcontextprotocol/sdk` v1.x with `StdioServerTransport`. It is a child of the owning Claude Code session and keeps stdout exclusively for JSON-RPC. Diagnostics go to stderr.

It registers exactly:

- `lanes_spawn`
- `lanes_status`
- `lanes_wait`
- `lanes_abandon`

Each handler delegates to `LaneCoordinator`, catches all failures, and returns an MCP `isError` result instead of crashing the server. Tools are registered with `McpServer.registerTool`; `lanes_wait` consumes the SDK handler's `extra.signal`. Cancellation detaches that wait but does not cancel lanes. Server exit abandons all active lanes and reaps child process groups.

The MCP wire interface uses JSON-safe DTOs rather than `RunProjection` directly:

```ts
interface LaneSnapshotDto {
  lane: string;
  model: string;
  effort: Effort;
  mode: LaneMode;
  state: LaneState;
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
  totals: { cost: number; tokensIn: number; tokensOut: number };
  lanes: LaneSnapshotDto[];
}
```

Every successful result includes concise text in `content` and the matching flattened snapshot DTO in `structuredContent`. The shape above is exact: it excludes task, cwd, rationale, PID, origin, and timestamps. `lanes_spawn`, `lanes_status`, and `lanes_wait` use a `RunSnapshotDto` output schema; `lanes_abandon` returns the post-abandon `RunSnapshotDto`. Calling status, wait, or abandon before spawn is an `isError: true`, text-only no-run outcome. Other error results are likewise bounded, text-only, and do not claim schema-valid structured content. A DTO serializer normalizes every numeric field with `Number.isFinite(value) ? value : 0`, so `NaN` and infinities cannot become schema-invalid JSON `null`. The SDK is pinned to `@modelcontextprotocol/sdk` `1.29.0`, and protocol tests connect a real client and server using `InMemoryTransport.createLinkedPair()`.

### Claude Code behavior

Claude Code uses native workflows for Claude-to-Claude delegation. The MCP server enforces this by rejecting Anthropic selectors. Claude uses MCP lanes for cross-provider work, deliberate provider diversity, review/adjudication, or explicit panels. The global model policy remains canonical; the MCP server and skill do not invent permanent model roles.

### Pi behavior

The existing Pi extension keeps its tool names, wording, widgets, nudges, TUI, and session-shutdown behavior. It delegates lifecycle operations to `LaneCoordinator`. Anthropic lane selection transparently launches the genuine Claude Code executable. Every Pi extension handler is wrapped so exceptions become `isError` tool results or fallible UI diagnostics; no handler exception may escape into the parent session.

Pi read-only workers receive only `read,grep,find,ls`. Pi workspace-write workers use the normal harness tools while inherited extensions remain disabled. There is no child-specific command gate.

## Normalized events and transcripts

Execution adapters translate provider streams into a canonical internal contract:

```ts
type NormalizedLaneEvent =
  | { v: 1; type: "task"; text: string }
  | { v: 1; type: "text_delta"; delta: string }
  | { v: 1; type: "thinking_delta"; delta: string }
  | { v: 1; type: "tool_start"; tool: string; input: unknown }
  | { v: 1; type: "tool_end"; tool: string; text: string; isError: boolean }
  | { v: 1; type: "usage"; input: number; output: number; cacheRead: number; context: number }
  | { v: 1; type: "assistant_end"; text: string };
```

The runner owns process start/exit and converts normalized events into journal updates. The first canonical record is the lane task. Usage records are cumulative snapshots per lane, never deltas; adapters deduplicate partial/final provider usage before emitting them, and the runner replaces previous counters. A lane does not settle until its child emits `close`; SIGTERM→SIGKILL escalation therefore completes before `dispatch` resolves, so a coordinator cannot replace a runner that still owns closing children. It stores versioned canonical transcript JSONL for new runs while `LaneTranscript` retains legacy Pi JSONL support for archived runs. Upstream source lines may be retained separately as capped diagnostic transcripts, never mixed with the canonical TUI stream.

The Claude parser targets Claude Code 2.1.216 `stream-json` with `--verbose --include-partial-messages`, translating content-block deltas, tool-use lifecycle, final result, and usage into the normalized contract. Parser fixtures are sanitized and contain no account identifiers or credentials.

## Data flow

### Pi to Claude worker

1. Pi calls `lanes_spawn` with an Anthropic logical selector.
2. `LaneCoordinator` validates the spec and creates a run.
3. `LaneRunner` resolves the Claude Code adapter from model-table metadata.
4. The adapter launches `claude -p` with model, effort, mode-specific tools, and streaming JSON.
5. Normalized events update the shared journal and projection.
6. Pi displays status and later returns the final report through status/wait.

### Claude Code to cross-provider worker

1. Claude Code calls `mcp__pickforge-lanes__lanes_spawn`.
2. The MCP handler delegates to its session-local `LaneCoordinator`.
3. The Pi adapter launches one Pi child per requested Sol, Grok, or GLM lane.
4. Claude Code can continue working, check status, wait, or abandon.
5. MCP returns structured projections plus concise text summaries.

## Errors and lifecycle

- Invalid models, route-specific efforts, origin/mode combinations, duplicate lane IDs, or missing tasks fail before spawn.
- Missing executables produce a named pre-spawn route error. Authentication failures are reported as failed lanes when the underlying CLI is the only authoritative check; no substitution occurs inside the runtime.
- A second spawn while a run is active is rejected.
- Lane IDs must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; resolved transcript paths must remain beneath the configured run directory.
- Children inherit only the scrubbed runtime allowlist: path/home/user/shell, temporary-directory, locale, terminal, and XDG variables. Pi adds `PIKIT_CHILD=1`; provider credentials, cookies, cloud secrets, and agent sockets are not copied.
- Child stdout and canonical transcript capture are capped at 4 MiB per lane; stdout overflow fails the lane. Final answers are capped at 4,000 characters.
- MCP and Pi handler exceptions become bounded tool errors. Parser, spawn, exit, and authentication failures become failed lanes without route substitution.
- Parent/session shutdown uses one idempotent async path: mark lanes abandoned, send SIGTERM, escalate to SIGKILL after the existing timeout, await every child `close`, then close the harness transport and exit. Synchronous process-exit reaping remains the last-resort fallback.
- Journal and canonical transcript writes remain best-effort and must never crash the parent harness or determine settlement.

## Global Claude configuration

Configuration changes use the canonical chezmoi source through `agent-config-sync`; rendered files are never edited directly.

A planning-time probe found the live profile managed and `agent-config-sync check-live` passing, with the issues below. Task 1 of the deployment plan must reproduce each condition at execution time; only reproduced issues may be corrected before enabling the lane MCP server:

- change the decision-audit hook from `/home/dev/.claude/hooks/...` to `$HOME/.claude/hooks/...`;
- remove the unavailable retired `rtk hook claude` hook;
- remove broad auto-approved `Bash(rm *)` and `Bash(git *)` permissions, replacing Git with explicit read-only forms;
- retain user confirmation for destructive filesystem and Git operations;
- remove the duplicate standalone Context7 MCP entry while keeping the official Context7 plugin;
- register `pickforge-lanes` as a user-scoped stdio MCP server through a managed launcher that points to the merged, reviewed primary checkout and verifies its deployed commit/dependencies;
- add one portable `multi-model-lanes` skill for procedures and reporting, not provider routing.

The dotfiles checkout is user-owned and changed during planning. At execution time, inventory its branch relation, dirty/untracked paths, and current timeout-bounded `agent-config-sync check`/`check-live` results. Preserve user work, accept only failures reproduced in that run, and never carry stale historical failures forward.

## Testing

- Characterize existing Pi runner and extension behavior before extraction.
- Unit-test model route metadata, effort/mode validation, and executable preflight.
- Test Pi and Claude stream parsers against the normalized event contract with sanitized JSONL fixtures.
- Test legacy Pi transcript replay and canonical transcript replay.
- Test process-group termination, output caps, and unavailable routes.
- Test `LaneCoordinator` spawn/status/wait/abandon independent of either harness.
- Test MCP handlers and JSON-safe DTOs with `InMemoryTransport.createLinkedPair()` and an MCP client.
- Inject failures into every Pi lane handler category and verify no exception escapes.
- Preserve all existing pi-kit tests.
- Run live, explicitly approved smoke tests for Pi→Claude and Claude→Sol/Grok/GLM after non-billable tests pass.
- Validate canonical/live Claude configuration with scoped chezmoi checks and `agent-config-sync check-live`.

## Acceptance criteria

- Pi's current lane UX and tests remain behaviorally unchanged.
- Claude Code can call all four lane tools over stdio MCP and receives JSON-safe structured snapshots.
- The MCP server rejects Anthropic selectors and directs same-provider delegation to native Claude workflows.
- Claude Code can dispatch Sol, Grok, and GLM through authenticated Pi routes.
- Pi can dispatch Fable, Sonnet, and Opus through the genuine Claude Code client.
- Model and effort constraints remain enforced from one table.
- No OAuth token is copied or proxied.
- No child uses bypass permissions or silently changes provider.
- Active children are reaped when Pi or the MCP server exits.
- Global Claude configuration is canonical, non-duplicated, and passes scoped live validation.

## Decisions not explicitly specified by the user

- Keep logical selectors stable and hide execution routes in model metadata.
- Add `LaneMode`; require it for MCP-origin calls while preserving existing Pi-origin compatibility.
- Use a session-local stdio MCP process instead of a daemon.
- Route Grok through Pi because `xai/grok-4.5` is now available there.
- Split runtime and deployment into sequential plans.
- Keep the official Context7 plugin and remove the duplicate standalone registration.

The first four were presented in Plannotator; no objection was recorded except that Grok should use Pi, which this design adopts. The permission narrowing and Context7 choice are safety/configuration recommendations. Deployment must stop for explicit approval after showing redacted structural findings and before changing permissions or removing Context7.
