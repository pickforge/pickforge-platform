import { pageScript } from "./page-script.js";
import { pageStyles } from "./page-styles.js";

export const pageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Review Tutor · Pickforge</title>
<style>${pageStyles}</style></head>
<body>
<header class="topbar" role="banner"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><strong class="brand">Review Tutor · Pickforge</strong><div class="source-summary"><span id="top-source">No source</span><button id="change-source" class="ghost" hidden>Change</button></div><span id="connection" role="status" aria-live="polite" class="connection">starting</span></header>
<main class="workbench">
<section id="diff-pane" class="diff-pane" role="region" aria-label="Code changes">
<div id="source-setup" class="source-setup"><span class="eyebrow">Source</span><h1>Pick a source.</h1><p>Local input. Immutable snapshot. Nothing leaves this machine.</p><div class="source-grid">
<label class="field"><span>Source</span><select id="kind"><option value="worktree">Worktree</option><option value="staged">Staged</option><option value="commit">Commit</option><option value="range">Range</option><option value="pr">GitHub PR</option><option value="paste">Pasted code</option></select></label>
<label id="revision-field" class="field source-field" hidden><span>Commit</span><input id="revision" maxlength="256" placeholder="HEAD~1"></label>
<div id="range-field" class="two source-field" hidden><label class="field"><span>From</span><input id="range-from" maxlength="256" placeholder="main"></label><label class="field"><span>To</span><input id="range-to" maxlength="256" placeholder="feature"></label></div>
<label id="pr-field" class="field source-field" hidden><span>Pull request URL</span><input id="pr-url" type="url" placeholder="https://github.com/owner/repo/pull/123"></label>
<div id="paste-field" class="source-field" hidden><label class="field"><span>Pasted code</span><textarea id="paste" maxlength="1048576"></textarea></label><label class="field"><span>Label (optional)</span><input id="paste-label" maxlength="256"></label></div>
<div class="source-actions"><button id="load" class="primary">Load source</button></div></div></div>
<div class="toolbar"><label class="sr-only" for="files">Files</label><select id="files" disabled><option>Files (0)</option></select><button id="previous-file" class="ghost" aria-label="Previous file" disabled>‹</button><button id="next-file" class="ghost" aria-label="Next file" disabled>›</button><button id="select-lines" class="ghost select-toggle" aria-pressed="false">Select lines</button><span id="totals" class="totals"><span class="add">+0</span> <span class="delete">−0</span></span></div>
<div id="diff" class="diff-scroll"><p class="empty">Load a source to begin reviewing.</p></div>
</section>
<aside class="rail" aria-label="Review tools">
<section id="tutor" class="tutor" role="region" aria-labelledby="tutor-title" tabindex="-1"><div class="dialog-head"><div><span class="eyebrow">Tutor</span><h2 id="tutor-title">Ask the tutor</h2></div><button id="close-tutor" class="ghost close-dialog">Close</button></div><p>Select code. Ask anything.</p>
<div id="selection-card" class="selection-card"><div><strong id="selection-summary" class="selection-meta">No code selected</strong> <button id="clear-selection" class="ghost" hidden>Clear</button></div><div id="selection-preview" class="selection-preview"></div></div>
<div class="two"><label class="field"><span>Model</span><select id="model"></select></label><label class="field"><span>Thinking</span><select id="thinking"></select></label></div>
<label class="field"><span>Explanation language</span><select id="language"></select></label>
<fieldset class="matches"><legend class="group-label">Closest matches</legend><p class="helper">Up to three languages you already know.</p><div class="three"><label class="field"><span>Match 1</span><select id="match-1" class="match"></select></label><label class="field"><span>Match 2</span><select id="match-2" class="match"></select></label><label class="field"><span>Match 3</span><select id="match-3" class="match"></select></label></div></fieldset>
<label class="field"><span>Question</span><textarea id="question" class="question" maxlength="4096" placeholder="What does this change do?"></textarea></label><label class="field"><span>Mode</span><select id="mode"><option value="explain">Explain</option><option value="quiz">Quiz me</option></select></label>
<div class="ask-row"><button id="ask" class="primary" aria-busy="false" disabled>Ask</button><button id="cancel" class="ghost" disabled>Cancel</button><span id="question-state" class="pill"></span></div><p id="ask-helper" class="ask-helper">Load a source and enter a question.</p><div id="lifecycle" role="status" aria-live="polite" class="sr-only"></div><div id="error" role="alert" tabindex="-1" class="error"></div><div id="answer" class="answer"><div id="answer-text" class="answer-text"></div><div id="answer-tail" class="helper"></div></div></section>
<section id="log-section" class="log-section" aria-labelledby="log-title"><div class="log-head"><h2 id="log-title" class="eyebrow">Learning log</h2><label class="sr-only" for="log-filter">Filter</label><select id="log-filter"><option value="all">All</option><option value="later">Review later</option></select><button id="refresh" class="ghost">Refresh</button><button id="export" class="ghost">Export HTML</button></div><div id="log"></div></section>
</aside></main><button id="mobile-ask" class="mobile-ask">Ask the tutor</button>
<script>${pageScript}</script></body></html>`;
