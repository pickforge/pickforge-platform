# Repo Guidance

- Start test-first by default. For bugs, add a failing regression test first when practical.
- Add characterization tests before risky refactors.
- Keep tests in the same PR as behavior changes.
- Do not lower coverage thresholds without explicit maintainer approval.
- Keep durable domain and business behavior out of UI components where applicable, without adding DDD ceremony.
- Use Bun workspace commands from the repo root: `bun run typecheck`, `bun run test`, `bun run test:coverage`, and `bun run build`.
## Workspace policy

For substantial work, read `../AGENTS.md` (workspace root) and use the `plan-issue` workflow — GitHub Issues are the canonical plan/progress tracker.

## pi-kit conventions

- Pi extension handlers must never let an exception escape into the parent
  session: wrap handler bodies, return `isError` tool results, and treat UI
  calls as fallible.
- The lane runner owns child processes end to end: spawn detached (own
  process group), kill by group with SIGTERM→SIGKILL escalation, reap on
  parent exit, cap stdout buffering.
- Gate matching is token-based, never substring regex: strip env assignments
  and git global options before comparing subcommands.
