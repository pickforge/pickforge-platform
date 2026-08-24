import { posix } from "node:path";
import type { StructureEdge } from "./protocol.ts";

/**
 * Private language tables for the Structure analyzer. Every entry is a lexical
 * table — masking, statement scanning, and candidate-path resolution — for one
 * language. There is no plugin surface: adding a language means adding a table
 * here and one line to `languageForExtension`.
 */
export type LanguageId = "ts" | "dart" | "rust";

export interface Statement {
  kind: StructureEdge["kind"];
  specifier: string;
  typeOnly: boolean;
  offset: number;
  specifierOffset: number;
  /** Resolve this specifier as exactly one path, with no per-language fallbacks. */
  exact?: boolean;
}

export interface ScanResult {
  statements: Statement[];
  nonLiteral: number[];
  overlong: number[];
  /** Directives this table understands but cannot resolve, reported verbatim. */
  unsupported: { offset: number; reason: string }[];
}

/**
 * `external` aggregates without an edge, `candidates` is an ordered repo-relative
 * candidate list, and `package` defers a Dart `package:` URI until a pubspec is known.
 */
export type ResolutionTarget =
  | { kind: "external"; name: string }
  | { kind: "candidates"; paths: string[] }
  | { kind: "package"; name: string; path: string };

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const WORD_CHARACTER = /[\w$]/;

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const match = /\.[A-Za-z0-9]+$/.exec(name);
  return match ? match[0].toLowerCase() : "";
}

export function languageForExtension(extension: string): LanguageId | undefined {
  if (TS_EXTENSIONS.includes(extension)) return "ts";
  if (extension === ".dart") return "dart";
  if (extension === ".rs") return "rust";
  return undefined;
}

function maskSpan(out: string[], from: number, to: number): void {
  for (let index = from; index < to && index < out.length; index += 1) {
    if (out[index] !== "\n") out[index] = " ";
  }
}

function maskLineComment(text: string, out: string[], start: number): number {
  let index = start;
  while (index < text.length && text[index] !== "\n") { out[index] = " "; index += 1; }
  return index;
}

/** Nested `/* … *​/` comments, as Dart and Rust both define them. */
function maskNestedBlock(text: string, out: string[], start: number): number {
  let index = start + 2;
  let depth = 1;
  maskSpan(out, start, index);
  while (index < text.length && depth > 0) {
    if (text[index] === "/" && text[index + 1] === "*") { depth += 1; maskSpan(out, index, index + 2); index += 2; continue; }
    if (text[index] === "*" && text[index + 1] === "/") { depth -= 1; maskSpan(out, index, index + 2); index += 2; continue; }
    maskSpan(out, index, index + 1);
    index += 1;
  }
  return index;
}

// ---------------------------------------------------------------------------
// TypeScript and JavaScript
// ---------------------------------------------------------------------------

/** Statement keywords, ignoring member access such as `foo.import`. */
const STATEMENT_KEYWORD = /(?<![.$\w])(import|export)(?![\w$])/g;
/**
 * Import-clause characters only: identifiers, `*`, `,`, braces and whitespace.
 * Anything else (`=`, `(`, an operator) means this is not an import statement,
 * so semicolon-free code cannot bind to a later `from "…"`.
 */
