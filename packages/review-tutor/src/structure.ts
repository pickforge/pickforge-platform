import { posix } from "node:path";
import {
  STRUCTURE_LIMITS,
  type InputSnapshot,
  type StructureComparison,
  type StructureEdge,
  type StructureEvidence,
  type StructureFile,
  type StructureLimits,
  type StructureOmission,
  type StructureSnapshot,
} from "./protocol.ts";

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
interface Statement {
  kind: StructureEdge["kind"];
  specifier: string;
  typeOnly: boolean;
  offset: number;
  specifierOffset: number;
}

interface ResolutionIndex { current: Map<string, string>; previous: Map<string, string> }

interface Collector {
  edges: Map<string, StructureEdge>;
  omitted: StructureOmission[];
  external: Map<string, Set<string>>;
  unresolved: boolean;
  truncated: boolean;
  suppressed: number;
  droppedEdges: number;
}

const ANALYZED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const EXTENSIONLESS_CANDIDATES = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
/** Statement keywords, ignoring member access such as `foo.import`. */
const STATEMENT_KEYWORD = /(?<![.$\w])(import|export)(?![\w$])/g;
/**
 * Import-clause characters only: identifiers, `*`, `,`, braces and whitespace.
 * Anything else (`=`, `(`, an operator) means this is not an import statement,
 * so semicolon-free code cannot bind to a later `from "…"`.
 */
const FROM_TAIL = /(import|export)([\w$*,{}\s]{0,2000}?)\bfrom\s*(['"])[^'"\n]*\3/y;
const CLAUSE_CHARACTER = /[\w$*,{}\s]/;
const CLAUSE_LIMIT = 2000;
const CLAUSE_SCAN = 20_000;
const BARE_TAIL = /import\s+(['"])[^'"\n]*\1/y;
const CALL_IMPORT = /(?<![.$\w])(require|import)\s*\(\s*/g;
const NESTED_KEYWORD = /(?<![.$\w])(import|export)(?![\w$])/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000A-\u001F\u007F]/g;
const REGEX_START = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";"]);
const EXPRESSION_KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "delete", "void", "throw",
  "do", "else", "yield", "await", "instanceof", "new",
]);
const WORD_CHARACTER = /[\w$]/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const match = /\.[A-Za-z0-9]+$/.exec(name);
  return match ? match[0].toLowerCase() : "";
}

function unquotePath(value: string): string {
  if (!value.startsWith("\"") || !value.endsWith("\"") || value.length < 2) return value;
  return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

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

function maskString(text: string, out: string[], start: number): number {
  const quote = text[start]!;
  let index = start + 1;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "\\") {
      out[index] = " ";
      if (text[index + 1] !== undefined && text[index + 1] !== "\n") out[index + 1] = " ";
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    if (character === "\n" && quote !== "`") return index;
    if (character !== "\n") out[index] = " ";
    index += 1;
  }
  return index;
}

function maskLineComment(text: string, out: string[], start: number): number {
  let index = start;
  while (index < text.length && text[index] !== "\n") { out[index] = " "; index += 1; }
  return index;
}

function maskBlockComment(text: string, out: string[], start: number): number {
  out[start] = " ";
  out[start + 1] = " ";
  let index = start + 2;
  while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
    if (text[index] !== "\n") out[index] = " ";
    index += 1;
  }
  if (index < text.length) { out[index] = " "; out[index + 1] = " "; }
  return index + 2;
}

function skipBackWhitespace(text: ArrayLike<string>, from: number): number {
  let cursor = from;
  while (cursor >= 0 && (text[cursor] === " " || text[cursor] === "\t" || text[cursor] === "\n")) cursor -= 1;
  return cursor;
}

/** The identifier ending at `cursor`, or "" when it is longer than an operator keyword. */
function wordBefore(text: string[], cursor: number): string {
  let start = cursor;
  while (start >= 0 && WORD_CHARACTER.test(text[start]!)) {
    if (cursor - start > 12) return "";
    start -= 1;
  }
  return text.slice(start + 1, cursor + 1).join("");
}

