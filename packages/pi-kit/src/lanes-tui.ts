/**
 * Full-screen lanes TUI overlay: browse live and archived lane runs,
 * inspect each lane's session (thinking, text, tool calls, results).
 * Shown via ctx.ui.custom() on top of the active Pi session.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { listRuns, rawRunDir, readRun, reduceRun } from "./journal-core.ts";
import type { LaneProjection, RunProjection } from "./schema.ts";
import { LaneTranscript } from "./transcript.ts";

interface Theme {
  fg(color: string, text: string): string;
}

const RAIL_WIDTH = 30;
const POLL_MS = 500;

function fmtDuration(ms: number): string {
  const seconds = Math.floor((Number.isFinite(ms) ? Math.max(0, ms) : 0) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function laneDuration(lane: LaneProjection, nowMs = Date.now()): number | undefined {
  return lane.durationMs ??
    (lane.state === "running" && lane.startedAtMs !== undefined ? Math.max(0, nowMs - lane.startedAtMs) : undefined);
}

interface LaneFeed {
  transcript: LaneTranscript;
  bytesRead: number;
}

export class RunView {
  readonly runId: string;
  projection: RunProjection;
  private readonly feeds = new Map<string, LaneFeed>();

  constructor(runId: string) {
    this.runId = runId;
    this.projection = reduceRun(readRun(runId));
  }

  refresh(): void {
    this.projection = reduceRun(readRun(this.runId));
    for (const lane of this.projection.lanes.keys()) this.pollLane(lane);
  }

  transcript(lane: string): LaneTranscript {
    this.pollLane(lane);
    return this.feeds.get(lane)!.transcript;
  }

  private pollLane(lane: string): void {
    let feed = this.feeds.get(lane);
    if (!feed) {
      feed = { transcript: new LaneTranscript(), bytesRead: 0 };
      this.feeds.set(lane, feed);
    }
    const path = join(rawRunDir(this.runId), `${lane}.jsonl`);
    try {
      const size = statSync(path).size;
      if (size <= feed.bytesRead) return;
      // Track offsets in bytes (never UTF-16 code units) and feed only
      // complete lines, so multibyte characters and half-flushed tail lines
      // are never split or silently dropped.
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(size - feed.bytesRead);
        const read = readSync(fd, buf, 0, buf.length, feed.bytesRead);
        const end = buf.subarray(0, read).lastIndexOf(0x0a) + 1;
        if (end === 0) return;
        feed.transcript.feedChunk(buf.subarray(0, end).toString("utf8"));
        feed.bytesRead += end;
      } finally {
        closeSync(fd);
      }
    } catch {
      // No transcript captured for this lane (pre-tap run or lane not started).
    }
  }
}

function stateColor(state: LaneProjection["state"]): string {
  switch (state) {
    case "running":
      return "accent";
    case "done":
      return "success";
    case "failed":
    case "abandoned":
      return "error";
    default:
      return "dim";
  }
}

function stateGlyph(state: LaneProjection["state"]): string {
  switch (state) {
    case "running":
      return "▶";
    case "done":
      return "✔";
    case "failed":
      return "✖";
    case "abandoned":
      return "⊘";
    default:
      return "◌";
  }
}

export class LanesTuiComponent implements Component {
  private runs: string[] = [];
  private runIndex = 0;
  private laneIndex = 0;
  private pane: "runs" | "lanes" = "lanes";
  private scroll = 0;
  private follow = true;
  private showThinking = true;
  private view?: RunView;
  private timer?: NodeJS.Timeout;
  private lineCache?: { key: string; lines: string[] };

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;

  constructor(tui: TUI, theme: Theme, done: () => void, initialRun?: string) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.reloadRuns(initialRun);
    this.timer = setInterval(() => {
      this.view?.refresh();
      this.tui.requestRender();
    }, POLL_MS);
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {
    this.lineCache = undefined;
  }

  private reloadRuns(preferred?: string): void {
    this.runs = listRuns();
    const index = preferred ? this.runs.indexOf(preferred) : 0;
    this.runIndex = index >= 0 ? index : 0;
    this.selectRun();
  }

  private selectRun(): void {
    const runId = this.runs[this.runIndex];
    this.view = runId ? new RunView(runId) : undefined;
    this.view?.refresh();
    this.laneIndex = 0;
    this.scroll = 0;
    this.follow = true;
    this.lineCache = undefined;
  }

  private lanes(): LaneProjection[] {
    return this.view ? [...this.view.projection.lanes.values()] : [];
  }

  private selectedLane(): LaneProjection | undefined {
    return this.lanes()[this.laneIndex];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "q") || matchesKey(data, "escape")) {
      this.done();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.pane = this.pane === "runs" ? "lanes" : "runs";
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (this.pane === "runs") {
        this.runIndex = Math.max(0, this.runIndex - 1);
        this.selectRun();
      } else {
        this.laneIndex = Math.max(0, this.laneIndex - 1);
        this.resetScroll();
      }
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      if (this.pane === "runs") {
        this.runIndex = Math.min(Math.max(0, this.runs.length - 1), this.runIndex + 1);
        this.selectRun();
      } else {
        this.laneIndex = Math.min(Math.max(0, this.lanes().length - 1), this.laneIndex + 1);
        this.resetScroll();
      }
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.follow = false;
      this.scroll = Math.max(0, this.scroll - this.viewHeight());
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scroll += this.viewHeight();
      return;
    }
    if (matchesKey(data, "t")) {
      this.showThinking = !this.showThinking;
      this.lineCache = undefined;
      return;
    }
    if (matchesKey(data, "f")) {
      this.follow = !this.follow;
      return;
    }
    if (matchesKey(data, "r")) {
      this.reloadRuns(this.runs[this.runIndex]);
    }
  }

  private resetScroll(): void {
    this.scroll = 0;
    this.follow = true;
    this.lineCache = undefined;
  }

  private viewHeight(): number {
    return Math.max(4, this.tui.terminal.rows - 3);
  }

  private transcriptLines(width: number): string[] {
    const lane = this.selectedLane();
    if (!lane || !this.view) return [this.theme.fg("dim", "no lane selected")];
    const transcript = this.view.transcript(lane.spec.lane);
    const key = `${this.view.runId}:${lane.spec.lane}:${transcript.version}:${width}:${this.showThinking}`;
    if (this.lineCache?.key === key) return this.lineCache.lines;

    const t = this.theme;
    const out: string[] = [];
    const wrap = (text: string, color?: string) => {
      for (const raw of text.split("\n")) {
        const wrapped = wrapTextWithAnsi(raw, width);
        for (const line of wrapped.length > 0 ? wrapped : [""]) {
          out.push(color ? t.fg(color, line) : line);
        }
      }
    };

    if (transcript.entries.length === 0) {
      out.push(t.fg("dim", "no transcript captured for this lane (pre-transcript run?)"));
      out.push("");
      if (lane.answer) {
        out.push(t.fg("accent", "── final answer (journal) ──"));
        wrap(lane.answer);
      }
    }
    for (const entry of transcript.entries) {
      switch (entry.kind) {
        case "task":
          out.push(t.fg("accent", "── task ──"));
          wrap(entry.text, "muted");
          break;
        case "thinking":
          if (!this.showThinking) break;
          out.push(t.fg("dim", "── thinking ──"));
          wrap(entry.text, "dim");
          break;
        case "text":
          out.push("");
          wrap(entry.text);
          break;
        case "tool":
          out.push(t.fg("warning", `⚙ ${entry.title ?? "tool"}`));
          wrap(entry.text, "muted");
          break;
        case "tool_result": {
          const isError = (entry.title ?? "").endsWith("(error)");
          out.push(t.fg(isError ? "error" : "dim", `→ ${entry.title ?? "result"}`));
          wrap(entry.text.length > 1_500 ? `${entry.text.slice(0, 1_500)}…` : entry.text, "dim");
          break;
        }
        case "info":
          wrap(entry.text, "dim");
          break;
      }
    }
    this.lineCache = { key, lines: out };
    return out;
  }

  private railLines(height: number): string[] {
    const t = this.theme;
    const width = RAIL_WIDTH - 2;
    const lines: string[] = [];
    const runsFocused = this.pane === "runs";

    lines.push(t.fg(runsFocused ? "accent" : "muted", runsFocused ? "▸ RUNS (archived)" : "  RUNS (archived)"));
    const maxRuns = Math.max(3, Math.floor((height - 4) / 3));
    const runStart = Math.max(0, Math.min(this.runIndex - Math.floor(maxRuns / 2), this.runs.length - maxRuns));
    for (let i = runStart; i < Math.min(this.runs.length, runStart + maxRuns); i++) {
      const selected = i === this.runIndex;
      const label = truncateToWidth(this.runs[i]!.replace(/^run-/, ""), width - 2);
      lines.push(selected ? t.fg(runsFocused ? "accent" : "text", `› ${label}`) : t.fg("dim", `  ${label}`));
    }

    lines.push("");
    const lanesFocused = this.pane === "lanes";
    lines.push(t.fg(lanesFocused ? "accent" : "muted", lanesFocused ? "▸ LANES" : "  LANES"));
    this.lanes().forEach((lane, i) => {
      const selected = i === this.laneIndex;
      const glyph = t.fg(stateColor(lane.state), stateGlyph(lane.state));
      const name = truncateToWidth(lane.spec.lane, width - 4);
      lines.push(`${selected ? t.fg("accent", "›") : " "} ${glyph} ${selected ? t.fg("text", name) : t.fg("muted", name)}`);
      const duration = laneDuration(lane);
      const meta = truncateToWidth(
        `${lane.spec.model.slice(lane.spec.model.indexOf("/") + 1)}:${lane.spec.effort} $${lane.cost.toFixed(3)}${duration === undefined ? "" : ` ${fmtDuration(duration)}`}`,
        width - 4,
      );
      lines.push(`    ${t.fg("dim", meta)}`);
    });
    return lines.slice(0, height);
  }

  render(width: number): string[] {
    const height = Math.max(6, this.tui.terminal.rows);
    const bodyHeight = height - 2;
    const t = this.theme;
    const view = this.view;
    const lanes = this.lanes();
    const running = lanes.filter((l) => l.state === "running").length;

    const runDuration = view
      ? view.projection.durationMs ?? Math.max(0, Date.now() - Date.parse(view.projection.createdAt))
      : 0;
    const headerText = view
      ? `lanes tui · ${view.runId} · ${fmtDuration(runDuration)} · ${lanes.length} lanes${running ? ` · ${running} running` : ""} · $${view.projection.totalCost.toFixed(4)}`
      : "lanes tui · no runs recorded yet";
    const header = truncateToWidth(t.fg("accent", headerText), width);

    const railWidth = Math.min(RAIL_WIDTH, Math.max(16, Math.floor(width / 3)));
    const mainWidth = Math.max(10, width - railWidth - 1);
    const rail = this.railLines(bodyHeight);
    const all = this.transcriptLines(mainWidth);
    const viewH = bodyHeight;
    const maxScroll = Math.max(0, all.length - viewH);
    if (this.follow) this.scroll = maxScroll;
    this.scroll = Math.min(this.scroll, maxScroll);
    const visible = all.slice(this.scroll, this.scroll + viewH);

    const sep = t.fg("dim", "│");
    const lines: string[] = [header];
    for (let i = 0; i < bodyHeight; i++) {
      const left = rail[i] ?? "";
      const leftPad = Math.max(0, railWidth - visibleWidth(left));
      const right = visible[i] ?? "";
      const row = `${truncateToWidth(left, railWidth)}${" ".repeat(leftPad)}${sep}${truncateToWidth(right, mainWidth)}`;
      lines.push(truncateToWidth(row, width));
    }

    const pos = maxScroll > 0 ? ` · ${Math.min(100, Math.round((this.scroll / maxScroll) * 100))}%` : "";
    const footer = truncateToWidth(
      t.fg(
        "dim",
        `tab panes · ↑↓ select · pgup/pgdn scroll${pos} · t thinking(${this.showThinking ? "on" : "off"}) · f follow(${this.follow ? "on" : "off"}) · r reload · q close`,
      ),
      width,
    );
    lines.push(footer);
    return lines;
  }
}
