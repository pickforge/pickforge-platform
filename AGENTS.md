# Repo Guidance

- Start test-first by default. For bugs, add a failing regression test first when practical.
- Add characterization tests before risky refactors.
- Keep tests in the same PR as behavior changes.
- Do not lower coverage thresholds without explicit maintainer approval.
- Keep durable domain and business behavior out of UI components where applicable, without adding DDD ceremony.
- Use Bun workspace commands from the repo root: `bun run typecheck`, `bun run test`, `bun run test:coverage`, and `bun run build`.

## Web Components

- Stateful DOM nodes (dialog, live regions) must stay stable across renders — full innerHTML rebuilds on state ticks replay showModal/animations and break assistive-tech announcements.

## Workspace policy

For substantial work, read `../AGENTS.md` (workspace root) and use the `plan-issue` workflow — GitHub Issues are the canonical plan/progress tracker.

## Shipped skills

Never pair a pre-approved `allowed-tools: Bash(...)` rule with a model-invocable skill whose command argument the model supplies. Permission matching splits on compound operators but not on `$(...)`, so the pre-approval becomes a shell-injection path reachable from any untrusted text the model is reading. Either keep the skill human-invocable (`disable-model-invocation: true`) or drop the pre-approval so the call is confirmed.

