import { posix } from "node:path";
import type { ExecFile } from "./inputs.ts";
import {
  STRUCTURE_LIMITS,
  type InputSnapshot,
  type StructureComparison,
  type StructureEdge,
  type StructureEvidence,
  type StructureFile,
  type StructureLimits,
  type StructureNeighbours,
  type StructureOmission,
  type StructureSnapshot,
} from "./protocol.ts";
import {
  CLAUSE_LIMIT,
  extensionOf,
  languageForExtension,
  maskLiterals,
  pubspecPackageName,
  scanFor,
  targetFor,
  type LanguageId,
  type ResolutionTarget,
  type Statement,
} from "./structure-languages.ts";
import { NeighbourReader, neighbourSourceFor, type NeighbourSource } from "./structure-neighbours.ts";

export { maskLiterals };

type LineOrigin = "add" | "del" | "context";
type Side = "new" | "old";

interface DiffLine { origin: LineOrigin; oldLine: number; newLine: number; text: string }
interface DiffHunk { lines: DiffLine[] }
interface DiffFile {
  path: string;
  oldPath?: string;
  status: StructureFile["status"];
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}
interface ParsedDiff {
  files: DiffFile[];
  reasons: string[];
  extraFiles: number;
  longLines: number;
}

interface DocLine { number: number; origin: LineOrigin; text: string; start: number }
interface Doc { text: string; lines: DocLine[] }

interface ResolutionIndex { current: Map<string, string>; previous: Map<string, string> }

/** One specifier that matched no changed file, kept for the optional neighbour pass. */
interface PendingLink {
  from: string;
  target: ResolutionTarget;
  statement: Statement;
  status: StructureEdge["status"];
  evidence: StructureEvidence[];
  line: number;
  omission?: StructureOmission;
  suppressed: boolean;
}

interface Collector {
  edges: Map<string, StructureEdge>;
  omitted: StructureOmission[];
  external: Map<string, Set<string>>;
  pending: PendingLink[];
  packageRoots: Map<string, string>;
  unresolved: boolean;
  unresolvedLinks: number;
  truncated: boolean;
  suppressed: number;
  droppedEdges: number;
}

interface AnalysisContext { packageRoots: Map<string, string>; neighbours: boolean }

interface Analysis {
  input: InputSnapshot;
  reasons: string[];
  files: StructureFile[];
  parsed: ParsedDiff;
  collector: Collector;
}

export interface NeighbourRequest {
  neighbours: boolean;
  execFile: ExecFile;
  cwd: string;
  now?: () => number;
  signal?: AbortSignal;
  deadline?: AbortSignal;
}

