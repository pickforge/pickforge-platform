# @pickforge/complexity-gate

Function-complexity feedback and stop gates for Pi, Claude Code, and Codex. The npm package downloads the matching Rust binary, verifies its SHA-256 checksum, and keeps install non-fatal when a release or network is unavailable.

## Install

Requires Node 22 or newer. Set `COMPLEXITY_GATE_BIN` to an existing binary to skip the release download. Set `COMPLEXITY_GATE_VERSION` to a release tag (default `v0.1.0`).

```bash
npm install -g @pickforge/complexity-gate
complexity-gate-install --all
```

Choose one or more harnesses with `--harness claude,codex,pi`. With no flags, the installer prompts for a comma-separated list. `--print` prints configuration without writing, and `--home <dir>` changes the settings root.

### Pi

```bash
pi install npm:@pickforge/complexity-gate
```

The extension checks files after `edit` and `write` tool results. Violations are appended as tool feedback. At agent-turn completion it checks changed functions and queues up to three refactor follow-ups per session.

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

## Configure

Run `complexity-gate init` to create `.complexity-gate.json`. The defaults are complexity 15, depth 4, 100 nonblank/non-comment lines, and 6 parameters. See the installed skill for the refactoring workflow.

The wrapper resolves the executable in this order: `COMPLEXITY_GATE_BIN`, the verified binary under `vendor/`, then `complexity-gate` on `PATH`. stdin, stdout, stderr, argv, and exit status are inherited unchanged.

## Hook documentation

Hook formats and event names were checked against the Claude Code plugin/hooks and Codex hooks documentation on 2026-07-08. Both currently expose `PostToolUse` and `Stop`; both fragments invoke the Rust binary's harness-specific hook adapter.
