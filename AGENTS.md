# Repo Guidance

- Start test-first by default. For bugs, add a failing regression test first when practical.
- Add characterization tests before risky refactors.
- Keep tests in the same PR as behavior changes.
- Do not lower coverage thresholds without explicit maintainer approval.
- Keep durable domain and business behavior out of UI components where applicable, without adding DDD ceremony.
- Use Bun workspace commands from the repo root: `bun run typecheck`, `bun run test`, `bun run test:coverage`, and `bun run build`.
## Pickforge workspace policy

This repo is part of the Pickforge workspace. Before substantial work, read `../AGENTS.md` (or `/home/dev/Projects/Pickforge/AGENTS.md`) and use the `plan-issue` workflow: GitHub Issues are the canonical plan/progress tracker; local todos are only a mirror. Link PRs to tracking issues and file follow-up issues for valid deferred review/CI problems.