const PUBSPEC_DEPTH = 6;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000A-\u001F\u007F]/g;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unquotePath(value: string): string {
  if (!value.startsWith("\"") || !value.endsWith("\"") || value.length < 2) return value;
  return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/** `inputs.ts` pins `--src-prefix=a/ --dst-prefix=b/`, so only those two ever arrive. */
function stripSidePrefix(value: string): string {
  const path = unquotePath(value.trim());
  return path.replace(/^[ab]\//, "");
}

function splitGitHeader(line: string): { old: string; next: string } | undefined {
  const rest = line.slice("diff --git ".length);
  const same = /^"?a\/(.+?)"? "?b\/\1"?$/.exec(rest);
  if (same) return { old: unquotePath(same[1]!), next: unquotePath(same[1]!) };
  const split = rest.lastIndexOf(" b/");
  if (split < 0) return undefined;
  return { old: stripSidePrefix(rest.slice(0, split)), next: stripSidePrefix(rest.slice(split + 1)) };
}

function startFile(line: string): DiffFile {
  const header = splitGitHeader(line);
  return { path: header?.next ?? "", status: "modified", additions: 0, deletions: 0, binary: false, hunks: [] };
}

function applyFileHeader(file: DiffFile, line: string): void {
  if (line.startsWith("new file mode")) file.status = "added";
  else if (line.startsWith("deleted file mode")) file.status = "removed";
  else if (line.startsWith("rename from ")) { file.oldPath = stripSidePrefix(line.slice(12)); file.status = "renamed"; }
  else if (line.startsWith("rename to ")) file.path = stripSidePrefix(line.slice(10));
  else if (line.startsWith("copy to ")) { file.path = stripSidePrefix(line.slice(8)); file.status = "added"; }
  else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
  else if (line.startsWith("--- ")) {
    const value = line.slice(4).trim();
    if (value === "/dev/null") file.status = "added";
    else if (file.status !== "renamed") file.oldPath = stripSidePrefix(value);
  } else if (line.startsWith("+++ ")) {
    const value = line.slice(4).trim();
    if (value === "/dev/null") file.status = "removed";
    else if (file.status !== "renamed") file.path = stripSidePrefix(value);
  }
}

function displayPath(file: DiffFile): string {
  return file.path || file.oldPath || "";
}

interface ParseState {
  file?: DiffFile;
  hunk?: DiffHunk;
  oldLine: number;
  newLine: number;
  lineNumber: number;
  files: DiffFile[];
  reasons: string[];
  extraFiles: number;
  longLines: number;
  merge: boolean;
}

function originOf(line: string): LineOrigin | undefined {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith(" ") || line === "") return "context";
  return undefined;
}

function appendHunkLine(state: ParseState, file: DiffFile, hunk: DiffHunk, line: string): void {
  const origin = originOf(line);
  if (!origin) {
    state.hunk = undefined;
    applyFileHeader(file, line);
    return;
  }
  hunk.lines.push({ origin, oldLine: state.oldLine, newLine: state.newLine, text: line.slice(1) });
  if (origin !== "add") state.oldLine += 1;
  if (origin !== "del") state.newLine += 1;
  if (origin === "add") file.additions += 1;
  if (origin === "del") file.deletions += 1;
}

function startDiffFile(state: ParseState, line: string): void {
  state.hunk = undefined;
  if (state.files.length >= STRUCTURE_LIMITS.maxFiles) {
    state.extraFiles += 1;
    state.file = undefined;
    return;
  }
  state.file = startFile(line);
  state.files.push(state.file);
}

function consumeDiffLine(state: ParseState, line: string): void {
  if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ") || line.startsWith("@@@")) {
    state.merge = true;
    state.file = undefined;
    state.hunk = undefined;
    return;
  }
  if (line.startsWith("diff --git ")) return startDiffFile(state, line);
  const file = state.file;
  if (!file) return;
  const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (range) {
    state.oldLine = Number(range[1]);
    state.newLine = Number(range[2]);
    state.hunk = { lines: [] };
    file.hunks.push(state.hunk);
    return;
  }
  if (line.startsWith("@@")) {
    state.hunk = undefined;
    state.reasons.push(`malformed hunk header at diff line ${state.lineNumber}: no import data for that file`);
    return;
  }
  if (!state.hunk) return applyFileHeader(file, line);
  if (line.startsWith("\\")) return;
  appendHunkLine(state, file, state.hunk, line);
}

/** Reads at most `diffLines` lines without materializing the whole content as an array. */
function scanDiffLines(content: string, state: ParseState): boolean {
  let start = 0;
  while (state.lineNumber < STRUCTURE_LIMITS.diffLines) {
    const end = content.indexOf("\n", start);
    const raw = end < 0 ? content.slice(start) : content.slice(start, end);
    state.lineNumber += 1;
    const capped = raw.length > STRUCTURE_LIMITS.lineLength;
    if (capped) state.longLines += 1;
    consumeDiffLine(state, capped ? raw.slice(0, STRUCTURE_LIMITS.lineLength) : raw);
    if (end < 0) return true;
    start = end + 1;
  }
  return false;
}

export function parseUnifiedDiff(content: string): ParsedDiff {
  const state: ParseState = {
    oldLine: 0, newLine: 0, lineNumber: 0, files: [], reasons: [], extraFiles: 0, longLines: 0, merge: false,
  };
  const complete = scanDiffLines(content, state);
  if (!complete) {
    state.reasons.push(`diff parsing stopped after ${STRUCTURE_LIMITS.diffLines} lines: no import data for the rest of this comparison`);
  }
  const files = state.files.filter((candidate) => displayPath(candidate));
  if (state.merge) {
    state.reasons.push("merge commit: combined diffs are not analyzed; pick one parent range (e.g. <sha>^1...<sha>) and retry");
  } else if (!files.length && content.trim()) {
    state.reasons.push("diff parse failed: expected unified diff file headers such as 'diff --git', received none; load a Git-based source and retry");
  }
  return { files, reasons: state.reasons, extraFiles: state.extraFiles, longLines: state.longLines };
}

