import { describe, expect, it, vi } from "vitest";

import { createTauriUpdaterAdapter } from "../src/index";

describe("createTauriUpdaterAdapter", () => {
  it("maps Tauri metadata and delegates install events and relaunch", async () => {
    const downloadAndInstall = vi.fn(async (callback: (event: never) => void) => {
      callback({ event: "Started", data: { contentLength: 10 } } as never);
      callback({ event: "Progress", data: { chunkLength: 4 } } as never);
      callback({ event: "Finished" } as never);
    });
    const relaunch = vi.fn(async () => undefined);
    const adapter = createTauriUpdaterAdapter({
      check: vi.fn(async () => ({ version: "2.0.0", body: "Notes", downloadAndInstall })),
      relaunch,
    });
    const events: unknown[] = [];

    await expect(adapter.check()).resolves.toEqual({ version: "2.0.0", notes: "Notes" });
    await adapter.downloadAndInstall((event) => events.push(event));
    await adapter.relaunch();

    expect(events).toEqual([
      { type: "started", contentLength: 10 },
      { type: "progress", chunkLength: 4 },
      { type: "finished" },
    ]);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("rejects installation before a successful check", async () => {
    const adapter = createTauriUpdaterAdapter({
      check: vi.fn(async () => null),
      relaunch: vi.fn(async () => undefined),
    });
    await adapter.check();
    await expect(adapter.downloadAndInstall(() => undefined)).rejects.toThrow(
      "No update is available",
    );
  });
});