const FROM_TAIL = /(import|export)([\w$*,{}\s]{0,2000}?)\bfrom\s*(['"])[^'"\n]*\3/y;
const CLAUSE_CHARACTER = /[\w$*,{}\s]/;
export const CLAUSE_LIMIT = 2000;
const CLAUSE_SCAN = 20_000;
const BARE_TAIL = /import\s+(['"])[^'"\n]*\1/y;
const CALL_IMPORT = /(?<![.$\w])(require|import)\s*\(\s*/g;
const NESTED_KEYWORD = /(?<![.$\w])(import|export)(?![\w$])/;
const REGEX_START = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";"]);
const EXPRESSION_KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "delete", "void", "throw",
  "do", "else", "yield", "await", "instanceof", "new",
]);

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

function pushFromStatement(text: string, mask: string, at: number, statements: Statement[]): boolean {
  FROM_TAIL.lastIndex = at;
  const match = FROM_TAIL.exec(mask);
  if (!match || NESTED_KEYWORD.test(match[2]!)) return false;
  const whole = match[0];
  const open = whole.lastIndexOf(match[3]!, whole.length - 2);
  if (open < 0) return false;
  statements.push({
    kind: match[1] === "export" ? "reexport" : "import",
    specifier: text.slice(at + open + 1, at + whole.length - 1),
    typeOnly: /^\s*type\b/.test(match[2]!),
    offset: at,
    specifierOffset: at + open,
  });
  return true;
}

function pushBareImport(text: string, mask: string, at: number, statements: Statement[]): void {
  BARE_TAIL.lastIndex = at;
  const match = BARE_TAIL.exec(mask);
  if (!match) return;
  const whole = match[0];
  const open = whole.indexOf(match[1]!);
  statements.push({
    kind: "import",
    specifier: text.slice(at + open + 1, at + whole.length - 1),
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

function scanStatementKeywords(text: string, mask: string, statements: Statement[], overlong: number[]): void {
  for (const keyword of mask.matchAll(STATEMENT_KEYWORD)) {
    if (pushFromStatement(text, mask, keyword.index, statements)) continue;
    if (overlongClause(mask, keyword.index, keyword[1]!)) {
      overlong.push(keyword.index);
      continue;
    }
    pushBareImport(text, mask, keyword.index, statements);
  }
}

/** `shim . require("x")` and `shim ?. import("x")` are member calls, not module loads. */
function memberCall(mask: string, at: number): boolean {
  const cursor = skipBackWhitespace(mask, at - 1);
  return cursor >= 0 && mask[cursor] === ".";
}

function scanCallStatements(text: string, mask: string, statements: Statement[], nonLiteral: number[]): void {
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
      specifier: text.slice(start + 1, close),
      typeOnly: false,
      offset: match.index,
      specifierOffset: start,
    });
  }
}

function scanTypeScript(text: string, mask: string): ScanResult {
  const statements: Statement[] = [];
  const nonLiteral: number[] = [];
  const overlong: number[] = [];
  scanStatementKeywords(text, mask, statements, overlong);
  scanCallStatements(text, mask, statements, nonLiteral);
  return { statements, nonLiteral, overlong, unsupported: [] };
}

function typeScriptCandidates(base: string): string[] {
  const list = [base];
  const extension = extensionOf(base);
  for (const replacement of JS_TO_TS[extension] ?? []) {
    list.push(`${base.slice(0, -extension.length)}${replacement}`);
  }
  if (!extension) {
    for (const candidate of TS_EXTENSIONS) list.push(`${base}${candidate}`);
    for (const candidate of TS_EXTENSIONS) list.push(`${base}/index${candidate}`);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Dart
// ---------------------------------------------------------------------------

const DART_DIRECTIVE = /(?<![\w$.])(import|export|part\s+of|part)(?![\w$])/g;
const DART_PACKAGE = /^package:([A-Za-z_][A-Za-z0-9_]*)\/(.+)$/;
const DART_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const PUBSPEC_NAME = /^name:[ \t]*["']?([A-Za-z_][A-Za-z0-9_]*)["']?[ \t]*$/m;
const DART_LIBRARY_NAME = /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?=\s*;)/;

/** Blanks a Dart or Rust quoted body, keeping the delimiters so the scanner can find them. */
function maskQuoted(text: string, out: string[], start: number, raw: boolean, allowTriple = true): number {
  const quote = text[start]!;
  const triple = allowTriple && text[start + 1] === quote && text[start + 2] === quote;
  const delimiter = triple ? quote.repeat(3) : quote;
  let index = start + delimiter.length;
  while (index < text.length) {
    if (!raw && text[index] === "\\") { maskSpan(out, index, index + 2); index += 2; continue; }
    if (text.startsWith(delimiter, index)) return index + delimiter.length;
    if (!triple && text[index] === "\n") return index;
    maskSpan(out, index, index + 1);
    index += 1;
  }
  return index;
}

function wordBoundaryBefore(text: string, index: number): boolean {
  return index === 0 || !WORD_CHARACTER.test(text[index - 1]!);
}

export function maskDart(text: string): string {
  const out = text.split("");
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    const next = text[index + 1];
    if (character === "/" && next === "/") index = maskLineComment(text, out, index);
    else if (character === "/" && next === "*") index = maskNestedBlock(text, out, index);
    else if (character === "r" && (next === "'" || next === "\"") && wordBoundaryBefore(text, index)) {
      index = maskQuoted(text, out, index + 1, true);
    } else if (character === "'" || character === "\"") index = maskQuoted(text, out, index, false);
    else index += 1;
  }
  return out.join("");
}

interface QuotedString { value: string; start: number; end: number }

/** Reads the first Dart string literal at or after `from`, skipping whitespace and an `r` prefix. */
function quotedStringAt(text: string, mask: string, from: number): QuotedString | undefined {
  let index = from;
  while (index < mask.length && /\s/.test(mask[index]!)) index += 1;
  if (mask[index] === "r") index += 1;
  const quote = mask[index];
  if (quote !== "'" && quote !== "\"") return undefined;
  const triple = mask[index + 1] === quote && mask[index + 2] === quote;
  const delimiter = triple ? quote.repeat(3) : quote;
  const bodyStart = index + delimiter.length;
  const close = mask.indexOf(delimiter, bodyStart);
  if (close < 0) return undefined;
  return { value: text.slice(bodyStart, close), start: index, end: close + delimiter.length };
}

const DART_KINDS: Record<string, StructureEdge["kind"]> = {
  import: "import", export: "reexport", part: "part",
};

function scanDart(text: string, mask: string): ScanResult {
  const statements: Statement[] = [];
  const unsupported: { offset: number; reason: string }[] = [];
  for (const directive of mask.matchAll(DART_DIRECTIVE)) {
    const keyword = directive[1]!;
    const after = directive.index + directive[0].length;
    const string = quotedStringAt(text, mask, after);
    if (!string) {
      const library = DART_LIBRARY_NAME.exec(mask.slice(after, after + 256))?.[0]?.trim();
      if (keyword !== "part" && library) {
        unsupported.push({
          offset: directive.index,
          reason: `part-of library name '${library}': no import data without a library file path`,
        });
      }
      continue;
    }
    statements.push({
      kind: keyword.startsWith("part") && keyword !== "part" ? "part-of" : DART_KINDS[keyword]!,
      specifier: string.value,
      typeOnly: false,
      offset: directive.index,
      specifierOffset: string.start,
    });
  }
  return { statements, nonLiteral: [], overlong: [], unsupported };
}

export function pubspecPackageName(content: string): string | undefined {
  return PUBSPEC_NAME.exec(content)?.[1];
}

function relativeCandidate(from: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(from), specifier.replace(/\\/g, "/"))).replace(/\/+$/, "");
}

