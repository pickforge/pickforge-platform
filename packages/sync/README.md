# @pickforge/sync

UI-free settings sync helpers for Pickforge apps.

```ts
import { pullAll, pushGroup } from "@pickforge/sync";

const records = await pullAll({ supabase, userId });

const result = await pushGroup({
  supabase,
  userId,
  group: "appSettings",
  payload: nextSettings,
  updatedAt: new Date().toISOString(),
});

if (result.status === "stale") {
  await mergeSyncConflict(result.record);
}
```

Pull on sign-in, then push changed groups with the local edit timestamp. Writes use last-writer-wins per field group: newer `updatedAt` values replace older rows, while stale pushes return the server row for app-side merge or rebase. If the server row is a tombstone, the stale result has `record: null`.

`updatedAt` is normalized to canonical UTC `YYYY-MM-DDTHH:mm:ss.ffffffZ` for storage and lexicographic LWW comparison. Pass microsecond timestamps when edits can happen inside the same millisecond.

`deleteGroup` writes a tombstone with the caller's timestamp instead of hard-deleting the row. Pulls skip tombstoned groups, older pushes stay stale, and a newer push clears the tombstone.

The sync boundary is intentionally narrow. Only `appSettings`, `operatorConfig`, `keybindings`, and `remoteBindings` are valid groups. `sanitizeSyncPayload` runs on every push and rejects API keys, tokens, secrets, passwords, credentials, absolute local paths, serial-like values, and long mixed-class token strings. `remoteBindings.remoteRoot` may contain absolute POSIX remote-host paths only.

v1 stores plaintext rows. The client sanitizer is the primary gate, and the database check catches unambiguous token formats. Full server-blindness is deferred to E2EE work; a server operator can read plaintext rows in v1, so secrets stay excluded structurally. Apps must still provide explicit opt-in UI, per-group toggles, per-machine override handling, and the merge strategy for stale writes.
