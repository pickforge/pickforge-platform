import { mkdir, open, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LearningEntry } from "./protocol.ts";
import type { StatePaths } from "./paths.ts";

type LogEvent =
  | { type: "entry"; entry: LearningEntry }
  | { type: "update"; entryId: string; patch: Partial<Pick<LearningEntry, "note" | "reviewLater" | "quizOutcome">>; at: string };

async function recoverFinalFragment(path: string): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!raw.length || raw.at(-1) === 0x0a) return;
  const lastNewline = raw.lastIndexOf(0x0a);
  const fragment = raw.subarray(lastNewline + 1).toString("utf8");
  try {
    JSON.parse(fragment);
    const file = await open(path, "a", 0o600);
    try {
      await file.appendFile("\n");
    } finally {
      await file.close();
    }
  } catch {
    await truncate(path, lastNewline + 1);
  }
}

async function privateAppend(path: string, value: string): Promise<void> {
  await recoverFinalFragment(path);
  const file = await open(path, "a", 0o600);
  try {
    await file.appendFile(value);
  } finally {
    await file.close();
  }
}

export async function initProjectPaths(paths: StatePaths, canonicalRepo: string): Promise<void> {
  await mkdir(paths.inputsDir, { recursive: true, mode: 0o700 });
  const expected = { protocol: "rt/1", canonicalRepo, projectKey: paths.projectKey };
  try {
    await writeFile(paths.projectFile, JSON.stringify(expected, null, 2), { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(paths.projectFile, "utf8"));
  } catch {
    throw new Error(`project state failed: expected valid JSON in ${paths.projectFile}; repair or remove this Review Tutor state directory and retry`);
  }
  const value = existing as Record<string, unknown>;
  if (value?.protocol !== expected.protocol || value.canonicalRepo !== expected.canonicalRepo || value.projectKey !== expected.projectKey) {
    throw new Error(`project state failed: expected protocol rt/1, repository '${canonicalRepo}', and project key '${paths.projectKey}'; found mismatched metadata in ${paths.projectFile}; use the matching state directory or remove it and retry`);
  }
}

export async function persistInput(paths: StatePaths, id: string, content: string): Promise<void> {
  await writeFile(join(paths.inputsDir, id), content, { flag: "wx", mode: 0o600 });
}

export async function appendEntry(paths: StatePaths, entry: LearningEntry): Promise<void> {
  await privateAppend(paths.logFile, `${JSON.stringify({ type: "entry", entry } satisfies LogEvent)}\n`);
}

export async function updateEntry(
  paths: StatePaths,
  entryId: string,
  patch: Partial<Pick<LearningEntry, "note" | "reviewLater" | "quizOutcome">>,
): Promise<void> {
  const entries = await foldLog(paths);
  if (!entries.some((entry) => entry.id === entryId)) {
    throw new Error(`log update failed: expected entry '${entryId}' to exist; refresh the log and retry`);
  }
  await privateAppend(paths.logFile, `${JSON.stringify({ type: "update", entryId, patch, at: new Date().toISOString() } satisfies LogEvent)}\n`);
}

export async function foldLog(paths: StatePaths): Promise<LearningEntry[]> {
  let raw: string;
  try {
    raw = await readFile(paths.logFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const entries = new Map<string, LearningEntry>();
  for (let index = 0; index < lines.length; index++) {
    let event: LogEvent;
    try {
      event = JSON.parse(lines[index]!) as LogEvent;
    } catch {
      if (index === lines.length - 1 && !raw.endsWith("\n")) break;
      throw new Error(`log read failed: expected valid JSONL at line ${index + 1}; restore the canonical log before retrying`);
    }
    if (event.type === "entry" && event.entry?.id) {
      entries.set(event.entry.id, event.entry);
    } else if (event.type === "update") {
      const current = entries.get(event.entryId);
      if (!current) {
        throw new Error(`log read failed: expected update target '${event.entryId}' before line ${index + 1}; repair the log and retry`);
      }
      entries.set(event.entryId, { ...current, ...event.patch, updatedAt: event.at });
    } else {
      throw new Error(`log read failed: expected a known event at line ${index + 1}; repair the log and retry`);
    }
  }
  return [...entries.values()];
}