/** `packageRoots` maps a Dart package name to the directory holding its pubspec.yaml. */
function dartTarget(from: string, statement: Statement, packageRoots: Map<string, string>): ResolutionTarget {
  const specifier = statement.specifier;
  const scoped = DART_PACKAGE.exec(specifier);
  if (scoped) {
    const root = packageRoots.get(scoped[1]!);
    if (root === undefined) return { kind: "package", name: scoped[1]!, path: scoped[2]! };
    return { kind: "candidates", paths: [posix.join(root, "lib", scoped[2]!)] };
  }
  if (DART_SCHEME.test(specifier)) return { kind: "external", name: specifier };
  return { kind: "candidates", paths: [relativeCandidate(from, specifier)] };
}

export function dartPackageCandidates(root: string, path: string): string[] {
  return [posix.join(root, "lib", path)];
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RUST_MOD = /(?<![\w:])(?:pub\s*(?:\([^)\n]{0,64}\)\s*)?)?mod\s+([A-Za-z_]\w*)\s*;/g;
const RUST_USE = /(?<![\w:])(pub\s*(?:\([^)\n]{0,64}\)\s*)?)?use(?![\w])/g;
const RUST_INCLUDE = /(?<![\w:])include(?:_str|_bytes)?!\s*[([{]/g;
const RUST_EXTERN = /(?<![\w:])extern\s+crate\s+([A-Za-z_]\w*)/g;
const RUST_PATH_ATTRIBUTE = /#\[\s*path\s*=\s*"([^"\n]{1,512})"\s*\]/g;
const RUST_ROOTS = new Set(["mod.rs", "lib.rs", "main.rs"]);
const RUST_IDENTIFIER = /^[A-Za-z_]\w*$/;
const RUST_USE_LIMIT = 4000;
const RUST_SEGMENT_LIMIT = 8;
const RUST_GROUP_LIMIT = 64;
const RUST_GROUP_DEPTH = 3;

function maskRustQuoted(text: string, out: string[], start: number): number {
  let index = start;
  if (text[index] === "b") index += 1;
  if (text[index] === "r") {
    index += 1;
    let hashes = 0;
    while (text[index] === "#") { hashes += 1; index += 1; }
    if (text[index] !== "\"") return start + 1;
    const terminator = `"${"#".repeat(hashes)}`;
    const close = text.indexOf(terminator, index + 1);
    const end = close < 0 ? text.length : close;
    maskSpan(out, index + 1, end);
    return close < 0 ? end : close + terminator.length;
  }
  if (text[index] !== "\"") return start + 1;
  return maskQuoted(text, out, index, false, false);
}

/** A `'` opens a char literal only when it closes within one escape or one character. */
function rustCharLiteral(text: string, out: string[], start: number): number {
  if (text[start + 1] === "\\") {
    const close = text.indexOf("'", start + 2);
    if (close < 0 || close - start > 10) return start + 1;
    maskSpan(out, start + 1, close);
    return close + 1;
  }
  if (text[start + 2] === "'") { maskSpan(out, start + 1, start + 2); return start + 3; }
  return start + 1;
}

/** `r"…"`, `r#"…"#`, `b"…"`, and `br#"…"#` all open a string; a bare `r` or `b` does not. */
function opensRustString(text: string, index: number): boolean {
  const character = text[index];
  if (character !== "r" && character !== "b") return false;
  const next = text[index + 1];
  return wordBoundaryBefore(text, index) && (next === "\"" || next === "#" || next === "r");
}

function opensRustByteChar(text: string, index: number): boolean {
  return text[index] === "b" && text[index + 1] === "'" && wordBoundaryBefore(text, index);
}

export function maskRust(text: string): string {
  const out = text.split("");
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    const next = text[index + 1];
    if (character === "/" && next === "/") index = maskLineComment(text, out, index);
    else if (character === "/" && next === "*") index = maskNestedBlock(text, out, index);
    else if (opensRustString(text, index)) index = maskRustQuoted(text, out, index);
    else if (opensRustByteChar(text, index)) index = rustCharLiteral(text, out, index + 1);
    else if (character === "\"") index = maskQuoted(text, out, index, false, false);
    else if (character === "'") index = rustCharLiteral(text, out, index);
    else index += 1;
  }
  return out.join("");
}

/**
 * The last `#[path = "…"]` attribute standing immediately before `offset`. The
 * attribute is matched in the masked source, so a commented-out one is invisible;
 * only its value is read from the raw text.
 */
function rustPathAttribute(text: string, mask: string, offset: number): string | undefined {
  const start = Math.max(0, offset - 300);
  const window = mask.slice(start, offset);
  let found: string | undefined;
  for (const match of window.matchAll(RUST_PATH_ATTRIBUTE)) {
    const between = window.slice(match.index + match[0].length);
    if (!/^[\s]*(?:pub\s*(?:\([^)\n]{0,64}\)\s*)?)?$/.test(between) || between.split("\n").length > 2) continue;
    const value = start + match.index + match[0].indexOf("\"") + 1;
    found = text.slice(value, value + match[1]!.length);
  }
  return found;
}

function scanRustMods(text: string, mask: string, statements: Statement[]): void {
  for (const match of mask.matchAll(RUST_MOD)) {
    const attribute = rustPathAttribute(text, mask, match.index);
    statements.push({
      kind: "mod",
      specifier: attribute ?? match[1]!,
      typeOnly: false,
      offset: match.index,
      specifierOffset: match.index,
      ...(attribute === undefined ? {} : { exact: true }),
    });
  }
}

function matchingBrace(body: string, open: number): number {
  let depth = 0;
  for (let index = open; index < body.length; index += 1) {
    if (body[index] === "{") depth += 1;
    else if (body[index] === "}" && (depth -= 1) === 0) return index;
  }
  return -1;
}

function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === "{") depth += 1;
    else if (inner[index] === "}") depth -= 1;
    else if (inner[index] === "," && depth === 0) { parts.push(inner.slice(start, index)); start = index + 1; }
  }
  parts.push(inner.slice(start));
  return parts;
}