function buildDoc(file: DiffFile, side: Side): Doc {
  const lines: DocLine[] = [];
  const parts: string[] = [];
  let offset = 0;
  const push = (number: number, origin: LineOrigin, text: string): void => {
    lines.push({ number, origin, text, start: offset });
    parts.push(text);
    offset += text.length + 1;
  };
  file.hunks.forEach((hunk, index) => {
    if (index > 0) push(0, "context", ";");
    for (const line of hunk.lines) {
      if (side === "new" && line.origin === "del") continue;
      if (side === "old" && line.origin === "add") continue;
      push(side === "new" ? line.newLine : line.oldLine, line.origin, line.text);
    }
  });
  return { text: parts.join("\n"), lines };
}

/** A whole neighbour file reads as unchanged context, one document line per source line. */
function contentDoc(content: string): Doc {
  const lines: DocLine[] = [];
  let offset = 0;
  content.split("\n").forEach((text, index) => {
    lines.push({ number: index + 1, origin: "context", text, start: offset });
    offset += text.length + 1;
  });
  return { text: content, lines };
}

function lineAt(doc: Doc, offset: number): DocLine | undefined {
  let low = 0;
  let high = doc.lines.length - 1;
  let found: DocLine | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const line = doc.lines[middle]!;
    if (line.start <= offset) { found = line; low = middle + 1; } else high = middle - 1;
  }
  return found && found.number !== 0 ? found : undefined;
}

/**
 * The specifier line decides a connection's state: a multi-line statement whose
 * module string changed is an added edge on the new side and a removed edge on the
 * old side. Unchanged context lines are reported once, from the post-change side.
 */
function specifierLineFor(doc: Doc, offset: number, side: Side): DocLine | undefined {
  const line = lineAt(doc, offset);
  if (!line) return undefined;
  if (side === "old" && line.origin !== "del") return undefined;
  return line;
}

function languageOf(path: string): LanguageId | undefined {
  return languageForExtension(extensionOf(path));
}

/**
 * Candidate-path matching against the known file set only; no Node resolution,
 * no filesystem access. Old-side lookups consult pre-rename paths first because the
 * pre-change tree still held them; new-side lookups never do.
 */
