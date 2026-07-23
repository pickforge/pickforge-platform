// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEligibility,
  createProcessCheckGate,
  createUpdateController,
  definePickforgeUpdaterElement,
  type UpdateAdapter,
  type UpdateController,
} from "../src/index";

const elements: Element[] = [];
afterEach(() => {
  for (const element of elements.splice(0)) element.remove();
});

function setup(options: { notes?: string } = {}): {
  adapter: UpdateAdapter;
  controller: UpdateController;
  root: ShadowRoot;
} {
  definePickforgeUpdaterElement();
  const adapter: UpdateAdapter = {
    check: vi.fn(async () => ({ version: "2.0.0", notes: options.notes })),
    downloadAndInstall: vi.fn(async () => undefined),
    relaunch: vi.fn(async () => undefined),
  };
  const controller = createUpdateController({
    adapter,
    eligibility: createEligibility({
      packaged: true,
      mainWindow: true,
      visible: true,
      focused: true,
    }),
    gate: createProcessCheckGate(),
  });
  const element = document.createElement("pickforge-update-dialog") as HTMLElement & {
    controller: UpdateController;
    metadata: { productName: string; currentVersion: string; productMark: string };
  };
  element.metadata = {
    productName: "PickForge",
    currentVersion: "1.0.0",
    productMark: "PF",
  };
  element.controller = controller;
  document.body.append(element);
  elements.push(element);
  return { adapter, controller, root: element.shadowRoot! };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("pickforge-update-dialog", () => {
  it("renders a labelled native dialog with plain-text notes and primary focus", async () => {
    const { controller, root } = setup({
      notes: "<img src=x onerror=alert(1)>\nA useful fix",
    });
    await controller.start();
    await flush();

    const dialog = root.querySelector("dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.getAttribute("aria-labelledby")).toBe("pf-updater-title");
    expect(dialog.getAttribute("aria-describedby")).toBe("pf-updater-description");
    expect(root.querySelector(".notes")?.textContent).toContain("<img");
    expect(root.querySelector(".notes img")).toBeNull();
    expect(root.activeElement?.textContent).toContain("Update & restart");
  });

  it("dismisses with Later or Escape before download", async () => {
    const later = setup();
    await later.controller.start();
    await flush();
    (later.root.querySelector('[data-action="later"]') as HTMLButtonElement).click();
    expect(later.controller.getState().status).toBe("dismissed");

    const escape = setup();
    await escape.controller.start();
    await flush();
    escape.root
      .querySelector("dialog")!
      .dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(escape.controller.getState().status).toBe("dismissed");
  });

  it("does not dismiss from Escape after download begins or from backdrop clicks", async () => {
    let release!: () => void;
    const { adapter, controller, root } = setup();
    vi.mocked(adapter.downloadAndInstall).mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    await controller.start();
    await flush();
    (root.querySelector('[data-action="install"]') as HTMLButtonElement).click();
    await flush();
    const dialog = root.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(controller.getState().status).toBe("downloading");
    release();
  });

  it("renders progress and retryable errors", async () => {
    const { adapter, controller, root } = setup();
    vi.mocked(adapter.downloadAndInstall).mockImplementation(async (onEvent) => {
      onEvent({ type: "started", contentLength: 100 });
      onEvent({ type: "progress", chunkLength: 40 });
      throw new Error("Could not install");
    });
    await controller.start();
    await flush();
    (root.querySelector('[data-action="install"]') as HTMLButtonElement).click();
    await flush();

    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Could not install");
    expect(root.querySelector('[data-action="retry"]')).not.toBeNull();
    expect(root.querySelector('[data-action="later"]')).not.toBeNull();
    expect(root.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});