/** True when a `/` at `start` opens a regex literal rather than a division. */
function opensRegex(out: string[], start: number): boolean {
  const cursor = skipBackWhitespace(out, start - 1);
  if (cursor < 0) return true;
  const previous = out[cursor]!;
  if (REGEX_START.has(previous)) return true;
  if (previous === ">" && cursor > 0 && out[cursor - 1] === "=") return true;
  if (!WORD_CHARACTER.test(previous)) return false;
  const word = wordBefore(out, cursor);
  if (!EXPRESSION_KEYWORDS.has(word)) return false;
  const beforeWord = skipBackWhitespace(out, cursor - word.length);
  return beforeWord < 0 || out[beforeWord] !== ".";
}

function regexEnd(text: string, start: number): number | undefined {
  let index = start + 1;
  while (index < text.length && text[index] !== "\n") {
    if (text[index] === "\\") { index += 2; continue; }
    if (text[index] === "/") return index;
    index += 1;
  }
  return undefined;
}

function maskRegexLiteral(text: string, out: string[], start: number): number | undefined {
  if (!opensRegex(out, start)) return undefined;
  const end = regexEnd(text, start);
  if (end === undefined) return undefined;
  for (let index = start; index <= end; index += 1) out[index] = " ";
  return end + 1;
}

/**
 * Blanks comment, string, and regex-literal bodies while preserving every UTF-16
 * offset, so no keyword inside them can be read as an import statement.
 */
export function maskLiterals(text: string): string {
  const out = text.split("");
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    const next = text[index + 1];
    if (character === "/" && next === "/") index = maskLineComment(text, out, index);
    else if (character === "/" && next === "*") index = maskBlockComment(text, out, index);
    else if (character === "'" || character === "\"" || character === "`") index = maskString(text, out, index);
    else if (character === "/") index = maskRegexLiteral(text, out, index) ?? index + 1;
    else index += 1;
  }
  return out.join("");
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

function pushFromStatement(doc: Doc, mask: string, at: number, statements: Statement[]): boolean {
  FROM_TAIL.lastIndex = at;
  const match = FROM_TAIL.exec(mask);
  if (!match || NESTED_KEYWORD.test(match[2]!)) return false;
  const whole = match[0];
  const open = whole.lastIndexOf(match[3]!, whole.length - 2);
  if (open < 0) return false;
  statements.push({
    kind: match[1] === "export" ? "reexport" : "import",
    specifier: doc.text.slice(at + open + 1, at + whole.length - 1),
    typeOnly: /^\s*type\b/.test(match[2]!),
    offset: at,
    specifierOffset: at + open,
  });
  return true;
}

function pushBareImport(doc: Doc, mask: string, at: number, statements: Statement[]): void {
  BARE_TAIL.lastIndex = at;
  const match = BARE_TAIL.exec(mask);
  if (!match) return;
  const whole = match[0];
  const open = whole.indexOf(match[1]!);
  statements.push({
    kind: "import",
    specifier: doc.text.slice(at + open + 1, at + whole.length - 1),
    typeOnly: false,
    offset: at,
    specifierOffset: at + open,
  });
}

/**
 * True when an import clause runs past the work bound before its module string,
 * which is a statement the scanner must report rather than silently drop.
 */
function overlongClause(mask: string, at: number, keyword: string): boolean {
  let index = at + keyword.length;
  const stop = Math.min(mask.length, index + CLAUSE_SCAN);
  while (index < stop && CLAUSE_CHARACTER.test(mask[index]!)) index += 1;
  if (index - (at + keyword.length) <= CLAUSE_LIMIT) return false;
  return mask[index] === "'" || mask[index] === "\"";
}

function scanStatementKeywords(doc: Doc, mask: string, statements: Statement[], overlong: number[]): void {
  for (const keyword of mask.matchAll(STATEMENT_KEYWORD)) {
    if (pushFromStatement(doc, mask, keyword.index, statements)) continue;
    if (overlongClause(mask, keyword.index, keyword[1]!)) {
      overlong.push(keyword.index);
      continue;
    }
    pushBareImport(doc, mask, keyword.index, statements);
  }
}

