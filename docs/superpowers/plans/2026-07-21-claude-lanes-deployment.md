# Managed Claude Lanes Deployment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the reviewed pi-kit lane MCP server to Claude Code through canonical chezmoi configuration, add one portable procedural skill, and repair directly related global Claude safety drift.

**Architecture:** Keep executable runtime code in `pickforge-platform`. Use `agent-config-sync` and chezmoi as the only configuration source, with a managed wrapper and idempotent user-scoped MCP registration. Keep routing policy in existing canonical instructions; the new skill documents procedures only.

**Tech Stack:** chezmoi, age-encrypted configuration, Bash, Claude Code 2.1.216, `agent-config-sync`.

**Prerequisite plan:** `docs/superpowers/plans/2026-07-21-pi-kit-multimodel-lanes-mcp.md`

**Spec:** `docs/superpowers/specs/2026-07-21-cross-harness-multimodel-lanes-design.md`

---

## Safety prerequisites

The canonical repository state changed during planning and must never be treated as a fixed baseline. At the last check it matched `origin/main` but contained user-owned `dot_pi/agent/encrypted_models.json.age` modifications and untracked `AGENTS.md`; both must remain untouched. `agent-config-sync check` and `check-live` both passed at that time. Re-run status and checks at execution time, document only failures reproduced then, and stop for any new drift. Do not edit, pull, rebase, reset, clean, or apply over user work.

Never read or print OAuth tokens, cookies, encrypted settings plaintext in logs, or MCP credentials. Use `chezmoi --source "$CONFIG_WT" edit` for encrypted files after the worktree variable is established.

## File map

### Canonical chezmoi repository

- Create: `dot_local/bin/executable_pickforge-lanes-mcp`
- Create: `run_onchange_after_configure_pickforge_lanes_mcp.sh.tmpl`
- Create encrypted through chezmoi: `dot_agents/skills/multi-model-lanes/encrypted_SKILL.md.age`
- Create: `dot_claude/skills/symlink_multi-model-lanes`
- Create: `dot_pi/agent/skills/symlink_multi-model-lanes`
- Modify: `dot_agents/skill-targets.json`
- Modify through source-scoped `chezmoi edit`: `dot_claude/encrypted_settings.json.age`
- Modify: `scripts/check-agent-config-sync.sh`
- Modify if a concise harness reference is still needed: `dot_claude/CLAUDE.md.tmpl`
- Modify if a concise harness reference is still needed: `dot_pi/agent/AGENTS.md.tmpl`

### Rendered targets

- Create: `~/.local/bin/pickforge-lanes-mcp`
- Create: `~/.agents/skills/multi-model-lanes/SKILL.md`
- Create symlinks: `~/.claude/skills/multi-model-lanes`, `~/.pi/agent/skills/multi-model-lanes`
- Modify through scoped apply: `~/.claude/settings.json`
- Modify through `claude mcp`: user-scoped `pickforge-lanes` registration
- Remove through `claude mcp`: duplicate user-scoped standalone `context7` registration, retaining `plugin:context7:context7`

## Issue checklist

- [ ] Canonical checkout inventoried and isolated without losing user work
- [ ] Current baseline check results recorded without stale assumptions
- [ ] Stable runtime wrapper installed
- [ ] User-scoped MCP registration managed idempotently
- [ ] One portable procedural skill distributed to Claude and Pi
- [ ] Claude safety hook and permission drift corrected
- [ ] Duplicate Context7 registration removed
- [ ] Scoped config checks and live MCP smoke pass

---

### Task 1: Inventory canonical state and create an isolated configuration worktree

**Files:**
- Inspect only initially: `/Users/elberte/.local/share/chezmoi`

- [ ] **Step 1: Establish delivery mode and inspect work**

Run:

```bash
git -C /Users/elberte/.local/share/chezmoi status --short --branch
git -C /Users/elberte/.local/share/chezmoi log --oneline --decorate --graph --max-count=12 --all
```

Expected: identify current branch relation and every dirty/untracked path. Read any discovered `AGENTS.md`. Preserve all user-owned paths.

- [ ] **Step 2: Resolve only a real history blocker**

If the branch is ahead/behind at execution time, present the exact pull/rebase/merge operation and obtain confirmation. Never reset or clean. If it is aligned, do nothing.

- [ ] **Step 3: Create a dedicated worktree from reviewed HEAD**

Use `/Users/elberte/Projects/.worktrees/dotfiles/feature-multimodel-lanes` and record:

```bash
export CONFIG_WT=/Users/elberte/Projects/.worktrees/dotfiles/feature-multimodel-lanes
```

