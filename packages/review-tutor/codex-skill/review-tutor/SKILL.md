---
name: review-tutor
description: Open the Review Tutor when the user asks for a review, PR, diff, or tutor session.
---

Run this command in the repository root:

```bash
npx -y @pickforge/review-tutor <source> --detach
```

`<source>` can be `worktree`, `staged`, `a...b`, a commit, or a GitHub PR URL.

Print the URL to the user verbatim. Do not open or fetch the URL yourself.