function lookup(paths: string[], index: ResolutionIndex, side: Side): string | undefined {
  for (const candidate of paths) {
    const resolved = side === "old" ? index.previous.get(candidate) ?? index.current.get(candidate) : index.current.get(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

/** Deterministic UTF-16 trimming; control characters other than tab become U+FFFD. */
function trimText(text: string): string {
  const clean = text.trim().replace(CONTROL_CHARACTERS, "\uFFFD");
  return clean.length > STRUCTURE_LIMITS.evidenceText ? clean.slice(0, STRUCTURE_LIMITS.evidenceText) : clean;
}

function omit(collector: Collector, omission: StructureOmission): StructureOmission | undefined {
  if (collector.omitted.some((existing) => existing.path === omission.path && existing.reason === omission.reason)) return undefined;
  if (collector.omitted.length >= STRUCTURE_LIMITS.omittedRows) {
    collector.suppressed += 1;
    return undefined;
  }
  collector.omitted.push(omission);
  return omission;
}

/** Withdraws a pending link's omission, including one the row cap had only counted. */
function drop(collector: Collector, link: PendingLink): void {
  if (link.suppressed) { collector.suppressed -= 1; return; }
  if (!link.omission) return;
  const index = collector.omitted.indexOf(link.omission);
  if (index >= 0) collector.omitted.splice(index, 1);
}

function omitPending(collector: Collector, omission: StructureOmission): Pick<PendingLink, "omission" | "suppressed"> {
  const before = collector.suppressed;
  const created = omit(collector, omission);
  return { ...(created ? { omission: created } : {}), suppressed: collector.suppressed > before };
}

function addEvidence(edge: StructureEdge, evidence: StructureEvidence[]): void {
  for (const item of evidence) {
    if (edge.evidence.length >= STRUCTURE_LIMITS.maxEvidencePerEdge) return;
    if (edge.evidence.some((existing) => existing.path === item.path && existing.line === item.line)) continue;
    edge.evidence.push(item);
  }
}

function addEdge(collector: Collector, edge: StructureEdge, evidence: StructureEvidence[]): void {
  const key = [edge.from, edge.to, edge.kind, String(edge.typeOnly), edge.status].join("\u0000");
  const existing = collector.edges.get(key);
  if (existing) return addEvidence(existing, evidence);
  if (collector.edges.size >= STRUCTURE_LIMITS.maxEdges) {
    collector.droppedEdges += 1;
    collector.truncated = true;
    return;
  }
  const created: StructureEdge = { ...edge, evidence: [] };
  collector.edges.set(key, created);
  addEvidence(created, evidence);
}

function evidenceFor(path: string, doc: Doc, statement: Statement, specifier: DocLine): StructureEvidence[] {
  const first = lineAt(doc, statement.offset);
  const lines = first && first.number !== specifier.number ? [first, specifier] : [specifier];
  return lines.map((line) => ({ path, line: line.number, text: trimText(line.text) }));
}

function addExternal(collector: Collector, path: string, name: string): void {
  const bucket = collector.external.get(path) ?? new Set<string>();
  bucket.add(name);
  collector.external.set(path, bucket);
}

function recordStatement(
  collector: Collector, file: StructureFile, doc: Doc, side: Side,
  statement: Statement, index: ResolutionIndex, context: AnalysisContext, language: LanguageId,
): void {
  const specifier = specifierLineFor(doc, statement.specifierOffset, side);
  if (!specifier) return;
  const base = side === "old" ? file.renamedFrom ?? file.path : file.path;
  const target = targetFor(language, base, statement, context.packageRoots);
  if (target.kind === "external") return addExternal(collector, file.path, target.name);
  if (target.kind === "package" && !context.neighbours) {
    return addExternal(collector, file.path, statement.specifier);
  }
  const status = specifier.origin === "add" ? "added" : specifier.origin === "del" ? "removed" : "unchanged";
  const evidence = evidenceFor(file.path, doc, statement, specifier);
  const resolved = target.kind === "candidates" ? lookup(target.paths, index, side) : undefined;
  if (resolved) {
    return addEdge(collector, {
      from: file.path, to: resolved, kind: statement.kind, typeOnly: statement.typeOnly,
      status, specifier: statement.specifier, evidence: [],
    }, evidence);
  }
  /** A `package:` URI is only unresolved once a pubspec has named its package; until then it is external. */
  if (target.kind === "package") {
    collector.pending.push({ from: file.path, target, statement, status, evidence, suppressed: false, line: specifier.number });
    return;
  }
  collector.unresolvedLinks += 1;
  const omission = omitPending(collector, { path: file.path, reason: trimText(
    `specifier '${statement.specifier}' at line ${specifier.number} matches no changed file: no import data outside the changed set`) });
  if (context.neighbours) {
    collector.pending.push({ from: file.path, target, statement, status, evidence, line: specifier.number, ...omission });
  }
}

function analyzeSide(
  collector: Collector, file: StructureFile, diff: DiffFile, side: Side,
  index: ResolutionIndex, budget: { left: number }, context: AnalysisContext, language: LanguageId,
): void {
  const doc = buildDoc(diff, side);
  if (!doc.text) return;
  const { statements, nonLiteral, overlong, unsupported } = scanFor(language, doc.text);
  const allowed = statements.slice(0, Math.max(0, budget.left));
  budget.left -= statements.length;
  if (budget.left < 0) {
    collector.truncated = true;
    omit(collector, { path: file.path, reason:
      `statement cap reached: expected at most ${STRUCTURE_LIMITS.statementsPerFile} import statements in this file, received more; later statements are not analyzed` });
  }
  for (const statement of allowed) recordStatement(collector, file, doc, side, statement, index, context, language);
  for (const note of unsupported) {
    if (!specifierLineFor(doc, note.offset, side)) continue;
    collector.unresolved = true;
    omit(collector, { path: file.path, reason: trimText(note.reason) });
  }
  for (const offset of nonLiteral) {
    const line = specifierLineFor(doc, offset, side);
    if (!line) continue;
    collector.unresolved = true;
    omit(collector, { path: file.path, reason: `non-literal specifier at line ${line.number}: no import data for that call` });
  }
  for (const offset of overlong) {
    const line = specifierLineFor(doc, offset, side);
    if (!line) continue;
    collector.truncated = true;
    omit(collector, { path: file.path, reason:
      `import clause longer than ${CLAUSE_LIMIT} characters at line ${line.number}: no import data for that statement` });
  }
}

function describeFile(diff: DiffFile): StructureFile {
  const path = displayPath(diff);
  const extension = extensionOf(path);
  const base: StructureFile = {
    path,
    status: diff.status,
    ...(diff.status === "renamed" && diff.oldPath ? { renamedFrom: diff.oldPath } : {}),
    additions: diff.additions,
    deletions: diff.deletions,
    analyzed: false,
  };
  if (diff.binary) return { ...base, reason: "binary content: no import data" };
  if (!languageForExtension(extension)) {
    return { ...base, reason: `unsupported file type '${extension || "none"}': no import data` };
  }
  if (!diff.hunks.length) return { ...base, reason: "no diff content for this file: no import data" };
  return { ...base, analyzed: true };
}

function mergeEvidence(removed: StructureEvidence[], added: StructureEvidence[]): StructureEvidence[] {
  const cap = STRUCTURE_LIMITS.maxEvidencePerEdge;
  const fromRemoved = Math.min(removed.length, Math.max(Math.floor(cap / 2), cap - added.length));
  return [...removed.slice(0, fromRemoved), ...added.slice(0, cap - fromRemoved)];
}

/** An import whose bindings changed is one modified connection, not an add plus a remove. */
function collapseModified(edges: StructureEdge[]): StructureEdge[] {
  const groups = new Map<string, StructureEdge[]>();
  for (const edge of edges) {
    const key = [edge.from, edge.to, edge.kind, String(edge.typeOnly)].join("\u0000");
    groups.set(key, [...groups.get(key) ?? [], edge]);
  }
  const result: StructureEdge[] = [];
  for (const group of groups.values()) {
    const added = group.find((edge) => edge.status === "added");
    const removed = group.find((edge) => edge.status === "removed");
    if (!added || !removed) {
      result.push(...group);
      continue;
    }
    result.push(...group.filter((edge) => edge !== added && edge !== removed));
    result.push({ ...added, status: "modified", evidence: mergeEvidence(removed.evidence, added.evidence) });
  }
  return result;
}

function sortEdges(edges: StructureEdge[]): StructureEdge[] {
  return edges.sort((left, right) =>
    compareText(left.from, right.from) || compareText(left.to, right.to)
    || compareText(left.kind, right.kind)
    || (left.evidence[0]?.line ?? 0) - (right.evidence[0]?.line ?? 0)
    || compareText(left.specifier, right.specifier)
    || Number(left.typeOnly) - Number(right.typeOnly)
    || compareText(left.status, right.status));
}

function comparisonEndpoints(input: InputSnapshot): { from: string; to: string } {
  if (input.kind === "worktree") return { from: "index", to: "working tree" };
  if (input.kind === "staged") return { from: "HEAD", to: "index" };
  if (input.kind === "commit") return { from: "first parent", to: `commit ${input.label.replace(/^Commit /, "")}` };
  if (input.kind === "range") {
    const separator = input.label.indexOf("...");
    return { from: "merge-base", to: separator < 0 ? input.label : input.label.slice(separator + 3) };
  }
  if (input.kind === "pr") return { from: "base", to: `head ${input.headSha ?? "unknown"}` };
  return { from: "unavailable", to: "unavailable" };
}

function comparisonOf(input: InputSnapshot, reasons: string[]): StructureComparison {
  const endpoints = comparisonEndpoints(input);
  return { kind: input.kind, label: input.label, from: endpoints.from, to: endpoints.to, partial: reasons.length > 0, reasons };
}

function omissionRank(omission: StructureOmission): number {
  if (omission.reason.startsWith("further omissions not listed")) return 2;
  return omission.path === undefined ? 1 : 0;
}

function limitsOf(truncated: boolean, omitted: StructureOmission[]): StructureLimits {
  return {
    maxFiles: STRUCTURE_LIMITS.maxFiles,
    maxEdges: STRUCTURE_LIMITS.maxEdges,
    maxEvidencePerEdge: STRUCTURE_LIMITS.maxEvidencePerEdge,
    truncated,
    omitted: omitted.sort((left, right) =>
      omissionRank(left) - omissionRank(right)
      || compareText(left.path ?? "", right.path ?? "")
      || compareText(left.reason, right.reason)),
  };
}

const NEIGHBOURS_OFF: StructureNeighbours = { state: "off", count: 0 };

function emptySnapshot(input: InputSnapshot, reasons: string[]): StructureSnapshot {
  return {
    protocol: "rt/1",
    inputId: input.id,
    comparison: comparisonOf(input, reasons),
    files: [],
    edges: [],
    limits: limitsOf(false, []),
    neighbours: NEIGHBOURS_OFF,
  };
}

function collectExternal(collector: Collector): void {
  for (const path of [...collector.external.keys()].sort(compareText)) {
    const names = [...collector.external.get(path)!].sort(compareText);
    const shown = names.slice(0, STRUCTURE_LIMITS.externalNames);
    const suffix = shown.length < names.length ? ", …" : "";
    omit(collector, { path, reason: trimText(`external modules (${names.length}): ${shown.join(", ")}${suffix}`) });
  }
}

/** Dart package names declared by a pubspec.yaml inside the changed set. */
function pubspecRoots(diffs: Map<string, DiffFile>): Map<string, string> {
  const roots = new Map<string, string>();
  for (const [path, diff] of diffs) {
    if (path !== "pubspec.yaml" && !path.endsWith("/pubspec.yaml")) continue;
    const name = pubspecPackageName(buildDoc(diff, "new").text);
    if (name) roots.set(name, posix.dirname(path));
  }
  return roots;
}

function indexOf(files: StructureFile[]): ResolutionIndex {
  const index: ResolutionIndex = { current: new Map(), previous: new Map() };
  for (const file of files) {
    index.current.set(file.path, file.path);
    if (file.renamedFrom) index.previous.set(file.renamedFrom, file.path);
  }
  return index;
}

function analyzeFiles(
  files: StructureFile[], diffs: Map<string, DiffFile>, neighbours: boolean,
): { collector: Collector; index: ResolutionIndex } {
  const index = indexOf(files);
  const collector: Collector = {
    edges: new Map(), omitted: [], external: new Map(), pending: [], packageRoots: pubspecRoots(diffs),
    unresolved: false, unresolvedLinks: 0, truncated: false, suppressed: 0, droppedEdges: 0,
  };
  const context: AnalysisContext = { packageRoots: collector.packageRoots, neighbours };
  for (const file of files) {
    if (!file.analyzed) continue;
    const language = languageOf(file.path)!;
    const diff = diffs.get(file.path)!;
    const budget = { left: STRUCTURE_LIMITS.statementsPerFile };
    analyzeSide(collector, file, diff, "new", index, budget, context, language);
    analyzeSide(collector, file, diff, "old", index, budget, context, language);
  }
  return { collector, index };
}

function sourceReasons(kind: InputSnapshot["kind"]): string[] {
  if (kind === "paste") {
    return ["pasted code: structure analysis is unavailable because the comparison has no Git provenance; load a worktree, staged, commit, range, or pull-request source"];
  }
  if (kind === "pr") return ["patch-only: base and head objects are not read locally"];
  return [];
}

function capOmissions(collector: Collector, parsed: ParsedDiff, kept: number): void {
  if (parsed.extraFiles) {
    collector.truncated = true;
    collector.omitted.push({ reason: `file cap reached: expected at most ${STRUCTURE_LIMITS.maxFiles} changed files, received ${kept + parsed.extraFiles}; ${parsed.extraFiles} files are omitted` });
  }
  if (parsed.longLines) {
    collector.truncated = true;
    collector.omitted.push({ reason: `line length cap: ${parsed.longLines} lines longer than ${STRUCTURE_LIMITS.lineLength} characters were truncated; imports past that point are not analyzed` });
  }
  if (collector.droppedEdges) {
    collector.omitted.push({ reason: `connection cap reached: expected at most ${STRUCTURE_LIMITS.maxEdges} connections, received ${STRUCTURE_LIMITS.maxEdges + collector.droppedEdges}; ${collector.droppedEdges} connections are omitted` });
  }
  if (collector.suppressed) {
    collector.omitted.push({ reason: `further omissions not listed (${collector.suppressed} more)` });
  }
}

function analyze(input: InputSnapshot, neighbours: boolean): { analysis: Analysis; index: ResolutionIndex } {
  const reasons = sourceReasons(input.kind);
  const parsed = parseUnifiedDiff(input.content);
  reasons.push(...parsed.reasons);
  const files = parsed.files.map(describeFile).sort((left, right) => compareText(left.path, right.path));
  const diffs = new Map(parsed.files.map((file) => [displayPath(file), file] as const));
  const { collector, index } = analyzeFiles(files, diffs, neighbours);
  return { analysis: { input, reasons, files, parsed, collector }, index };
}

function finish(analysis: Analysis, neighbours: StructureNeighbours): StructureSnapshot {
  const { input, reasons, files, parsed, collector } = analysis;
  for (const edge of collector.edges.values()) {
    edge.evidence.sort((left, right) => left.line - right.line || compareText(left.path, right.path));
  }
  const edges = sortEdges(collapseModified([...collector.edges.values()]));
  collectExternal(collector);
  capOmissions(collector, parsed, files.length);
  if (collector.truncated) reasons.push("bounded analysis: some changed files, statements, or connections exceed the resource caps and are omitted");
  if (collector.unresolved || collector.unresolvedLinks > 0) reasons.push("some specifiers match no changed file: no import data for those statements");
  return {
    protocol: "rt/1",
    inputId: input.id,
    comparison: comparisonOf(input, reasons),
    files,
    edges,
    limits: limitsOf(collector.truncated, collector.omitted),
    neighbours,
  };
}

/**
 * Builds the deterministic Structure snapshot for one immutable input snapshot.
 * Pure and lexical: no file reads, no child processes, no Git access, no execution.
 */
export function buildStructureSnapshot(input: InputSnapshot): StructureSnapshot {
  if (input.kind === "paste") return emptySnapshot(input, sourceReasons(input.kind));
  return finish(analyze(input, false).analysis, NEIGHBOURS_OFF);
}

/** Route-safe wrapper: a malformed input degrades to a partial snapshot instead of throwing. */
export function structureSnapshotFor(input: InputSnapshot): StructureSnapshot {
  try {
    return buildStructureSnapshot(input);
  } catch (error) {
    return failedSnapshot(input, error);
  }
}

function failedSnapshot(input: InputSnapshot, error: unknown): StructureSnapshot {
  const message = error instanceof Error ? error.message : String(error);
  return emptySnapshot(input, [
    `structure analysis failed: expected a parsable unified diff, received content this analyzer could not process (${message}); reload the source or switch to the Diff view`,
  ]);
}

interface NeighbourState {
  reader: NeighbourReader;
  found: Map<string, string>;
  index: ResolutionIndex;
  analysis: Analysis;
}

/** Bounded ancestor directories of each importing file, repository root last. */
function pubspecDirectories(links: PendingLink[]): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const link of links) {
    let directory = posix.dirname(link.from);
    for (let depth = 0; depth < PUBSPEC_DEPTH && directory !== "." && directory !== "/"; depth += 1) {
      if (!seen.has(directory)) { seen.add(directory); directories.push(directory); }
      directory = posix.dirname(directory);
    }
  }
  directories.push("");
  return directories;
}

/** Reads the pubspec that names each deferred `package:` URI; absence is expected and silent. */
async function loadPubspecs(state: NeighbourState): Promise<void> {
  const collector = state.analysis.collector;
  const links = collector.pending.filter((link) => link.target.kind === "package");
  if (!links.length) return;
  const wanted = new Set(links.map((link) => (link.target as { name: string }).name));
  for (const directory of pubspecDirectories(links)) {
    if ([...wanted].every((name) => collector.packageRoots.has(name))) return;
    const content = await state.reader.support(posix.join(directory, "pubspec.yaml"));
    const name = content === undefined ? undefined : pubspecPackageName(content);
    if (name && !collector.packageRoots.has(name)) collector.packageRoots.set(name, directory);
  }
}

function candidatesOf(link: PendingLink, packageRoots: Map<string, string>): string[] {
  if (link.target.kind === "candidates") return link.target.paths;
  if (link.target.kind !== "package") return [];
  const root = packageRoots.get(link.target.name);
  return root === undefined ? [] : [posix.join(root, "lib", link.target.path)];
}

function attachNeighbourFile(state: NeighbourState, path: string, content: string): void {
  if (state.found.has(path)) return;
  state.found.set(path, content);
  state.index.current.set(path, path);
  state.analysis.files.push({ path, status: "context", additions: 0, deletions: 0, analyzed: true });
}

function resolveLink(state: NeighbourState, link: PendingLink, to: string): void {
  const collector = state.analysis.collector;
  if (link.target.kind === "package") collector.unresolvedLinks += 1;
  drop(collector, link);
  collector.unresolvedLinks -= 1;
  addEdge(collector, {
    from: link.from, to, kind: link.statement.kind, typeOnly: link.statement.typeOnly,
    status: link.status, specifier: link.statement.specifier, evidence: [],
  }, link.evidence);
}

/**
 * A deferred `package:` URI whose package no pubspec named is an external module,
 * not a missing file; one whose package is known but whose file is absent is unresolved.
 */
function settlePackage(state: NeighbourState, link: PendingLink): void {
  const collector = state.analysis.collector;
  if (link.target.kind !== "package") return;
  if (!collector.packageRoots.has(link.target.name)) {
    return addExternal(collector, link.from, link.statement.specifier);
  }
  collector.unresolvedLinks += 1;
  omit(collector, { path: link.from, reason: trimText(
    `specifier '${link.statement.specifier}' at line ${link.line} matches no changed file: no import data outside the changed set`) });
}

async function resolvePending(state: NeighbourState): Promise<void> {
  const collector = state.analysis.collector;
  for (const link of collector.pending) {
    const paths = candidatesOf(link, collector.packageRoots);
    const known = paths.length ? lookup(paths, state.index, "new") : undefined;
    if (known) {
      resolveLink(state, link, known);
      continue;
    }
    const read = paths.length ? await state.reader.find(paths) : undefined;
    if (!read) {
      settlePackage(state, link);
      continue;
    }
    attachNeighbourFile(state, read.path, read.content);
    resolveLink(state, link, read.path);
  }
}

/** A neighbour's own outgoing connections, bounded to the already-known file set. */
function analyzeNeighbour(state: NeighbourState, path: string, content: string): void {
  const language = languageOf(path);
  if (!language) return;
  const collector = state.analysis.collector;
  const doc = contentDoc(content);
  const { statements } = scanFor(language, doc.text);
  for (const statement of statements.slice(0, STRUCTURE_LIMITS.statementsPerFile)) {
    const specifier = specifierLineFor(doc, statement.specifierOffset, "new");
    if (!specifier) continue;
    const target = targetFor(language, path, statement, collector.packageRoots);
    if (target.kind !== "candidates") continue;
    const resolved = lookup(target.paths, state.index, "new");
    if (!resolved || resolved === path) continue;
    addEdge(collector, {
      from: path, to: resolved, kind: statement.kind, typeOnly: statement.typeOnly,
      status: "unchanged", specifier: statement.specifier, evidence: [],
    }, evidenceFor(path, doc, statement, specifier));
  }
}

async function attachNeighbours(
  analysis: Analysis, index: ResolutionIndex, source: NeighbourSource, request: NeighbourRequest,
): Promise<StructureNeighbours> {
  const state: NeighbourState = {
    reader: new NeighbourReader({
      execFile: request.execFile, cwd: request.cwd, prefix: source.prefix,
      ...(request.now ? { now: request.now } : {}), ...(request.signal ? { signal: request.signal } : {}),
      ...(request.deadline ? { deadline: request.deadline } : {}),
    }),
    found: new Map(), index, analysis,
  };
  await loadPubspecs(state);
  await resolvePending(state);
  for (const path of [...state.found.keys()].sort(compareText)) analyzeNeighbour(state, path, state.found.get(path)!);
  for (const omission of state.reader.omissions) omit(analysis.collector, omission);
  if (state.reader.truncated) analysis.collector.truncated = true;
  analysis.files.sort((left, right) => compareText(left.path, right.path));
  if (state.found.size && source.reason) analysis.reasons.push(source.reason);
  return { state: "on", count: state.found.size };
}

/**
 * Route-safe Structure snapshot with optional one-hop neighbours. Neighbour content
 * is read only through Git, only for Git-based sources, and only within the caps.
 */
export async function structureSnapshotWithNeighbours(
  input: InputSnapshot, request: NeighbourRequest,
): Promise<StructureSnapshot> {
  try {
    if (!request.neighbours) return buildStructureSnapshot(input);
    const source = neighbourSourceFor(input);
    if ("unavailable" in source) {
      return { ...buildStructureSnapshot(input), neighbours: { state: "unavailable", count: 0, reason: source.unavailable } };
    }
    const { analysis, index } = analyze(input, true);
    return finish(analysis, await attachNeighbours(analysis, index, source, request));
  } catch (error) {
    return failedSnapshot(input, error);
  }
}