Every subsequent chezmoi command must use `chezmoi --source "$CONFIG_WT" ...`; plain `chezmoi add/edit/diff/apply` is forbidden because it would target the user-owned canonical checkout.

- [ ] **Step 4: Record current baselines with timeouts**

Run the worktree's `scripts/check-agent-config-sync.sh` plus live `agent-config-sync check-live` through a 20-second Python subprocess timeout. Accept only failures reproduced and documented in this run; do not carry historical expected failures forward.

- [ ] **Step 5: Keep unrelated canonical work isolated**

Confirm the feature worktree contains none of the canonical checkout's unrelated dirty/untracked changes unless the user explicitly asks to include them.

---

### Task 2: Add a stable pi-kit MCP launcher

**Files:**
- Create: `dot_local/bin/executable_pickforge-lanes-mcp`
- Modify: `scripts/check-agent-config-sync.sh`

- [ ] **Step 1: Add a failing canonical invariant**

Extend the check script to require a managed executable that:

- resolves `$HOME/Projects/Pickforge/pickforge-platform/packages/pi-kit/mcp/server.ts`;
- exits clearly if Bun or the entrypoint is missing;
- uses `exec bun <entrypoint>`;
- contains no credentials or provider tokens.

- [ ] **Step 2: Run the scoped check and verify failure**

Run the check through a timeout and compare against Task 1's freshly recorded baseline only.
Expected: the new wrapper invariant FAILS and no unrelated baseline result changes.

- [ ] **Step 3: Implement the launcher**

```bash
#!/usr/bin/env bash
set -euo pipefail
entrypoint="$HOME/Projects/Pickforge/pickforge-platform/packages/pi-kit/mcp/server.ts"
command -v bun >/dev/null || { echo "pickforge-lanes-mcp: bun not found" >&2; exit 127; }
[[ -f "$entrypoint" ]] || { echo "pickforge-lanes-mcp: pi-kit MCP server not found at $entrypoint" >&2; exit 127; }
exec bun "$entrypoint"
```

- [ ] **Step 4: Commit**

```bash
git add dot_local/bin/executable_pickforge-lanes-mcp scripts/check-agent-config-sync.sh
git commit -m "feat(config): add managed lanes launcher"
```

---

### Task 3: Add one portable multi-model lanes skill

**Files:**
- Create encrypted: `dot_agents/skills/multi-model-lanes/encrypted_SKILL.md.age`
- Create: `dot_claude/skills/symlink_multi-model-lanes`
- Create: `dot_pi/agent/skills/symlink_multi-model-lanes`
- Modify: `dot_agents/skill-targets.json`
- Test: `scripts/check-agent-config-sync.sh`

- [ ] **Step 1: Search for overlap before creating the skill**

Inspect `model-runners`, Claude's existing `model-orchestration`, and Pi lane instructions. The new skill must not copy the comparative model table or create provider roles.

- [ ] **Step 2: Add failing registry checks**

Require `multi-model-lanes` to target only `claude` and `pi`, with valid symlinks and canonical encrypted source.

- [ ] **Step 3: Draft the lean live skill**

Create `~/.agents/skills/multi-model-lanes/SKILL.md` with:

- trigger: cross-provider delegation, independent parallel work, or explicit panel;
- Claude rule: native workflows for Claude-to-Claude work; MCP rejects Anthropic selectors;
- Pi rule: use existing lane tools;
- exact spawn/status/wait/abandon procedure;
- explicit model, effort, mode, cwd and rationale requirement;
- hard policy: never run provider model CLI delegation in the foreground; use asynchronous lanes, MCP, or a provider-native background workflow;
- hard failure when no asynchronous route is available; never fall back to synchronous direct-CLI delegation;
- no polling loop;
- output contract including decisions, evidence, validation and unresolved risk;
- observable completion criteria;
- reference to canonical global model policy rather than a duplicated table.

- [ ] **Step 4: Run the skill quality gate**

Verify description trigger, completion criteria, progressive disclosure, no overlap, no retired tools, capability-aware targets, and the invariant that provider model CLI delegation is never foregrounded or used as a synchronous fallback.

- [ ] **Step 5: Add the skill encrypted**

Run:

```bash
chezmoi --source "$CONFIG_WT" add --encrypt ~/.agents/skills/multi-model-lanes/SKILL.md
```

Then add the two managed relative symlinks and update `dot_agents/skill-targets.json`.

- [ ] **Step 6: Run scoped checks**

Expected: the new skill and symlink checks PASS; every other result matches Task 1's current baseline.

- [ ] **Step 7: Commit**