/** `crate::{a, b}` is two use paths; `self` inside a group names the group prefix itself. */
function expandUsePaths(body: string, depth = 0): string[] {
  const open = body.indexOf("{");
  if (open < 0) return [body.trim()];
  const close = matchingBrace(body, open);
  const prefix = body.slice(0, open).trim().replace(/::$/, "");
  if (close < 0 || depth >= RUST_GROUP_DEPTH) return [prefix];
  const paths: string[] = [];
  for (const member of splitTopLevel(body.slice(open + 1, close))) {
    const trimmed = member.trim();
    if (!trimmed || paths.length >= RUST_GROUP_LIMIT) continue;
    if (trimmed === "self") { paths.push(prefix); continue; }
    for (const expanded of expandUsePaths(trimmed, depth + 1)) paths.push(`${prefix}::${expanded}`);
  }
  return paths.length ? paths.slice(0, RUST_GROUP_LIMIT) : [prefix];
}

function scanRustUses(text: string, mask: string, statements: Statement[]): void {
  for (const match of mask.matchAll(RUST_USE)) {
    const start = match.index + match[0].length;
    const semicolon = mask.indexOf(";", start);
    if (semicolon < 0 || semicolon - start > RUST_USE_LIMIT) continue;
    const body = text.slice(start, semicolon).trim();
    if (!body) continue;
    for (const path of expandUsePaths(body.replace(/\s+/g, " "))) {
      if (!path) continue;
      statements.push({
        kind: match[1] ? "reexport" : "use",
        specifier: path,
        typeOnly: false,
        offset: match.index,
        specifierOffset: match.index,
      });
    }
  }
}

