---
name: review-tutor
description: Open the Review Tutor for a review, PR, diff, or commit in your browser. Use when the user asks to review, walk through, or learn from a PR, diff, commit, or the current worktree.
allowed-tools: Bash(npx -y @pickforge/review-tutor *)
---

From the repository root, use Bash to run `npx -y @pickforge/review-tutor <source> --detach`.
Pass the user's argument as ONE single-quoted argv (`'…'`), defaulting to `'worktree'` when absent.
Accepted forms are `worktree`, `staged`, `a...b`, a commit, or a GitHub PR URL.
If the argument contains anything outside `[A-Za-z0-9._/:@#~^-]`, refuse and ask the user to re-enter it.
Print the single URL line verbatim to the user.
Never open, fetch, or curl the URL.
Nothing from the conversation is sent to the tutor.
