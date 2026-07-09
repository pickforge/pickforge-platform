# @pickforge/flags

UI-free feature-flag registry for release gating in Pickforge apps.

```ts
import { createFlags } from "@pickforge/flags";

const flags = createFlags({
  billing: {
    description: "Gate billing entry points",
  },
  sync: {
    description: "Gate settings sync",
    default: true,
  },
});

flags.isEnabled("billing");
```

Flags are default-off release gates flipped by shipping a new default.
There is no remote config or percentage rollout support, and app UI for settings/debug surfaces stays in app repos.