function scanRustMacros(text: string, mask: string, statements: Statement[]): void {
  for (const match of mask.matchAll(RUST_INCLUDE)) {
    const string = quotedStringAt(text, mask, match.index + match[0].length);
    if (!string) continue;
    statements.push({
      kind: "include", specifier: string.value, typeOnly: false,
      offset: match.index, specifierOffset: string.start,
    });
  }
  for (const match of mask.matchAll(RUST_EXTERN)) {
    statements.push({
      kind: "use", specifier: match[1]!, typeOnly: false,
      offset: match.index, specifierOffset: match.index,
    });
  }
}

function scanRust(text: string, mask: string): ScanResult {
  const statements: Statement[] = [];
  scanRustMods(text, mask, statements);
  scanRustUses(text, mask, statements);
  scanRustMacros(text, mask, statements);
  return { statements, nonLiteral: [], overlong: [], unsupported: [] };
}

/** The directory that holds a Rust file's child modules. */
function rustModuleDir(from: string): string {
  const directory = posix.dirname(from);
  const name = from.slice(from.lastIndexOf("/") + 1);
  if (RUST_ROOTS.has(name)) return directory;
  return posix.join(directory, name.replace(/\.rs$/, ""));
}

/** `crate::` names the current crate, so the file's own `<prefix>/src` wins over a repository `src`. */
function rustCrateRoots(from: string): string[] {
  const own = /^(.*)\/src\//.exec(from);
  const roots = own ? [`${own[1]}/src`] : [];
  if (!roots.includes("src")) roots.push("src");
  return roots;
}

