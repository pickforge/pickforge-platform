# @pickforge/complexity-gate

Function-complexity feedback and completion gates for Claude Code, Codex, Pi, OMP, Grok, Cursor, and OpenCode. The npm package downloads the matching Rust binary, verifies its SHA-256 checksum, and keeps installation non-fatal when a release or network is unavailable.

## Install

Requires Node 22 or newer. Set `COMPLEXITY_GATE_BIN` to an existing binary to skip the release download. Set `COMPLEXITY_GATE_VERSION` to a release tag (default `v0.2.1`).

Want your coding agent to perform the setup? Send it the [AI installation guide](https://github.com/pickforge/complexity-gate/blob/main/INSTALL_WITH_AGENT.md). It covers harness selection, hooks, plugins, agent instructions, and verification.

```bash
npm install -g @pickforge/complexity-gate
complexity-gate-install
```

The package install adds only the binary. The second command asks which harness integrations to install; choose a comma-separated list, `all`, or `none`. For automation, use `--all` or `--harness claude,codex`. `--print` prints configuration without writing, and `--home <dir>` changes the JSON hook settings root.

### Pi

```bash
pi install npm:@pickforge/complexity-gate
```

The extension checks files after `edit` and `write` tool results. Compact,
bounded summaries are appended as tool feedback. At agent-turn completion it
checks changed functions and queues up to three refactor follow-ups per session.
It never injects more than 24 lines or 8 KiB from the command.

### Claude Code

```bash
claude plugin marketplace add pickforge/pickforge-platform
claude plugin install complexity-gate@pickforge
```

Alternatively, `complexity-gate-install --harness claude` merges the equivalent hooks into `~/.claude/settings.json` without replacing existing hooks.

### Codex

```bash
complexity-gate-install --harness codex
cp -r node_modules/@pickforge/complexity-gate/codex-skill/complexity-gate ~/.codex/skills/
```

The installer merges `codex-hooks.json` into `~/.codex/hooks.json`.

### OMP

The installer runs `omp plugin install npm:@pickforge/complexity-gate`. OMP uses the same after-edit and agent-end extension as Pi.

### Grok

The installer adds native `PostToolUse` and `Stop` hooks under `~/.grok/hooks/`. If Claude Code or Cursor hooks are already selected, Grok reuses those compatible hooks to avoid running the gate twice. Edit findings appear in the hook annotation; the stop hook blocks completion until the changed functions pass.

### Cursor

The installer merges `afterFileEdit` and `stop` hooks into `~/.cursor/hooks.json`. Edit findings appear in hook output, and the stop hook sends a correction follow-up when changed functions fail.

### OpenCode

The installer runs `opencode plugin @pickforge/complexity-gate --global`, which updates OpenCode's global config. The plugin appends edit findings to tool output and continues an idle session when changed functions fail.

## Configure

Run `complexity-gate init` to create `.complexity-gate.json`. The defaults are complexity 15, depth 4, 100 nonblank/non-comment lines, and 6 parameters. See the installed skill for the refactoring workflow.

`complexity-gate check --changed` lists at most 20 failing or unverified paths.
Run its scoped `--verbose` command to inspect one file. Outside a Git repository
with `HEAD`, the command fails without scanning the current directory.

The wrapper resolves the executable in this order: `COMPLEXITY_GATE_BIN`, the verified binary under `vendor/`, then `complexity-gate` on `PATH`. stdin, stdout, stderr, argv, and exit status are inherited unchanged.

## Hook documentation

Hook formats and event names were checked against the official Claude Code, Codex, Grok, Cursor, and OpenCode documentation on 2026-09-03. Pi and OMP use their native extension API.
All integrations return compact summaries automatically. Detailed per-function
output is only produced by a deliberate, file-scoped `--verbose` check.
