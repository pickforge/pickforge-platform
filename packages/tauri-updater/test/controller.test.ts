import { describe, expect, it, vi } from "vitest";

import {
  createEligibility,
  createProcessCheckGate,
  createUpdateController,
  type UpdateAdapter,
  type UpdateDownloadEvent,
} from "../src/index";

function adapter(options: {
  update?: { version: string; notes?: string } | null;
  checkError?: Error;
  events?: UpdateDownloadEvent[];
} = {}): UpdateAdapter {
  return {
    check: vi.fn(async () => {
      if (options.checkError !== undefined) throw options.checkError;
      return options.update === undefined
        ? { version: "2.0.0", notes: "Safer updates" }
        : options.update;
    }),
    downloadAndInstall: vi.fn(async (onEvent) => {
      for (const event of options.events ?? []) onEvent(event);
    }),
    relaunch: vi.fn(async () => undefined),
  };
}

const eligible = createEligibility({
  packaged: true,
  mainWindow: true,
  visible: true,
  focused: true,
});

describe("createUpdateController", () => {
  it("does nothing outside packaged visible focused main windows", async () => {
    for (const eligibility of [
      createEligibility({ packaged: false, mainWindow: true, visible: true, focused: true }),
      createEligibility({ packaged: true, mainWindow: false, visible: true, focused: true }),
      createEligibility({ packaged: true, mainWindow: true, visible: false, focused: true }),
      createEligibility({ packaged: true, mainWindow: true, visible: true, focused: false }),
    ]) {
      const updateAdapter = adapter();
      const controller = createUpdateController({
        adapter: updateAdapter,
        eligibility,
        gate: createProcessCheckGate(),
      });
      await controller.start();
      expect(updateAdapter.check).not.toHaveBeenCalled();
      expect(controller.getState()).toEqual({ status: "idle" });
    }
  });

  it("defers startup until the main window becomes visible and focused", async () => {
    let release!: (eligible: boolean) => void;
    const updateAdapter = adapter();
    const controller = createUpdateController({
      adapter: updateAdapter,
      eligibility: {
        whenEligible: () => new Promise((resolve) => { release = resolve; }),
      },
      gate: createProcessCheckGate(),
    });

    const starting = controller.start();
    await Promise.resolve();
    expect(updateAdapter.check).not.toHaveBeenCalled();
    release(true);
    await starting;
    expect(controller.getState()).toMatchObject({
      status: "available",
      update: { version: "2.0.0" },
    });
  });

  it("checks once per process gate across controllers", async () => {
    const updateAdapter = adapter();
    const gate = createProcessCheckGate();
    const first = createUpdateController({ adapter: updateAdapter, eligibility: eligible, gate });
    const second = createUpdateController({ adapter: updateAdapter, eligibility: eligible, gate });

    await Promise.all([first.start(), second.start()]);
    expect(updateAdapter.check).toHaveBeenCalledTimes(1);
    expect(first.getState().status).toBe("available");
    expect(second.getState().status).toBe("available");
  });

  it("stays idle when no update exists or a startup check fails", async () => {
    const noUpdate = createUpdateController({
      adapter: adapter({ update: null }),
      eligibility: eligible,
      gate: createProcessCheckGate(),
    });
    const failed = createUpdateController({
      adapter: adapter({ checkError: new Error("offline") }),
      eligibility: eligible,
      gate: createProcessCheckGate(),
    });

    await expect(noUpdate.start()).resolves.toBeUndefined();
    await expect(failed.start()).resolves.toBeUndefined();
    expect(noUpdate.getState()).toEqual({ status: "idle" });
    expect(failed.getState()).toEqual({ status: "idle" });
  });

  it("shows manual check failures and retries them", async () => {
    const updateAdapter = adapter();
    vi.mocked(updateAdapter.check)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ version: "2.0.0" });
    const controller = createUpdateController({
      adapter: updateAdapter,
      eligibility: eligible,
      gate: createProcessCheckGate(),
    });

    await controller.check();
    expect(controller.getState()).toMatchObject({
      status: "error",
      message: "offline",
      retry: "check",
    });
    await controller.retry();
    expect(controller.getState()).toMatchObject({ status: "available" });
    expect(updateAdapter.check).toHaveBeenCalledTimes(2);
  });

  it("dismisses for this process and does not check again", async () => {
    const updateAdapter = adapter();
    const controller = createUpdateController({
      adapter: updateAdapter,
      eligibility: eligible,
      gate: createProcessCheckGate(),
    });

    await controller.start();
    controller.dismiss();
    await controller.check();
    expect(controller.getState().status).toBe("dismissed");
    expect(updateAdapter.check).toHaveBeenCalledTimes(1);
  });

  it("reports determinate progress before installing and relaunching", async () => {
    const updateAdapter = adapter({
      events: [
        { type: "started", contentLength: 100 },
        { type: "progress", chunkLength: 25 },
        { type: "progress", chunkLength: 50 },
        { type: "finished" },
      ],
    });
    const controller = createUpdateController({
      adapter: updateAdapter,
      eligibility: eligible,
      gate: createProcessCheckGate(),
    });
    const states: string[] = [];
    const progresses: Array<number | null> = [];
    controller.subscribe((state) => {
      states.push(state.status);
      if (state.status === "downloading") progresses.push(state.progress.percent);
    });

    await controller.start();
    await controller.install();

    expect(states).toEqual(expect.arrayContaining([
      "checking",
      "available",
      "downloading",
      "installing",
      "restarting",
    ]));
    expect(progresses).toEqual([null, 0, 25, 75]);
    expect(updateAdapter.relaunch).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toEqual({ status: "restarting" });
  });

  it("uses indeterminate progress when content length is absent", async () => {
    const updateAdapter = adapter({
      events: [{ type: "started" }, { type: "progress", chunkLength: 25 }],
    });
    const controller = createUpdateController({
      adapter: updateAdapter,
      eligibility: eligible,
      gate: createProcessCheckGate(),
    });
    const progresses: Array<number | null> = [];
    controller.subscribe((state) => {
      if (state.status === "downloading") progresses.push(state.progress.percent);
    });

    await controller.start();
    await controller.install();
    expect(progresses).toEqual([null, null, null]);
  });

  it("surfaces install errors and retries the retained update", async () => {
    let attempts = 0;
    const updateAdapter = adapter();
    vi.mocked(updateAdapter.downloadAndInstall).mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
    });
    const controller = createUpdateController({
      adapter: updateAdapter,
      eligibility: eligible,
      gate: createProcessCheckGate(),
    });

    await controller.start();
    await controller.install();
    expect(controller.getState()).toMatchObject({
      status: "error",
      message: "disk full",
      retry: "install",
    });
    await controller.retry();
    expect(updateAdapter.downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toEqual({ status: "restarting" });
  });

  it("protects in-progress installation from dismissal", async () => {
    let release!: () => void;
    const updateAdapter = adapter();
    vi.mocked(updateAdapter.downloadAndInstall).mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const controller = createUpdateController({
      adapter: updateAdapter,
      eligibility: eligible,
      gate: createProcessCheckGate(),
    });
    await controller.start();
    const installing = controller.install();
    controller.dismiss();
    expect(controller.getState().status).toBe("downloading");
    release();
    await installing;
  });

  it("stops notifications after unsubscribe", async () => {
    const controller = createUpdateController({
      adapter: adapter(),
      eligibility: eligible,
      gate: createProcessCheckGate(),
    });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    unsubscribe();
    await controller.start();
    expect(listener).not.toHaveBeenCalled();
  });
});
