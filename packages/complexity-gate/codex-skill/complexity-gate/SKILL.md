---
name: complexity-gate
description: Measure and reduce function complexity with the complexity-gate binary. Use for every coding and code-review task, when a complexity-gate hook reports FAIL lines, or when the user asks to refactor or simplify code.
---

# Complexity gate

For every coding or code-review task, run `complexity-gate check --changed`
before completion. Hooks provide immediate feedback but do not replace this final check.

Never estimate complexity yourself. The only accepted numbers come from:

```bash
complexity-gate check <file>        # one file
complexity-gate check --changed     # compact list of changed files that need work
complexity-gate check --changed --verbose <file>
```

The changed check reports counts and at most 20 paths. Use its `DETAILS` command
for one file at a time. Detailed output is
`FAIL path:line name  metric value > limit`. Metrics include `complexity`,
`depth`, `lines`, and `params`. `UNVERIFIED path` means no grammar for that
language: say so in your report, do not count by hand.

The Stop hook re-runs `--changed` when you try to finish and blocks while any
FAIL remains. Fix the listed functions; do not suppress, rename, or move them to
escape the diff.

## Refactor tactics, in order of preference

1. **Guard clauses.** Invert conditions, return early, kill nesting.
2. **Extract function.** Each piece gets a name that says what, not how.
3. **Lookup table / map** instead of if-else or switch chains.
4. **Named predicates.** `if (isEligibleForRefund(order))` beats a 4-clause boolean.
5. **Polymorphism / strategy** for switch-on-type, only when the switch appears in 2+ places.
6. **Flatten loops.** Extract the loop body; use `continue` instead of nested `if`.

## Hard rules

- Preserve behavior. Run tests before and after. No tests: say so, refactor conservatively.
- Don't game the metric. A dense one-liner hiding six branches is worse than the
  honest if-chain it replaced. Complexity moves into well-named units, it does not
  disappear into cleverness.
- Don't break public APIs or exported signatures without asking.
- One responsibility per function. If the name needs "and", split.
- Never raise a limit in `.complexity-gate.json` to get green. Legacy code you
  did not touch is not your problem; the gate only checks changed functions.

## Workflow

1. Run `complexity-gate check --changed` from inside the repository.
2. Choose one listed file and run its scoped `--verbose` command.
3. Refactor the worst violation, then rerun the compact check.
4. Report only functions changed and tests run. Do not print `PASS` lines.

Use this compact report shape when a refactor was required:

```
## Complexity report
| Function | Metric | Before | After |
|----------|--------|--------|-------|
| parseOrder | complexity | 18 | 6 |

Extracted: validateHeader, resolveDiscount
Behavior verified: <tests run / how>
```
