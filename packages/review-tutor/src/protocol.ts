export const LIMITS = {
  body: 1024 * 1024,
  source: 1024 * 1024,
  question: 4096,
  selected: 16 * 1024,
  context: 32 * 1024,
  language: 64,
  comparisonLanguage: 32,
  queue: 4,
  timeoutMs: 300_000,
  stdout: 8 * 1024 * 1024,
  stderr: 32 * 1024,
} as const;

export const STRUCTURE_LIMITS = {
  maxFiles: 200,
  maxEdges: 2000,
  maxEvidencePerEdge: 4,
  evidenceText: 200,
  lineLength: 4000,
  diffLines: 200_000,
  omittedRows: 200,
  statementsPerFile: 2000,
  externalNames: 8,
} as const;

export type QuizOutcome = "got_it" | "almost" | "review_again";

export type SourceRequest =
  | { protocol: "rt/1"; kind: "worktree" | "staged" }
  | { protocol: "rt/1"; kind: "commit"; revision: string }
  | { protocol: "rt/1"; kind: "range"; from: string; to: string }
  | { protocol: "rt/1"; kind: "paste"; content: string; label?: string }
  | { protocol: "rt/1"; kind: "pr"; url: string };

export interface InputSnapshot {
  id: string;
  kind: SourceRequest["kind"];
  label: string;
  digest: string;
  byteCount: number;
  content: string;
  githubUrl?: string;
  headSha?: string;
}

export interface ModelChoice {
  id: string;
  label: string;
  thinkingLevels: string[];
}

export interface LearningPreferences {
  explanationLanguage: string;
  comparisonLanguages: string[];
}

export interface Selection {
  text: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  context?: string;
}

export interface AskRequest {
  protocol: "rt/1";
  inputId: string;
  ownerPageId?: string;
  selection: Selection;
  question: string;
  modelId: string;
  thinkingLevel: string;
  preferences: LearningPreferences;
  mode: "explain" | "quiz";
}

export type QuestionState = "queued" | "running" | "answered" | "failed" | "cancelled";
export interface TypedError { code: string; message: string }
export interface QuestionView {
  id: string;
  ownerPageId?: string;
  state: QuestionState;
  answer: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  usage?: Record<string, number>;
  error?: TypedError;
}

export interface LearningEntry {
  id: string;
  inputId: string;
  source: Pick<InputSnapshot, "kind" | "label" | "digest" | "githubUrl" | "headSha">;
  selection: Selection;
  question: string;
  answer: string;
  modelId: string;
  preferences: LearningPreferences;
  note: string;
  reviewLater: boolean;
  quizOutcome?: QuizOutcome;
  createdAt: string;
  updatedAt: string;
}

export interface StructureComparison {
  kind: InputSnapshot["kind"];
  label: string;
  from: string;
  to: string;
  partial: boolean;
  reasons: string[];
}

export interface StructureFile {
  path: string;
  status: "added" | "removed" | "modified" | "renamed";
  renamedFrom?: string;
  additions: number;
  deletions: number;
  analyzed: boolean;
  reason?: string;
}

export interface StructureEvidence {
  path: string;
  line: number;
  text: string;
}

export interface StructureEdge {
  from: string;
  to: string;
  kind: "import" | "reexport" | "require" | "dynamic-import";
  typeOnly: boolean;
  status: "added" | "removed" | "modified" | "unchanged";
  specifier: string;
  evidence: StructureEvidence[];
}

export interface StructureOmission {
  path?: string;
  reason: string;
}

export interface StructureLimits {
  maxFiles: typeof STRUCTURE_LIMITS.maxFiles;
  maxEdges: typeof STRUCTURE_LIMITS.maxEdges;
  maxEvidencePerEdge: typeof STRUCTURE_LIMITS.maxEvidencePerEdge;
  truncated: boolean;
  omitted: StructureOmission[];
}

export interface StructureSnapshot {
  protocol: "rt/1";
  inputId: string;
  comparison: StructureComparison;
  files: StructureFile[];
  edges: StructureEdge[];
  limits: StructureLimits;
}

export type SseEventType = "hello" | "state" | "question" | "answer_delta" | "source" | "log_update" | "error" | "bye";
export interface SseEvent { id: number; type: SseEventType; data: unknown }

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} failed: expected an object; provide valid rt/1 JSON`);
  }
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, allowed: string[], name: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${name} failed: unknown field '${unknown}'; remove it and retry`);
}

function boundedString(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim())) {
    throw new Error(`${name} failed: expected a non-empty string; provide one and retry`);
  }
  const bytes = Buffer.byteLength(value);
  if (bytes > max) {
    throw new Error(`${name} failed: expected at most ${max} bytes, received ${bytes}; shorten it and retry`);
  }
  return value;
}

