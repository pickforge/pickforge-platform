import type { UpdateController, UpdateState } from "./controller";

export interface UpdateDialogMetadata {
  productName: string;
  currentVersion: string;
  productMark?: string;
}

const DEFAULT_METADATA: UpdateDialogMetadata = {
  productName: "Pickforge",
  currentVersion: "—",
  productMark: "PF",
};

const HTMLElementBase = (globalThis.HTMLElement ?? class extends EventTarget {}) as typeof HTMLElement;

export class PickforgeUpdateDialogElement extends HTMLElementBase {
  readonly #root = this.attachShadow({ mode: "open" });
  #controller: UpdateController | undefined;
  #metadata = DEFAULT_METADATA;
  #unsubscribe: (() => void) | undefined;
  #state: UpdateState = { status: "idle" };
  #restoreFocus: HTMLElement | null = null;

  set controller(value: UpdateController | undefined) {
    if (this.#controller === value) return;
    this.#unsubscribe?.();
    this.#controller = value;
    this.#state = value?.getState() ?? { status: "idle" };
    if (this.isConnected && value !== undefined) {
      this.#unsubscribe = value.subscribe((state) => {
        this.#state = state;
        this.#render();
      });
    }
    this.#render();
  }

  get controller(): UpdateController | undefined {
    return this.#controller;
  }

  set metadata(value: UpdateDialogMetadata) {
    this.#metadata = { ...DEFAULT_METADATA, ...value };
    this.#render();
  }

  get metadata(): UpdateDialogMetadata {
    return this.#metadata;
  }

  connectedCallback(): void {
    if (this.#controller !== undefined && this.#unsubscribe === undefined) {
      this.#unsubscribe = this.#controller.subscribe((state) => {
        this.#state = state;
        this.#render();
      });
    }
    this.#render();
  }

  disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#close();
  }

  #render(): void {
    const previousDialog = this.#root.querySelector("dialog");
    const wasOpen = previousDialog?.hasAttribute("open") === true;
    if (!isVisibleState(this.#state)) {
      this.#root.innerHTML = `<style>${STYLES}</style>`;
      if (wasOpen) this.#restoreFocus?.focus();
      this.#restoreFocus = null;
      return;
    }

    const state = this.#state;
    const update = "update" in state ? state.update : undefined;
    const notes = update?.notes?.trim();
    const isAvailable = state.status === "available";
    const isError = state.status === "error";
    const isDownloading = state.status === "downloading";
    const isInstalling = state.status === "installing";
    const isRestarting = state.status === "restarting";
    const title = isError
      ? "Update paused"
      : isRestarting
        ? "Update installed"
        : isDownloading || isInstalling
          ? "Updating your app"
          : "A new version is ready";
    const description = isError
      ? "The app remains available. Retry when you’re ready."
      : isRestarting
        ? "Restarting to finish the update."
        : notes ?? "Download the latest Pickforge Studio release.";

    this.#root.innerHTML = `
      <style>${STYLES}</style>
      <dialog aria-labelledby="pf-updater-title" aria-describedby="pf-updater-description">
        <section class="card">
          <header>
            <span class="mark" aria-hidden="true"></span>
            <span class="eyebrow">UPDATE AVAILABLE</span>
          </header>
          <h2 id="pf-updater-title"></h2>
          <p id="pf-updater-description" class="description"></p>
          <div class="version-rail" aria-label="Version change">
            <span><small>Current</small><b class="current-version"></b></span>
            <span class="tick" aria-hidden="true">→</span>
            <span><small>New</small><b class="new-version"></b></span>
          </div>
          <div class="status" aria-live="polite"></div>
          <footer></footer>
        </section>
      </dialog>`;

    setText(this.#root, ".mark", this.#metadata.productMark ?? "PF");
    setText(this.#root, "#pf-updater-title", title);
    setText(this.#root, "#pf-updater-description", description);
    setText(this.#root, ".current-version", this.#metadata.currentVersion);
    setText(this.#root, ".new-version", update?.version ?? "Installed");

    const status = this.#root.querySelector<HTMLElement>(".status");
    const footer = this.#root.querySelector<HTMLElement>("footer");
    if (status === null || footer === null) return;

    if (notes !== undefined && (isAvailable || isError)) {
      const notesElement = document.createElement("pre");
      notesElement.className = "notes";
      notesElement.textContent = notes;
      status.append(notesElement);
    }
    if (isDownloading) {
      status.append(createProgress(state.progress.percent));
    } else if (isInstalling) {
      status.textContent = "Installing update…";
    } else if (isRestarting) {
      status.textContent = "Installation complete. Restarting…";
    } else if (isError) {
      const error = document.createElement("p");
      error.className = "error";
      error.setAttribute("role", "alert");
      error.textContent = state.message;
      status.prepend(error);
    }

    if (isAvailable) {
      footer.append(
        actionButton("Later", "later", "secondary"),
        actionButton("Update & restart", "install", "primary"),
      );
    } else if (isError) {
      footer.append(
        actionButton("Later", "later", "secondary"),
        actionButton("Retry", "retry", "primary"),
      );
    }

    this.#wireActions();
    const dialog = this.#root.querySelector<HTMLDialogElement>("dialog");
    if (dialog === null) return;
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (
        this.#state.status === "available" ||
        (this.#state.status === "error" && this.#state.retry === "check")
      ) {
        this.#controller?.dismiss();
      }
    });
    if (!wasOpen) this.#restoreFocus = activeElement();
    this.#open(dialog);
    if (!wasOpen) this.#root.querySelector<HTMLElement>(".primary")?.focus();
  }

  #wireActions(): void {
    this.#root.querySelector('[data-action="later"]')?.addEventListener("click", () => {
      this.#controller?.dismiss();
    });
    this.#root.querySelector('[data-action="install"]')?.addEventListener("click", () => {
      void this.#controller?.install();
    });
    this.#root.querySelector('[data-action="retry"]')?.addEventListener("click", () => {
      void this.#controller?.retry();
    });
  }

  #open(dialog: HTMLDialogElement): void {
    if (dialog.hasAttribute("open")) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  #close(): void {
    const dialog = this.#root.querySelector<HTMLDialogElement>("dialog");
    if (dialog?.hasAttribute("open")) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
    this.#restoreFocus?.focus();
    this.#restoreFocus = null;
  }
}

export function definePickforgeUpdaterElement(
  name = "pickforge-update-dialog",
  registry: CustomElementRegistry = customElements,
): void {
  if (registry.get(name) === undefined) registry.define(name, PickforgeUpdateDialogElement);
}

function isVisibleState(state: UpdateState): boolean {
  return ["available", "downloading", "installing", "restarting", "error"].includes(state.status);
}

function setText(root: ShadowRoot, selector: string, value: string): void {
  const element = root.querySelector(selector);
  if (element !== null) element.textContent = value;
}

function actionButton(label: string, action: string, className: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

function createProgress(percent: number | null): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "progress-wrap";
  const label = document.createElement("span");
  label.textContent = percent === null ? "Downloading update…" : `Downloading… ${percent}%`;
  const progress = document.createElement("progress");
  progress.max = 100;
  if (percent !== null) progress.value = percent;
  progress.setAttribute("aria-label", label.textContent);
  wrapper.append(label, progress);
  return wrapper;
}

function activeElement(): HTMLElement | null {
  const element = document.activeElement;
  return element instanceof HTMLElement ? element : null;
}

const STYLES = `
  :host { color: var(--pf-text-hi, #f2f2f3); font-family: var(--pf-font-sans, "Geist Sans", system-ui, sans-serif); }
  dialog { background: transparent; border: 0; color: inherit; margin: auto; max-height: calc(100vh - 32px); max-width: min(560px, calc(100vw - 32px)); padding: 0; width: 100%; }
  dialog::backdrop { background: color-mix(in srgb, var(--pf-surface, #0a0a0b) 62%, transparent); }
  .card { animation: pf-updater-enter var(--pf-dur-fast, 180ms) var(--pf-ease-forge, ease-out) both; backdrop-filter: blur(20px) saturate(160%); background: color-mix(in srgb, var(--pf-surface-1, #0f0f11) 85%, transparent); border: 1px solid var(--pf-hairline-strong, rgba(255,255,255,.14)); border-radius: var(--pf-radius-lg, 14px); box-shadow: var(--pf-shadow-overlay, 0 16px 48px -10px rgba(0,0,0,.6)); box-sizing: border-box; max-height: calc(100vh - 32px); overflow: auto; padding: var(--pf-space-xl, 24px); }
  header { align-items: center; display: flex; gap: var(--pf-space-sm, 8px); }
  .mark { align-items: center; background: var(--pf-item-fill, rgba(255,255,255,.03)); border: 1px solid var(--pf-hairline-strong, rgba(255,255,255,.14)); border-radius: var(--pf-radius-sm, 6px); color: var(--pf-ember, #ff7a1a); display: inline-flex; font-family: var(--pf-font-mono, monospace); font-size: 10px; font-weight: 700; height: 26px; justify-content: center; width: 26px; }
  .eyebrow, small { color: var(--pf-text-low, #6e6e75); font-family: var(--pf-font-mono, monospace); font-size: var(--pf-size-eyebrow, 10px); font-weight: 500; letter-spacing: var(--pf-tracking-eyebrow, 1.8px); text-transform: uppercase; }
  h2 { font-size: var(--pf-size-headline-md, 21px); line-height: 1.2; margin: var(--pf-space-lg, 16px) 0 var(--pf-space-sm, 8px); }
  .description { color: var(--pf-text-med, #a0a0a6); font-size: var(--pf-size-body-md, 13px); line-height: 1.5; margin: 0; }
  .version-rail { align-items: center; background: var(--pf-item-fill, rgba(255,255,255,.03)); border: 1px solid var(--pf-hairline, rgba(255,255,255,.08)); border-radius: var(--pf-radius-md, 10px); display: grid; gap: var(--pf-space-md, 12px); grid-template-columns: 1fr auto 1fr; margin-top: var(--pf-space-lg, 16px); padding: var(--pf-space-md, 12px) var(--pf-space-lg, 16px); }
  .version-rail span:not(.tick) { display: grid; gap: 3px; }
  .version-rail b { font-family: var(--pf-font-mono, monospace); font-size: var(--pf-size-mono, 12px); font-variant-numeric: tabular-nums; }
  .version-rail span:last-child { text-align: right; }
  .tick { color: var(--pf-ember, #ff7a1a); }
  .status { min-height: 20px; }
  .notes { background: transparent; color: var(--pf-text-med, #a0a0a6); font: 400 var(--pf-size-body-sm, 12px)/1.5 var(--pf-font-sans, system-ui); margin: var(--pf-space-lg, 16px) 0 0; max-height: min(180px, 28vh); overflow: auto; white-space: pre-wrap; }
  .error { color: var(--pf-error, #ff6b5c); font-size: var(--pf-size-body-md, 13px); margin: var(--pf-space-lg, 16px) 0 0; }
  .progress-wrap { display: grid; gap: var(--pf-space-sm, 8px); margin-top: var(--pf-space-lg, 16px); }
  .progress-wrap span { color: var(--pf-text-med, #a0a0a6); font-size: var(--pf-size-body-sm, 12px); }
  progress { accent-color: var(--pf-ember, #ff7a1a); height: 6px; width: 100%; }
  footer { display: flex; gap: var(--pf-space-sm, 8px); justify-content: flex-end; margin-top: var(--pf-space-xl, 24px); }
  button { border-radius: var(--pf-radius-sm, 6px); cursor: pointer; font: 600 var(--pf-size-label-md, 12px) var(--pf-font-sans, system-ui); min-height: 36px; padding: 0 var(--pf-space-lg, 16px); }
  button:focus-visible { outline: 2px solid var(--pf-ember-soft, #ff9a4a); outline-offset: 2px; }
  .secondary { background: transparent; border: 1px solid var(--pf-hairline-strong, rgba(255,255,255,.14)); color: var(--pf-text-med, #a0a0a6); }
  .primary { background: var(--pf-ember, #ff7a1a); border: 1px solid var(--pf-ember, #ff7a1a); color: #15100c; }
  @keyframes pf-updater-enter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @media (max-height: 580px) { .card { padding: var(--pf-space-lg, 16px); } .notes { max-height: 120px; } footer { margin-top: var(--pf-space-lg, 16px); } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
`;