/** `shim . require("x")` and `shim ?. import("x")` are member calls, not module loads. */
function memberCall(mask: string, at: number): boolean {
  const cursor = skipBackWhitespace(mask, at - 1);
  return cursor >= 0 && mask[cursor] === ".";
}

function scanCallStatements(doc: Doc, mask: string, statements: Statement[], nonLiteral: number[]): void {
  for (const match of mask.matchAll(CALL_IMPORT)) {
    if (memberCall(mask, match.index)) continue;
    const start = match.index + match[0].length;
    const quote = mask[start];
    const close = quote === "'" || quote === "\"" ? mask.indexOf(quote, start + 1) : -1;
    if (close < 0 || !/^\s*\)/.test(mask.slice(close + 1, close + 8))) {
      nonLiteral.push(match.index);
      continue;
    }
    statements.push({
      kind: match[1] === "require" ? "require" : "dynamic-import",
      specifier: doc.text.slice(start + 1, close),
      typeOnly: false,
      offset: match.index,
      specifierOffset: start,
    });
  }
}

/** Lexical, non-executing scan of one reconstructed document side. */
function scanDoc(doc: Doc): { statements: Statement[]; nonLiteral: number[]; overlong: number[] } {
  const mask = maskLiterals(doc.text);
  const statements: Statement[] = [];
  const nonLiteral: number[] = [];
  const overlong: number[] = [];
  scanStatementKeywords(doc, mask, statements, overlong);
  scanCallStatements(doc, mask, statements, nonLiteral);
  return { statements, nonLiteral, overlong };
}

function candidatePaths(base: string): string[] {
  const list = [base];
  const extension = extensionOf(base);
  for (const replacement of JS_TO_TS[extension] ?? []) {
    list.push(`${base.slice(0, -extension.length)}${replacement}`);
  }
  if (!extension) {
    for (const candidate of EXTENSIONLESS_CANDIDATES) list.push(`${base}${candidate}`);
    for (const candidate of EXTENSIONLESS_CANDIDATES) list.push(`${base}/index${candidate}`);
  }
  return list;
}

/**
 * Candidate-path matching against the changed-file set only; no Node resolution,
 * no filesystem access. Old-side lookups consult pre-rename paths first because the
 * pre-change tree still held them; new-side lookups never do.
 */