function protocol(value: unknown): asserts value is "rt/1" {
  if (value !== "rt/1") {
    throw new Error(`protocol failed: expected 'rt/1', received ${String(value)}; update the client and retry`);
  }
}

export function validateSourceRequest(value: unknown): SourceRequest {
  const request = object(value, "source request");
  protocol(request.protocol);
  const kind = request.kind;
  const kinds: unknown[] = ["worktree", "staged", "commit", "range", "paste", "pr"];
  if (!kinds.includes(kind)) {
    throw new Error(`source kind failed: expected a supported kind, received ${String(kind)}; choose a listed source`);
  }
  const fields: Record<string, string[]> = {
    worktree: ["protocol", "kind"],
    staged: ["protocol", "kind"],
    commit: ["protocol", "kind", "revision"],
    range: ["protocol", "kind", "from", "to"],
    paste: ["protocol", "kind", "content", "label"],
    pr: ["protocol", "kind", "url"],
  };
  closed(request, fields[kind as string]!, "source request");
  if (kind === "commit") boundedString(request.revision, "revision", 256);
  if (kind === "range") {
    boundedString(request.from, "range start", 256);
    boundedString(request.to, "range end", 256);
  }
  if (kind === "paste") {
    boundedString(request.content, "source content", LIMITS.source, true);
    if (request.label !== undefined) boundedString(request.label, "source label", 256);
  }
  if (kind === "pr") boundedString(request.url, "PR URL", 2048);
  return request as SourceRequest;
}

export function validateAskRequest(value: unknown): AskRequest {
  const request = object(value, "ask request");
  closed(request, ["protocol", "inputId", "ownerPageId", "selection", "question", "modelId", "thinkingLevel", "preferences", "mode"], "ask request");
  protocol(request.protocol);
  boundedString(request.inputId, "input id", 128);
  if (request.ownerPageId !== undefined) boundedString(request.ownerPageId, "owner page id", 64);
  boundedString(request.question, "question", LIMITS.question);
  boundedString(request.modelId, "model id", 256);
  boundedString(request.thinkingLevel, "thinking level", 32);
  if (request.mode !== "explain" && request.mode !== "quiz") {
    throw new Error("mode failed: expected explain or quiz; choose one and retry");
  }

  const selection = object(request.selection, "selection");
  closed(selection, ["text", "file", "startLine", "endLine", "context"], "selection");
  boundedString(selection.text, "selected code", LIMITS.selected, true);
  if (selection.context !== undefined) boundedString(selection.context, "nearby context", LIMITS.context, true);
  if (selection.file !== undefined) boundedString(selection.file, "file", 1024);
  for (const key of ["startLine", "endLine"] as const) {
    if (selection[key] !== undefined && (!Number.isInteger(selection[key]) || (selection[key] as number) < 1)) {
      throw new Error(`${key} failed: expected a positive integer; correct it and retry`);
    }
  }
  if (typeof selection.startLine === "number" && typeof selection.endLine === "number" && selection.startLine > selection.endLine) {
    throw new Error(`line range failed: expected startLine at most endLine, received ${selection.startLine} > ${selection.endLine}; correct the range and retry`);
  }

  const preferences = object(request.preferences, "preferences");
  closed(preferences, ["explanationLanguage", "comparisonLanguages"], "preferences");
  boundedString(preferences.explanationLanguage, "explanation language", LIMITS.language);
  if (!Array.isArray(preferences.comparisonLanguages)) {
    throw new Error("comparison languages failed: expected an array; provide up to three languages");
  }
  if (preferences.comparisonLanguages.length > 3) {
    throw new Error("comparison languages failed: expected at most three languages; remove extras and retry");
  }
  const seen = new Set<string>();
  preferences.comparisonLanguages.forEach((language, index) => {
    const value = boundedString(language, `comparison language ${index + 1}`, LIMITS.comparisonLanguage);
    const normalized = value.toLocaleLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`comparison languages failed: duplicate '${value}' ignoring case; remove the duplicate and retry`);
    }
    seen.add(normalized);
  });
  return request as unknown as AskRequest;
}

export function validateLogPatch(value: unknown): { note?: string; reviewLater?: boolean; quizOutcome?: QuizOutcome } {
  const patch = object(value, "log update");
  closed(patch, ["note", "reviewLater", "quizOutcome"], "log update");
  if (patch.note !== undefined) boundedString(patch.note, "note", 16 * 1024, true);
  if (patch.reviewLater !== undefined && typeof patch.reviewLater !== "boolean") {
    throw new Error("review-later failed: expected a boolean; correct it and retry");
  }
  if (patch.quizOutcome !== undefined && !["got_it", "almost", "review_again"].includes(patch.quizOutcome as string)) {
    throw new Error("quiz outcome failed: expected got_it, almost, or review_again; correct it and retry");
  }
  if (!Object.keys(patch).length) {
    throw new Error("log update failed: expected at least one field; add a change and retry");
  }
  return patch;
}
