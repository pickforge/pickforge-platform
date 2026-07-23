export interface UpdateInfo {
  version: string;
  notes?: string;
}

export type UpdateDownloadEvent =
  | { type: "started"; contentLength?: number }
  | { type: "progress"; chunkLength: number }
  | { type: "finished" };

export interface UpdateAdapter {
  check(): Promise<UpdateInfo | null>;
  downloadAndInstall(onEvent: (event: UpdateDownloadEvent) => void): Promise<void>;
  relaunch(): Promise<void>;
}

export interface UpdateEligibility {
  whenEligible(): Promise<boolean>;
}

export interface StaticEligibility {
  packaged: boolean;
  mainWindow: boolean;
  visible: boolean;
  focused: boolean;
}

export interface DownloadProgress {
  downloaded: number;
  contentLength: number | null;
  percent: number | null;
}

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; update: UpdateInfo }
  | { status: "downloading"; update: UpdateInfo; progress: DownloadProgress }
  | { status: "installing"; update: UpdateInfo }
  | { status: "restarting" }
  | { status: "dismissed"; update?: UpdateInfo }
  | {
      status: "error";
      update?: UpdateInfo;
      message: string;
      retry: "check" | "install" | "relaunch";
    };

export interface ProcessCheckGate {
  run(check: () => Promise<UpdateInfo | null>): Promise<UpdateInfo | null>;
}

export interface UpdateController {
  getState(): UpdateState;
  start(): Promise<void>;
  check(options?: { silent?: boolean; manual?: boolean }): Promise<void>;
  install(): Promise<void>;
  retry(): Promise<void>;
  dismiss(): void;
  subscribe(listener: (state: UpdateState) => void): () => void;
}

const defaultProcessGate = createProcessCheckGate();

export function createProcessCheckGate(): ProcessCheckGate {
  let result: Promise<UpdateInfo | null> | undefined;

  return {
    run(check) {
      result ??= Promise.resolve().then(check).catch((error: unknown) => {
        result = undefined;
        throw error;
      });
      return result;
    },
  };
}

export function createEligibility(value: StaticEligibility): UpdateEligibility {
  return {
    async whenEligible() {
      return value.packaged && value.mainWindow && value.visible && value.focused;
    },
  };
}

// eslint-disable-next-line max-lines-per-function -- TODO(#57): split the legacy update controller factory.
export function createUpdateController(options: {
  adapter: UpdateAdapter;
  eligibility: UpdateEligibility;
  gate?: ProcessCheckGate;
}): UpdateController {
  const { adapter, eligibility } = options;
  const gate = options.gate ?? defaultProcessGate;
  const listeners = new Set<(state: UpdateState) => void>();
  let state: UpdateState = { status: "idle" };
  let update: UpdateInfo | undefined;
  let started = false;
  let lastManual = false;
  let generation = 0;

  const setState = (next: UpdateState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const check = async ({
    silent = false,
    manual = false,
  // eslint-disable-next-line complexity -- TODO(#57): split the legacy update check flow.
  }: { silent?: boolean; manual?: boolean } = {}): Promise<void> => {
    if (manual) {
      if (isBusy(state)) return;
    } else if (state.status === "dismissed" || (started && state.status !== "idle")) {
      return;
    }
    started = true;
    lastManual = manual;
    generation += 1;
    const epoch = generation;
    setState({ status: "checking" });
    try {
      const found = manual ? await adapter.check() : await gate.run(() => adapter.check());
      if (epoch !== generation) return;
      if (!manual && state.status === "dismissed") {
        if (found !== null) {
          update = found;
          setState({ status: "dismissed", update: found });
        }
        return;
      }
      if (found === null) {
        setState({ status: "idle" });
        return;
      }
      update = found;
      setState({ status: "available", update: found });
    } catch (error) {
      if (epoch !== generation) return;
      if (!manual && state.status === "dismissed") return;
      setState(
        !manual && silent
          ? { status: "idle" }
          : { status: "error", message: errorMessage(error), retry: "check" },
      );
    }
  };

  const install = async (): Promise<void> => {
    if (update === undefined) return;
    if (isBusy(state)) return;
    const selected = update;
    let downloaded = 0;
    let contentLength: number | null = null;
    let finished = false;
    setState({
      status: "downloading",
      update: selected,
      progress: { downloaded, contentLength, percent: null },
    });

    try {
      await adapter.downloadAndInstall((event) => {
        if (event.type === "started") {
          contentLength =
            event.contentLength !== undefined && event.contentLength > 0
              ? event.contentLength
              : null;
          downloaded = 0;
          setState({
            status: "downloading",
            update: selected,
            progress: progress(downloaded, contentLength),
          });
          return;
        }
        if (event.type === "progress") {
          downloaded += Math.max(0, event.chunkLength);
          setState({
            status: "downloading",
            update: selected,
            progress: progress(downloaded, contentLength),
          });
          return;
        }
        finished = true;
        setState({ status: "installing", update: selected });
      });
      if (!finished) setState({ status: "installing", update: selected });
      setState({ status: "restarting" });
      await adapter.relaunch();
    } catch (error) {
      setState({
        status: "error",
        update: selected,
        message: errorMessage(error),
        retry: state.status === "restarting" ? "relaunch" : "install",
      });
    }
  };

  const retry = async (): Promise<void> => {
    if (state.status !== "error") return;
    if (state.retry === "install") {
      await install();
      return;
    }
    if (state.retry === "relaunch") {
      setState({ status: "restarting" });
      try {
        await adapter.relaunch();
      } catch (error) {
        setState({
          status: "error",
          update,
          message: errorMessage(error),
          retry: "relaunch",
        });
      }
      return;
    }
    started = false;
    await check({ manual: lastManual });
  };

  return {
    getState: () => state,
    async start() {
      if (!(await eligibility.whenEligible())) return;
      await check({ silent: true });
    },
    check,
    install,
    retry,
    dismiss() {
      if (isBusy(state)) return;
      setState(
        update === undefined
          ? { status: "dismissed" }
          : { status: "dismissed", update },
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function isBusy(current: UpdateState): boolean {
  return (
    current.status === "downloading" ||
    current.status === "installing" ||
    current.status === "restarting"
  );
}

function progress(downloaded: number, contentLength: number | null): DownloadProgress {
  return {
    downloaded,
    contentLength,
    percent:
      contentLength === null
        ? null
        : Math.min(100, Math.round((downloaded / contentLength) * 100)),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The update could not be completed.";
}