/** Longest resolvable prefix first: `root/a/b.rs`, `root/a/b/mod.rs`, then `root/a.rs`, … */
function rustPrefixCandidates(roots: string[], segments: string[]): string[] {
  const paths: string[] = [];
  for (const root of roots) {
    for (let length = segments.length; length > 0; length -= 1) {
      const base = posix.join(root, ...segments.slice(0, length));
      paths.push(`${base}.rs`, posix.join(base, "mod.rs"));
    }
  }
  return paths;
}

function rustUseSegments(specifier: string): string[] {
  const head = specifier.split("{")[0]!.split("*")[0]!;
  const segments = head.split("::").map((segment) => segment.trim().split(/\s+/)[0]!).filter(Boolean);
  const valid: string[] = [];
  for (const segment of segments) {
    if (!RUST_IDENTIFIER.test(segment)) break;
    valid.push(segment);
  }
  return valid.slice(0, RUST_SEGMENT_LIMIT + 1);
}

function rustRelativeRoot(from: string, segments: string[]): { root: string; rest: string[] } {
  let root = rustModuleDir(from);
  let index = 0;
  while (segments[index] === "super") { root = posix.dirname(root); index += 1; }
  if (segments[index] === "self") index += 1;
  return { root, rest: segments.slice(index) };
}

function rustUseTarget(from: string, statement: Statement): ResolutionTarget {
  const segments = rustUseSegments(statement.specifier);
  const head = segments[0];
  if (!head) return { kind: "candidates", paths: [] };
  if (head === "crate") return { kind: "candidates", paths: rustPrefixCandidates(rustCrateRoots(from), segments.slice(1)) };
  if (head === "super" || head === "self") {
    const { root, rest } = rustRelativeRoot(from, segments);
    return { kind: "candidates", paths: rustPrefixCandidates([root], rest) };
  }
  return { kind: "external", name: head };
}

function rustTarget(from: string, statement: Statement): ResolutionTarget {
  if (statement.kind === "include") return { kind: "candidates", paths: [relativeCandidate(from, statement.specifier)] };
  if (statement.kind === "mod") {
    if (statement.exact) return { kind: "candidates", paths: [relativeCandidate(from, statement.specifier)] };
    const directory = rustModuleDir(from);
    return { kind: "candidates", paths: [
      posix.join(directory, `${statement.specifier}.rs`),
      posix.join(directory, statement.specifier, "mod.rs"),
    ] };
  }
  return rustUseTarget(from, statement);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function maskFor(language: LanguageId, text: string): string {
  if (language === "dart") return maskDart(text);
  if (language === "rust") return maskRust(text);
  return maskLiterals(text);
}

export function scanFor(language: LanguageId, text: string): ScanResult {
  const mask = maskFor(language, text);
  if (language === "dart") return scanDart(text, mask);
  if (language === "rust") return scanRust(text, mask);
  return scanTypeScript(text, mask);
}

export function targetFor(
  language: LanguageId, from: string, statement: Statement, packageRoots: Map<string, string>,
): ResolutionTarget {
  if (language === "dart") return dartTarget(from, statement, packageRoots);
  if (language === "rust") return rustTarget(from, statement);
  if (!statement.specifier.startsWith(".")) return { kind: "external", name: statement.specifier };
  return { kind: "candidates", paths: typeScriptCandidates(relativeCandidate(from, statement.specifier)) };
}