function resolveSpecifier(from: string, specifier: string, index: ResolutionIndex, side: Side): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier.replace(/\\/g, "/"))).replace(/\/+$/, "");
  for (const candidate of candidatePaths(base)) {
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

function omit(collector: Collector, omission: StructureOmission): void {
  if (collector.omitted.some((existing) => existing.path === omission.path && existing.reason === omission.reason)) return;
  if (collector.omitted.length >= STRUCTURE_LIMITS.omittedRows) {
    collector.suppressed += 1;
    return;
  }
  collector.omitted.push(omission);
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

function evidenceFor(file: StructureFile, doc: Doc, statement: Statement, specifier: DocLine): StructureEvidence[] {
  const first = lineAt(doc, statement.offset);
  const lines = first && first.number !== specifier.number ? [first, specifier] : [specifier];
  return lines.map((line) => ({ path: file.path, line: line.number, text: trimText(line.text) }));
}

function recordStatement(
  collector: Collector, file: StructureFile, doc: Doc, side: Side,
  statement: Statement, index: ResolutionIndex,
): void {
  const specifier = specifierLineFor(doc, statement.specifierOffset, side);
  if (!specifier) return;
  if (!statement.specifier.startsWith(".")) {
    const bucket = collector.external.get(file.path) ?? new Set<string>();
    bucket.add(statement.specifier);
    collector.external.set(file.path, bucket);
    return;
  }
  const base = side === "old" ? file.renamedFrom ?? file.path : file.path;
  const target = resolveSpecifier(base, statement.specifier, index, side);
  if (!target) {
    collector.unresolved = true;
    omit(collector, { path: file.path, reason: trimText(
      `specifier '${statement.specifier}' at line ${specifier.number} matches no changed file: no import data outside the changed set`) });
    return;
  }
  const status = specifier.origin === "add" ? "added" : specifier.origin === "del" ? "removed" : "unchanged";
  addEdge(collector, {
    from: file.path, to: target, kind: statement.kind, typeOnly: statement.typeOnly,
    status, specifier: statement.specifier, evidence: [],
  }, evidenceFor(file, doc, statement, specifier));
}

function analyzeSide(
  collector: Collector, file: StructureFile, diff: DiffFile, side: Side,
  index: ResolutionIndex, budget: { left: number },
): void {
  const doc = buildDoc(diff, side);
  if (!doc.text) return;
  const { statements, nonLiteral, overlong } = scanDoc(doc);
  const allowed = statements.slice(0, Math.max(0, budget.left));
  budget.left -= statements.length;
  if (budget.left < 0) {
    collector.truncated = true;
    omit(collector, { path: file.path, reason:
      `statement cap reached: expected at most ${STRUCTURE_LIMITS.statementsPerFile} import statements in this file, received more; later statements are not analyzed` });
  }
  for (const statement of allowed) recordStatement(collector, file, doc, side, statement, index);
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
  if (!ANALYZED_EXTENSIONS.includes(extension)) {
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

function emptySnapshot(input: InputSnapshot, reasons: string[]): StructureSnapshot {
  return {
    protocol: "rt/1",
    inputId: input.id,
    comparison: comparisonOf(input, reasons),
    files: [],
    edges: [],
    limits: limitsOf(false, []),
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

function analyzeFiles(files: StructureFile[], diffs: Map<string, DiffFile>): Collector {
  const index: ResolutionIndex = { current: new Map(), previous: new Map() };
  for (const file of files) {
    index.current.set(file.path, file.path);
    if (file.renamedFrom) index.previous.set(file.renamedFrom, file.path);
  }
  const collector: Collector = {
    edges: new Map(), omitted: [], external: new Map(),
    unresolved: false, truncated: false, suppressed: 0, droppedEdges: 0,
  };
  for (const file of files) {
    if (!file.analyzed) continue;
    const diff = diffs.get(file.path)!;
    const budget = { left: STRUCTURE_LIMITS.statementsPerFile };
    analyzeSide(collector, file, diff, "new", index, budget);
    analyzeSide(collector, file, diff, "old", index, budget);
  }
  collectExternal(collector);
  return collector;
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

/**
 * Builds the deterministic Structure snapshot for one immutable input snapshot.
 * Pure and lexical: no file reads, no child processes, no Git access, no execution.
 */
export function buildStructureSnapshot(input: InputSnapshot): StructureSnapshot {
  const reasons = sourceReasons(input.kind);
  if (input.kind === "paste") return emptySnapshot(input, reasons);
  const parsed = parseUnifiedDiff(input.content);
  reasons.push(...parsed.reasons);
  const files = parsed.files.map(describeFile).sort((left, right) => compareText(left.path, right.path));
  const collector = analyzeFiles(files, new Map(parsed.files.map((file) => [displayPath(file), file] as const)));
  for (const edge of collector.edges.values()) {
    edge.evidence.sort((left, right) => left.line - right.line || compareText(left.path, right.path));
  }
  const edges = sortEdges(collapseModified([...collector.edges.values()]));
  capOmissions(collector, parsed, files.length);
  if (collector.truncated) reasons.push("bounded analysis: some changed files, statements, or connections exceed the resource caps and are omitted");
  if (collector.unresolved) reasons.push("some specifiers match no changed file: no import data for those statements");
  return {
    protocol: "rt/1",
    inputId: input.id,
    comparison: comparisonOf(input, reasons),
    files,
    edges,
    limits: limitsOf(collector.truncated, collector.omitted),
  };
}

/** Route-safe wrapper: a malformed input degrades to a partial snapshot instead of throwing. */
export function structureSnapshotFor(input: InputSnapshot): StructureSnapshot {
  try {
    return buildStructureSnapshot(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptySnapshot(input, [
      `structure analysis failed: expected a parsable unified diff, received content this analyzer could not process (${message}); reload the source or switch to the Diff view`,
    ]);
  }
}
