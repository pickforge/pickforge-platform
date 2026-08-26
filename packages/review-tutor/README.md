# @pickforge/review-tutor

Review Tutor is a local-first, browser-based companion for guided reviews of PRs, diffs, and code. Questions run in an isolated tutor child, never in the main Pi conversation. GitHub remains the source of truth. Review Tutor never approves, comments on, or edits a PR. Answers, notes, and quiz results stay local. Harness connectors are tracked in [#63](https://github.com/pickforge/pickforge-platform/issues/63).

## Install

This package is private and remains at version `0.0.0`, so it is not available through the npm scope. Install it from a local checkout:

```bash
pi install /absolute/path/to/packages/review-tutor
```

The package manifest loads both the extension and the tutor skill.

To try it for one Pi run without installing it:

```bash
pi -e /absolute/path/to/packages/review-tutor
```

`-e` loads the extension only; the tutor skill is registered by `pi install`. The `/review-tutor` command still works fully either way because it reads its skill file directly from the package.

## Usage

Start Pi in TUI mode inside a Git worktree, then run:

```text
/review-tutor
```

You can provide an initial source:

```text
/review-tutor worktree
/review-tutor staged
/review-tutor <commit-revision>
/review-tutor <from>...<to>
/review-tutor https://github.com/<owner>/<repo>/pull/<number>
```

With no argument, choose a source in the browser. The browser supports worktree, staged, commit, range, GitHub PR URL, and pasted code sources. It opens automatically. If that fails, Pi shows a notification with the local URL to open.

## Command line

The same tutor runs without a Pi host. Build the CLI once, then run it from any shell inside a Git worktree:

```bash
bun run --cwd packages/review-tutor build
node packages/review-tutor/dist/bin.js [source] [--no-open] [--detach] [--home <dir>]
```

An installed package exposes it as `review-tutor`. `source` accepts the same values as the Pi command and defaults to `worktree`. The URL is the only line on stdout; discovery results go to stderr. Unknown flags print usage on stderr and exit 2.

Without a Pi host, the Pi harness discovers itself through `pi --version` and `pi --list-models`, so the model list is whatever that Pi install offers. Claude Code and Codex are discovered exactly as they are under Pi.

The foreground run stays attached until Ctrl-C or `SIGTERM`. `--detach` starts the server in its own process, prints the URL, and returns; that detached server exits by itself after 30 minutes with no page connected, or on `SIGTERM`.

## Model selection

The model dialog lists the session's scoped models when `--models` or the settings scope configures them. Otherwise, it lists all available models. Thinking levels are offered only for reasoning models. Thinking levels are enforced by the server's model membership check. A scope entry with an explicit level, such as `gpt-5.6-sol:high`, pins the tutor to that level.

## Harness connectors

A harness connector owns model discovery, isolated invocation, and stream parsing while the shared runner owns process lifetime, bounds, and cancellation. Pi, Claude Code, and Codex are registered; a connector appears in the Harness picker only when its executable is found and supported at startup, and the helper line explains any that are not. Child processes receive only the shared environment allowlist plus keys explicitly declared by their connector, and runner failures redact common API keys, bearer credentials, and tokens before leaving the process boundary.

The Claude Code connector forwards `CLAUDE_CONFIG_DIR` when present, but never forwards `ANTHROPIC_API_KEY`; users who rely on that environment key must sign in through Claude Code instead.

The Harness select in the configuration rail lists the harnesses discovery found, Pi first. The line under it reports the rest: how many are available, or why one is not. Discovery runs once at server start, so restart Pi to re-discover. Choosing a harness refills Model and Thinking with that harness's models and restores the model you last used there.

The Codex connector discovers models through `codex app-server`, invokes reviews with `codex exec --json`, and relies on Codex's existing local authentication.

## Local data

By default, data is stored under:

```text
~/.pickforge/review-tutor/
~/.pickforge/review-tutor/projects/<sha256-of-canonical-repo-path>/project.json
~/.pickforge/review-tutor/projects/<sha256-of-canonical-repo-path>/log.jsonl
~/.pickforge/review-tutor/projects/<sha256-of-canonical-repo-path>/inputs/
```

Set `REVIEW_TUTOR_HOME` to a non-empty absolute path to replace the root. HTML exports are self-contained and work offline.

## Security boundary

The HTTP server binds only to `127.0.0.1` and uses a per-session bearer token carried in the page URL. Tutor questions run in an isolated Pi child with no session, extensions, skills, prompt templates, or context files. The exact tool allowlist is `read`, `grep`, `find`, and `ls`. The child receives an allowlisted environment and runs read-only tools. Provider credentials are not sent to the browser. Review Tutor performs no PR writes.

## GitHub PR snapshots

For a GitHub PR, Review Tutor runs `gh pr view` to read the head SHA, then `gh pr diff --patch`, then `gh pr view` again. It rejects the source if `headRefOid` changed between the two views and asks you to retry. An accepted snapshot is pinned to that one immutable head SHA. Its provenance link is:

```text
<pr-url>/commits/<head-sha>
```

## Supported platforms

Linux is validated end to end. macOS code paths exist for `open` and process groups, but are not yet validated. Windows code paths exist for `cmd start` and non-detached kill, but are unproven.
