# @pickforge/tauri-updater

Framework-neutral update control and a branded `<pickforge-update-dialog>` Web Component for Tauri desktop apps.

```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  createTauriUpdaterAdapter,
  createUpdateController,
  definePickforgeUpdaterElement,
} from "@pickforge/tauri-updater";

const controller = createUpdateController({
  adapter: createTauriUpdaterAdapter({ check, relaunch }),
  eligibility: {
    // Resolve only after the packaged app's focused, visible main window is ready.
    whenEligible: async () => true,
  },
});

definePickforgeUpdaterElement();
const dialog = document.querySelector("pickforge-update-dialog");
dialog.metadata = { productName: "PickForge", currentVersion: "1.0.0" };
dialog.controller = controller;
void controller.start();
```

`start()` silently ignores unavailable feeds and no-update responses, checking once per process through the shared gate. `check({ manual: true })` is for a Settings-style "check for updates" action: it clears a `dismissed` state, always performs a fresh `adapter.check()` bypassing the process gate's cached result, and reports failures as a retryable `error` state instead of staying silent. A `dismissed` state from `dismiss()` only blocks the automatic `start()`/`check()` path; a late-resolving automatic check that finds an update after the user has since dismissed keeps the `dismissed` status (retaining the update for bookkeeping) rather than reopening the dialog. The default process gate shares the first check across controllers; inject `createProcessCheckGate()` to isolate deterministic tests.

Build the package and serve `fixture/` from the repository root to inspect the standalone states.