```bash
git add dot_agents/skills/multi-model-lanes dot_agents/skill-targets.json dot_claude/skills/symlink_multi-model-lanes dot_pi/agent/skills/symlink_multi-model-lanes scripts/check-agent-config-sync.sh
git commit -m "feat(config): add portable lanes workflow"
```

---

### Task 4: Repair global Claude safety configuration

**Files:**
- Modify through source-scoped `chezmoi edit`: `dot_claude/encrypted_settings.json.age`
- Modify: `scripts/check-agent-config-sync.sh`

- [ ] **Step 1: Add failing safe-profile invariants**

Require rendered Claude settings to satisfy:

- decision hook command uses `$HOME/.claude/hooks/decision-audit-gate.sh`;
- no `rtk hook claude` entry;
- no broad `Bash(rm *)` or `Bash(git *)` auto-allow;
- explicit read-only Git allow forms remain available;
- no literal credentials or authorization headers;
- the new MCP allow rule is exact, not a broad `mcp__*` wildcard.

- [ ] **Step 2: Run redacted checks and record reproduced findings**

Print invariant names and pass/fail only. Do not assume planning-time findings remain. Record which of the hook path, stale rtk, broad rm/mv/chmod/git, and MCP allow invariants currently fail.

- [ ] **Step 3: Obtain explicit approval for permission-policy changes**

Present the redacted findings and exact allow entries that would be removed/added. Ask the user to approve the permission narrowing. If approval is withheld or modified, stop Task 4 and update the plan rather than applying a subset implicitly.

- [ ] **Step 4: Edit the encrypted canonical settings**

After approval, run: `chezmoi --source "$CONFIG_WT" edit ~/.claude/settings.json`.

Apply only the following changes that were reproduced and explicitly approved:

- replace `/home/dev/.claude/hooks/decision-audit-gate.sh` with `$HOME/.claude/hooks/decision-audit-gate.sh`;
- remove `rtk hook claude`;
- remove `Bash(rm *)`, `Bash(mv *)`, `Bash(chmod *)`, and `Bash(git *)` from auto-allow;
- add only `Bash(git status *)`, `Bash(git diff *)`, `Bash(git log *)`, `Bash(git show *)`, `Bash(git rev-parse *)`, `Bash(git ls-files *)`, and `Bash(git branch --show-current)`;
- add exact `mcp__pickforge-lanes__lanes_spawn`, `lanes_status`, `lanes_wait`, and `lanes_abandon` allows after confirming Claude's normalized server prefix.

Do not change the user's default Fable model or medium effort: medium differs from the table prior but is not a hard policy violation.

- [ ] **Step 5: Render without applying and inspect only the scoped diff**

Never print decrypted settings with `chezmoi diff`. With `umask 077`, render the target from `--source "$CONFIG_WT"` into a `0600` temporary file, run structural assertions that print invariant names only, and delete the file in a trap. Compare hashes/keys without echoing values. Verify no unrelated settings moved through redacted key-level assertions.

- [ ] **Step 6: Run invariants**

Expected: new safe-profile invariants PASS; `check-live` remains unchanged until scoped apply.

- [ ] **Step 7: Commit**

```bash
git add dot_claude/encrypted_settings.json.age scripts/check-agent-config-sync.sh
git commit -m "fix(config): tighten global tool permissions"
```

---

### Task 5: Manage user-scoped MCP registration and remove duplication

**Files:**
- Create: `run_onchange_after_configure_pickforge_lanes_mcp.sh.tmpl`
- Modify: `scripts/check-agent-config-sync.sh`

- [ ] **Step 1: Add failing script invariants**

Require the script to:

- use `claude mcp add --scope user pickforge-lanes -- pickforge-lanes-mcp`;
- be idempotent;
- never include auth headers, tokens or client secrets;
- never remove `context7` automatically;
- document the separate confirmed command for removing exactly the user-scoped `context7` entry;
- retain plugin server `plugin:context7:context7`.

- [ ] **Step 2: Implement the idempotent configuration script**

The script should run bounded `claude mcp get pickforge-lanes` with `umask 077`, redirect all output into a `0600` temporary file, compare only the server name/transport/command against `pickforge-lanes-mcp`, print invariant names rather than captured values, and delete the file in a trap. Never echo the captured output because MCP entries may contain headers. Remove/re-add only `pickforge-lanes` when the structural comparison differs. Do not parse or rewrite `~/.claude.json` directly.

Do not remove Context7 from this automatic script. Capture `claude mcp list` into a `0600` temporary file, emit only parsed server names and connection booleans, delete the file, then ask for explicit confirmation and run the separate manual command `claude mcp remove context7 --scope user`. Never print raw list/get output. Retain and recheck `plugin:context7:context7`.

