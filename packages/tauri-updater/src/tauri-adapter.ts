import type { UpdateAdapter, UpdateDownloadEvent } from "./controller";

export type TauriDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface TauriUpdate {
  version: string;
  body?: string;
  downloadAndInstall(onEvent: (event: TauriDownloadEvent) => void): Promise<void>;
}

export interface TauriUpdaterBindings {
  check(): Promise<TauriUpdate | null>;
  relaunch(): Promise<void>;
}

export function createTauriUpdaterAdapter(bindings: TauriUpdaterBindings): UpdateAdapter {
  let selected: TauriUpdate | null = null;

  return {
    async check() {
      selected = await bindings.check();
      if (selected === null) return null;
      return {
        version: selected.version,
        ...(selected.body === undefined ? {} : { notes: selected.body }),
      };
    },
    async downloadAndInstall(onEvent) {
      if (selected === null) throw new Error("No update is available to install.");
      await selected.downloadAndInstall((event) => onEvent(normalizeEvent(event)));
    },
    relaunch: () => bindings.relaunch(),
  };
}

function normalizeEvent(event: TauriDownloadEvent): UpdateDownloadEvent {
  if (event.event === "Started") {
    return {
      type: "started",
      ...(event.data.contentLength === undefined
        ? {}
        : { contentLength: event.data.contentLength }),
    };
  }
  if (event.event === "Progress") {
    return { type: "progress", chunkLength: event.data.chunkLength };
  }
  return { type: "finished" };
}
