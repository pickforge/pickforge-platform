import type { ConnectorRegistry } from "./connectors/registry.ts";
import type { LearningEntry, QuizOutcome } from "./protocol.ts";

const QUIZ_LABELS: Record<QuizOutcome, string> = {
  got_it: "Got it",
  almost: "Almost",
  review_again: "Review again",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function modelDetails(entry: LearningEntry, registry: ConnectorRegistry): { harness: string; model: string } {
  if (typeof entry.modelId !== "string") return { harness: "Pi", model: String(entry.modelId) };
  const resolved = registry.resolve(entry.modelId);
  return resolved
    ? { harness: resolved.connector.label, model: resolved.model }
    : { harness: "Pi", model: entry.modelId };
}

function card(entry: LearningEntry, registry: ConnectorRegistry): string {
  const sourceUrl = entry.source.githubUrl
    ? `<dt>GitHub source URL</dt><dd>${escapeHtml(entry.source.githubUrl)}</dd>`
    : "";
  const head = entry.source.headSha
    ? `<dt>Exact head SHA</dt><dd><code>${escapeHtml(entry.source.headSha)}</code></dd>`
    : "";
  const file = entry.selection.file
    ? `<dt>Selected file</dt><dd>${escapeHtml(entry.selection.file)}</dd>`
    : "";
  const range = entry.selection.startLine !== undefined || entry.selection.endLine !== undefined
    ? `<dt>Selected line range</dt><dd>${escapeHtml(entry.selection.startLine ?? "unknown")} to ${escapeHtml(entry.selection.endLine ?? "unknown")}</dd>`
    : "";
  const comparisons = entry.preferences.comparisonLanguages.length
    ? entry.preferences.comparisonLanguages.map(escapeHtml).join(", ")
    : "None";
  const outcome = entry.quizOutcome ? QUIZ_LABELS[entry.quizOutcome] : "Not recorded";
  const details = modelDetails(entry, registry);

  return `<article>
<h2>${escapeHtml(entry.source.label)}</h2>
<dl>
<dt>Source kind</dt><dd>${escapeHtml(entry.source.kind)}</dd>
<dt>Source label</dt><dd>${escapeHtml(entry.source.label)}</dd>
<dt>Source digest</dt><dd><code>${escapeHtml(entry.source.digest)}</code></dd>
${sourceUrl}${head}${file}${range}
<dt>Harness</dt><dd>${escapeHtml(details.harness)}</dd>
<dt>Model</dt><dd>${escapeHtml(details.model)}</dd>
<dt>Explanation language</dt><dd>${escapeHtml(entry.preferences.explanationLanguage)}</dd>
<dt>Comparison languages</dt><dd>${comparisons}</dd>
<dt>Created</dt><dd>${escapeHtml(entry.createdAt)}</dd>
<dt>Updated</dt><dd>${escapeHtml(entry.updatedAt)}</dd>
</dl>
${entry.source.kind === "pr" ? "<p>GitHub is the source of truth.</p>" : ""}
<h3>Selected code</h3><pre><code>${escapeHtml(entry.selection.text)}</code></pre>
<h3>Nearby context</h3><pre><code>${escapeHtml(entry.selection.context)}</code></pre>
<h3>Question</h3><p>${escapeHtml(entry.question)}</p>
<h3>Explanation</h3><div class="answer">${escapeHtml(entry.answer)}</div>
<h3>Note</h3><p>${escapeHtml(entry.note)}</p>
<p>Review later: ${entry.reviewLater ? "Yes" : "No"}. Quiz outcome: ${outcome}.</p>
</article>`;
}

export function exportLearningHtml(entries: LearningEntry[], registry: ConnectorRegistry): string {
  const cards = entries.length ? entries.map((entry) => card(entry, registry)).join("") : "<p>No learning entries yet.</p>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review Tutor export</title>
<style>body{font:16px system-ui;max-width:900px;margin:auto;padding:2rem;line-height:1.5}article{border-top:1px solid #999;padding:1rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:1rem}.answer{white-space:pre-wrap}dt{font-weight:bold}</style>
</head>
<body>
<h1>Review Tutor learning log</h1>
<p><strong>Private code warning:</strong> This standalone file may contain private source code. Share it carefully.</p>
${cards}
</body>
</html>`;
}