- [ ] **Step 3: Test with a fake `claude` executable**

Add shell-level checks with a fake `claude` executable for absent server, matching server, changed command and failed add. Inject fake secret headers/tokens and assert they never reach stdout, stderr or logs. Assert no infinite health-check wait. Test duplicate Context7 only as a separately confirmed manual procedure, not automatic behavior.

- [ ] **Step 4: Commit**

```bash
git add run_onchange_after_configure_pickforge_lanes_mcp.sh.tmpl scripts/check-agent-config-sync.sh
git commit -m "feat(config): manage lanes MCP registration"
```

---

### Task 6: Apply and validate narrowly

**Files/targets:**
- `~/.local/bin/pickforge-lanes-mcp`
- `~/.agents/skills/multi-model-lanes/SKILL.md`
- `~/.claude/skills/multi-model-lanes`
- `~/.pi/agent/skills/multi-model-lanes`
- `~/.claude/settings.json`
- Claude user MCP registration `pickforge-lanes`

- [ ] **Step 1: Run pre-apply checks**

Run the feature worktree's checks and live `check-live` with timeouts. Stop for any failure not reproduced in Task 1's current baseline. Do not assume historical failures still exist.

- [ ] **Step 2: Review explicit scoped diffs**

Use only `chezmoi --source "$CONFIG_WT"` scoped target inspection. For encrypted settings, use secure temporary rendering plus redacted structural assertions; never print plaintext diff. Never run whole-tree status/diff/verify.

- [ ] **Step 3: Apply named targets and install the reviewed runtime**

Use `chezmoi --source "$CONFIG_WT" apply <explicit-targets...>` for the wrapper, skill links and settings. Before MCP registration, verify the reviewed runtime commit is checked out at `$HOME/Projects/Pickforge/pickforge-platform`, record its SHA, and run `bun install --frozen-lockfile` there. Run the approved MCP registration script separately if run scripts are not included by target-scoped apply.

- [ ] **Step 4: Smoke-test the applied launcher without provider calls**

Run: `~/.local/bin/pickforge-lanes-mcp </dev/null`
Expected: clean exit, no stdout diagnostics, and no orphan process. Stop before MCP registration if this fails.

- [ ] **Step 5: Restart Claude Code and Pi**

Do not assume hot reload is sufficient for global skills/settings and MCP registration.

- [ ] **Step 6: Verify managed state without exposing MCP configuration**

Run timeout-bounded `agent-config-sync check-live`. With `umask 077`, capture `claude mcp list` into a `0600` temporary file, parse and print only server names plus connected/disconnected booleans, then delete it in a trap. Never print raw MCP output.

Expected:

- `check-live` passes;
- redacted name/status output shows `pickforge-lanes` connected;
- after separately confirmed manual removal, only the official Context7 plugin server remains;
- no credential/header values are printed or stored in the plan report.

- [ ] **Step 7: Verify behavior without provider calls**

Start Claude Code in a temporary directory and confirm the four MCP tools are discoverable. Confirm native Claude workflows remain available. Confirm Pi still exposes the same four native lane tools.

- [ ] **Step 8: Request approval for the small live matrix**

After approval, run one cross-provider Claude→Sol MCP lane and one Pi→Anthropic lane. Reuse the runtime plan's already-approved prompts if available.

- [ ] **Step 9: Run local review and decision audit**

Review both the dotfiles diff and the effective rendered settings. Explicitly list permission removals, MCP registration, duplicate removal and any unresolved config-check baseline.

- [ ] **Step 10: Commit any validation-only source changes**

Use an English Conventional Commit without provider branding, attribution or trailers.

## Deployment completion gate

- [ ] Runtime plan is merged; the reviewed SHA is checked out at the launcher's primary path and its frozen dependencies are installed.
- [ ] Canonical dotfiles state was inventoried/isolated without destructive Git actions or touching user-owned changes.
- [ ] No new `agent-config-sync check` failure exists.
- [ ] `agent-config-sync check-live` passes.
- [ ] Wrapper, skill, symlinks, settings and MCP registration match canonical intent.
- [ ] Destructive filesystem/Git commands are no longer globally auto-approved.
- [ ] Decision-audit hook resolves on macOS through `$HOME`.
- [ ] Retired rtk hook is gone.
- [ ] Context7 is not duplicated.
- [ ] Claude native same-provider workflows and MCP cross-provider lanes both work.
- [ ] Every choice not explicitly specified by the user is reported before shipping.
