/**
 * pi-kit compact tool rendering — Pickforge-style, space-efficient tool rows.
 *
 * Spreads the built-in tool definitions (behavior, descriptions, and prompt
 * metadata untouched) and overrides only renderCall/renderResult. Collapsed
 * rows are a few lines; ctrl+o still expands the full output.
 */
import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

const COLLAPSED_RESULT_LINES = 3;
const EXPANDED_RESULT_LINES = 40;
const TITLE_WIDTH = 96;
const LINE_WIDTH = 180;

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.slice(0, idx);
}

function clip(text: string, width: number): string {
  return truncateToWidth(text, width, "…");
}

function shortPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export default function compactTools(pi: ExtensionAPI) {
  const cwd = process.cwd();

  // --- bash: `▸ cmd` + compact tail of output ---
  const bash = createBashToolDefinition(cwd);
  pi.registerTool({
    ...bash,
    renderCall(args, theme) {
      const cmd = clip(args.command.replaceAll(/\s+/g, " ").trim(), TITLE_WIDTH);
      return new Text(`${theme.fg("accent", "▸")} ${theme.fg("text", cmd)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const content = result.content[0];
      const output = content?.type === "text" ? content.text : "";
      const lines = output.split("\n").filter((line) => line.trim().length > 0);
      if (isPartial) {
        const tail = lines.at(-1);
        return new Text(theme.fg("dim", tail ? `⋯ ${clip(tail, TITLE_WIDTH)}` : "⋯ running"), 0, 0);
      }

      const details = result.details as BashToolDetails | undefined;
      const failed = context.isError;
      const badge = failed ? theme.fg("error", "✖") : theme.fg("success", "✔");
      let text = `${badge} ${theme.fg("muted", `${lines.length} line${lines.length === 1 ? "" : "s"}`)}`;
      if (details?.truncation?.truncated) text += theme.fg("warning", " · truncated");

      const shown = expanded ? EXPANDED_RESULT_LINES : COLLAPSED_RESULT_LINES;
      const view = expanded ? lines.slice(0, shown) : lines.slice(-shown);
      for (const line of view) {
        text += `\n${theme.fg(failed ? "toolOutput" : "dim", clip(line, LINE_WIDTH))}`;
      }
      if (lines.length > shown) {
        text += `\n${theme.fg("muted", `… ${lines.length - shown} more (ctrl+o)`)}`;
      }
      return new Text(text, 0, 0);
    },
  });

  // --- read: one line, path + size ---
  const read = createReadToolDefinition(cwd);
  pi.registerTool({
    ...read,
    renderCall(args, theme) {
      const range =
        args.offset || args.limit
          ? theme.fg("dim", ` ${args.offset ?? 1}..${args.offset && args.limit ? args.offset + args.limit : (args.limit ?? "")}`)
          : "";
      return new Text(
        `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", "read")} ${theme.fg("text", shortPath(args.path))}${range}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("dim", "⋯ reading"), 0, 0);
      const content = result.content[0];
      if (context.isError) {
        const message = content?.type === "text" ? firstLine(content.text) : "failed";
        return new Text(theme.fg("error", `✖ ${clip(message, TITLE_WIDTH)}`), 0, 0);
      }
      if (content?.type === "image") return new Text(theme.fg("success", "✔ image"), 0, 0);
      if (content?.type !== "text") return new Text(theme.fg("error", "✖ no content"), 0, 0);

      const details = result.details as ReadToolDetails | undefined;
      const lineCount = content.text.split("\n").length;
      let text = theme.fg("success", "✔ ") + theme.fg("muted", `${lineCount} lines`);
      if (details?.truncation?.truncated) {
        text += theme.fg("warning", ` of ${details.truncation.totalLines}`);
      }
      if (expanded) {
        for (const line of content.text.split("\n").slice(0, EXPANDED_RESULT_LINES)) {
          text += `\n${theme.fg("dim", clip(line, LINE_WIDTH))}`;
        }
        if (lineCount > EXPANDED_RESULT_LINES) {
          text += `\n${theme.fg("muted", `… ${lineCount - EXPANDED_RESULT_LINES} more`)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  // --- edit: path + diff stat, expanded shows the diff ---
  const edit = createEditToolDefinition(cwd);
  pi.registerTool({
    ...edit,
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", "edit")} ${theme.fg("text", shortPath(args.path))}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("dim", "⋯ editing"), 0, 0);
      const content = result.content[0];
      if (context.isError) {
        const message = content?.type === "text" ? firstLine(content.text) : "failed";
        return new Text(theme.fg("error", `✖ ${clip(message, TITLE_WIDTH)}`), 0, 0);
      }
      const details = result.details as EditToolDetails | undefined;
      if (!details?.diff) return new Text(theme.fg("success", "✔ applied"), 0, 0);

      const diffLines = details.diff.split("\n");
      let additions = 0;
      let removals = 0;
      for (const line of diffLines) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        if (line.startsWith("-") && !line.startsWith("---")) removals++;
      }
      let text =
        theme.fg("success", `✔ +${additions}`) +
        theme.fg("dim", " / ") +
        theme.fg("error", `-${removals}`);
      if (expanded) {
        for (const line of diffLines.slice(0, EXPANDED_RESULT_LINES)) {
          const color = line.startsWith("+")
            ? "toolDiffAdded"
            : line.startsWith("-")
              ? "toolDiffRemoved"
              : "toolDiffContext";
          text += `\n${theme.fg(color, clip(line, LINE_WIDTH))}`;
        }
        if (diffLines.length > EXPANDED_RESULT_LINES) {
          text += `\n${theme.fg("muted", `… ${diffLines.length - EXPANDED_RESULT_LINES} more`)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  // --- write: path + line count ---
  const write = createWriteToolDefinition(cwd);
  pi.registerTool({
    ...write,
    renderCall(args, theme) {
      const lineCount = args.content.split("\n").length;
      return new Text(
        `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", "write")} ${theme.fg("text", shortPath(args.path))} ${theme.fg("dim", `(${lineCount} lines)`)}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("dim", "⋯ writing"), 0, 0);
      if (context.isError) {
        const content = result.content[0];
        const message = content?.type === "text" ? firstLine(content.text) : "failed";
        return new Text(theme.fg("error", `✖ ${clip(message, TITLE_WIDTH)}`), 0, 0);
      }
      return new Text(theme.fg("success", "✔ written"), 0, 0);
    },
  });
}
