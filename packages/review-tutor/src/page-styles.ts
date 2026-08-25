export const pageStyles = `:root {
color-scheme:dark;--surface:#0a0a0b;--surface-1:#0f0f11;--surface-2:#141417;--text:#f2f2f3;--subtle:#a4a4ab;--muted:#8b8b93;--hairline:rgba(255,255,255,.08);--hairline-strong:rgba(255,255,255,.14);--ember:#ff7a1a;--ember-soft:#ff9a4a;--green:#55c993;--rose:#e77b86;--amber:#d9a441;--font-sans:Geist,Inter,ui-sans-serif,system-ui,sans-serif;--font-mono:Geist Mono,ui-monospace,SFMono-Regular,Menlo,monospace;--radius-card:14px;--radius-control:8px;--control-h:36px;--control-h-touch:44px;--topbar-h:52px;--toolbar-h:46px;--filehead-h:40px;--filehead-top:calc(var(--topbar-h) + 50px);--field-gap:14px;--rail-pad:20px;font:14px/1.5 var(--font-sans)}
* {
box-sizing:border-box}
[hidden] {
display:none!important}
html,body {
height:100%;margin:0;background:var(--surface);color:var(--text)}
body {
overflow:hidden;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:24px 24px}
button,input,select,textarea {
font:inherit;color:inherit}
button,select,input,textarea {
border:1px solid var(--hairline-strong);background:var(--surface-2);border-radius:var(--radius-control)}
button {
min-height:var(--control-h);padding:0 14px;cursor:pointer;font-size:13px;font-weight:500;white-space:nowrap}
button:hover:not(:disabled) {
border-color:rgba(255,255,255,.28)}
button:disabled {
cursor:not-allowed;opacity:.48}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible {
outline:2px solid rgba(255,122,26,.6);outline-offset:2px}
input,select {
width:100%;height:var(--control-h);padding:0 10px}
textarea {
width:100%;padding:9px 10px;resize:vertical}
.topbar {
height:var(--topbar-h);display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid var(--hairline);background:rgba(10,10,11,.96);position:sticky;top:0;z-index:20}
.mark {
flex:none;display:block}
.brand {
font:600 11px var(--font-mono);letter-spacing:.18em;text-transform:uppercase;white-space:nowrap}
.brand .sep {
color:var(--muted)}
.eyebrow {
font:600 10px var(--font-mono);letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.source-setup .eyebrow {
color:var(--ember)}
.source-summary {
flex:1;min-width:0;display:flex;align-items:center;gap:8px;margin-left:4px;padding-left:14px;border-left:1px solid var(--hairline);color:var(--subtle);font:12px var(--font-mono)}
.source-summary span {
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.connection {
margin-left:auto;flex:none;display:flex;align-items:center;gap:8px;color:var(--subtle);font:500 11px var(--font-mono);letter-spacing:.08em;text-transform:uppercase}
.connection:before {
content:"";width:12px;height:12px;flex:none;background:linear-gradient(currentColor,currentColor) 0 0/7px 1.5px,linear-gradient(currentColor,currentColor) 0 0/1.5px 7px,linear-gradient(currentColor,currentColor) 100% 0/7px 1.5px,linear-gradient(currentColor,currentColor) 100% 0/1.5px 7px,linear-gradient(currentColor,currentColor) 0 100%/7px 1.5px,linear-gradient(currentColor,currentColor) 0 100%/1.5px 7px,linear-gradient(currentColor,currentColor) 100% 100%/7px 1.5px,linear-gradient(currentColor,currentColor) 100% 100%/1.5px 7px,radial-gradient(circle,currentColor 0 2px,transparent 2.6px) center/100% 100%;background-repeat:no-repeat}
.connection[data-state="connected"] {
color:var(--green)}
.connection[data-state="reconnecting"],.connection[data-state="failed"] {
color:var(--rose)}
.ghost {
background:transparent}
.workbench {
height:calc(100vh - var(--topbar-h));display:grid;grid-template-columns:minmax(0,1fr) clamp(320px,30vw,400px);transition:grid-template-columns 200ms ease}
.workbench.rail-collapsed {
grid-template-columns:minmax(0,1fr) 44px}
.diff-pane {
min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--hairline)}
.source-setup {
min-height:0;max-height:100%;overflow:auto;flex:0 1 auto;margin:20px;border:1px solid var(--hairline-strong);border-radius:var(--radius-card);background:var(--surface-1);padding:20px}
.source-setup[hidden] {
display:none}
.source-setup h1 {
font-size:22px;font-weight:700;letter-spacing:-.02em;margin:6px 0 4px}
.source-setup p {
color:var(--subtle);margin:0 0 18px}
.source-grid {
display:grid;grid-template-columns:1fr 1fr;gap:12px}
.field {
display:block}
.field>span,.group-label {
display:block;color:var(--muted);font:500 10px var(--font-mono);letter-spacing:.14em;text-transform:uppercase;margin:0 0 6px}
.source-field {
grid-column:1/-1}
.source-field textarea {
min-height:150px;font-family:var(--font-mono)}
.source-actions {
grid-column:1/-1;display:flex;justify-content:flex-end}
.primary {
border-color:var(--ember);background:var(--ember);color:#160a02;font-weight:700}
.primary:hover:not(:disabled) {
border-color:var(--ember-soft);background:var(--ember-soft)}
.primary.busy-neutral {
border-color:var(--hairline-strong);background:var(--surface-2);color:var(--text)}
.toolbar {
min-height:var(--toolbar-h);height:auto;flex:none;display:flex;align-items:center;gap:8px;row-gap:4px;padding:4px 14px;border-bottom:1px solid var(--hairline);background:var(--surface-1);flex-wrap:wrap}
.toolbar select {
width:auto;flex:1 1 120px;min-width:120px;max-width:280px}
.view-switch {
display:flex;align-items:center;flex:none;padding:2px;border:1px solid var(--hairline);border-radius:var(--radius-control);background:var(--surface)}
.view-switch .view-tab {
min-height:28px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:var(--subtle);font:600 11px var(--font-mono)}
.view-switch .view-tab[aria-selected="true"] {
background:var(--surface-2);color:var(--text);box-shadow:0 0 0 1px var(--hairline-strong)}
.toolbar .ghost {
border-color:transparent}
.toolbar .totals {
margin-left:auto;font:12px var(--font-mono);font-variant-numeric:tabular-nums}
.add {
color:var(--green)}
.delete {
color:var(--rose)}
.select-toggle {
display:none}
.diff-scroll {
overflow:auto;min-height:0;scroll-behavior:smooth}
.empty {
display:block;margin:0;padding:56px 24px;color:var(--muted)}
.diff-preamble {
margin:14px 14px 4px;padding:10px 12px;border:1px solid var(--hairline);border-radius:var(--radius-card);background:var(--surface-1);color:var(--muted);font:11px/1.6 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.file {
border-bottom:1px solid var(--hairline)}
.file-head {
position:sticky;top:0;z-index:3;background:var(--surface-1);border-bottom:1px solid var(--hairline);display:flex;align-items:center;gap:10px;padding:0 14px;height:var(--filehead-h)}
.file-head button {
border:0;background:transparent;padding:0;width:28px;min-height:0;color:var(--muted);font-size:13px}
.file-head button:hover:not(:disabled) {
color:var(--text);border-color:transparent}
.file-path {
font:12px var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-counts {
margin-left:auto;flex:none;font:12px var(--font-mono);font-variant-numeric:tabular-nums}
.rows {
min-width:0}
.diff-row {
content-visibility:auto;contain-intrinsic-block-size:auto 25px;display:grid;grid-template-columns:52px 52px 24px minmax(0,1fr);min-height:25px;align-items:stretch;font:12.5px/25px var(--font-mono);position:relative}
.diff-row.meta {
display:block;padding:3px 14px;min-height:0;color:var(--muted);background:transparent;font:10.5px/1.5 var(--font-mono);white-space:pre-wrap}
.diff-row.hunk {
display:block;padding:2px 14px;min-height:0;color:#aaaab2;background:rgba(255,255,255,.03);font-size:11px;line-height:1.6}
.diff-row.addition {
background:rgba(60,190,125,.07);box-shadow:inset 2px 0 var(--green)}
.diff-row.deletion {
background:rgba(220,80,95,.07);box-shadow:inset 2px 0 var(--rose)}
.diff-row.selected {
background:rgba(255,122,26,.11);box-shadow:inset 2px 0 var(--ember)}
.diff-row.structure-landing {
box-shadow:inset 2px 0 var(--ember)}
.file.plain .diff-row {
grid-template-columns:52px 24px minmax(0,1fr)}
.file.plain .line-no:nth-child(2) {
display:none}
.line-no {
display:flex;align-items:flex-start;justify-content:flex-end;position:relative;color:#85858e;text-align:right;padding-right:12px;border-right:1px solid var(--hairline);user-select:none;cursor:pointer;font-variant-numeric:tabular-nums}
button.line-select {
display:flex;align-items:flex-start;justify-content:flex-end;min-height:25px;padding:0 12px 0 0;border:0;border-right:1px solid var(--hairline);border-radius:0;background:transparent;font:inherit;line-height:25px}
.diff-row[data-row]:hover:after {
content:"";position:absolute;inset:0;background:rgba(255,255,255,.035);pointer-events:none}
.line-action {
position:absolute;left:4px;top:4px;z-index:1;width:16px;height:16px;line-height:15px;text-align:center;border:1px solid var(--hairline-strong);border-radius:4px;background:var(--surface-2);color:var(--text);font:12px var(--font-mono);opacity:0;pointer-events:auto;cursor:pointer}
.diff-row[data-row]:hover .line-action,.line-select:focus-visible .line-action {
opacity:1}
.tutored-badge {
position:absolute;right:6px;top:3px;z-index:2;min-width:20px;min-height:20px;height:20px;padding:0 5px;border:1px solid var(--hairline-strong);border-radius:10px;background:var(--surface-2);color:var(--subtle);font:600 10px/18px var(--font-mono)}
.tutored-badge::before {
content:"";position:absolute;inset:-2px}
.tutored-badge:hover,.tutored-badge:focus-visible,.tutored-badge[aria-expanded=true] {
background:var(--ember);border-color:var(--ember);color:#0c0c0e}
.diff-row.has-tutored .code {
padding-right:42px}
.marker {
text-align:center;color:var(--subtle);user-select:none;cursor:pointer}
.diff-row[data-row]:hover .line-no {
color:var(--text)}
.code {
white-space:pre-wrap;overflow-wrap:anywhere;padding:0 14px}
.rail {
position:relative;min-height:0;overflow:hidden auto;background:var(--surface-1)}
.tutor {
display:none;margin:8px 14px 16px;max-width:760px;border:1px solid var(--hairline-strong);border-radius:var(--radius-card);background:var(--surface-1);padding:16px 18px}
.tutor.open {
display:block}
.diff-pane>.tutor.open {
min-height:0;max-height:100%;overflow:auto;flex:0 1 auto}
.rail-head {
display:flex;align-items:center;gap:8px;padding:14px 44px 0 var(--rail-pad)}
.rail-toggle {
position:absolute;top:14px;right:8px;width:28px;min-height:28px;padding:0;border:0;background:transparent;color:var(--muted);font-size:14px}
.rail-toggle:hover {
color:var(--text)}
.rail-collapsed .rail-head {
justify-content:center;padding:50px 0 0}
.rail-collapsed .rail-eyebrow {
writing-mode:vertical-rl}
.config-section {
width:clamp(320px,30vw,400px);padding:14px var(--rail-pad) 28px}
.config-section .field,.config-section .two {
margin-bottom:var(--field-gap)}
.config-actions {
margin-top:20px;padding-top:16px;border-top:1px solid var(--hairline)}
.open-config {
display:none}
.dialog-head {
display:flex;align-items:flex-start;justify-content:space-between}
.dialog-head h2 {
font-size:18px;font-weight:700;letter-spacing:-.02em;margin:4px 0 0}
.close-dialog {
display:block}
.lede {
color:var(--subtle);font-size:13px;margin:6px 0 16px}
.selection-card {
padding:12px 0;border-top:1px solid var(--hairline);border-bottom:1px solid var(--hairline);margin-bottom:16px}
.selection-head {
display:flex;align-items:center;gap:10px}
.selection-head .selection-meta {
flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.selection-head #clear-selection {
flex:none;min-height:28px;padding:0 10px;border-color:transparent;font-size:12px}
.selection-meta {
font:12px var(--font-mono)}
.selection-preview {
color:var(--subtle);font:11px/1.6 var(--font-mono);white-space:pre-wrap;margin:8px 0 0;overflow-wrap:anywhere}
.two {
display:grid;grid-template-columns:1fr 1fr;gap:10px}
.matches {
border:0;padding:0;margin:0 0 var(--field-gap)}
.matches legend {
padding:0}
.helper {
font-size:12px;color:var(--subtle);margin:4px 0 8px}
.three {
display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
.question {
min-height:82px}
.tutor .field,.tutor .two {
margin-bottom:var(--field-gap)}
.ask-row {
display:flex;align-items:center;gap:8px}
.ask-row .primary {
flex:1}
.ask-helper {
color:var(--subtle);font-size:12px;margin:8px 0 0}
.ask-helper:empty {
display:none;margin:0}
.spinner {
display:inline-block;width:12px;height:12px;border:2px solid rgba(0,0,0,.3);border-top-color:#160a02;border-radius:50%;margin-right:7px;vertical-align:-2px;animation:spin .7s linear infinite}
.busy-dot {
display:inline-block;width:6px;height:6px;margin-right:8px;border-radius:50%;background:var(--ember);animation:blink 1.2s ease-in-out infinite}
.answer {
margin-top:12px;padding-top:10px;border-top:1px solid var(--hairline)}
.answer-head {
display:flex;align-items:center;gap:8px;margin-bottom:8px}
.answer-label {
display:block;font:600 10px var(--font-mono);letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.history-pager {
display:flex;align-items:center;gap:5px;margin-left:auto;color:var(--muted);font:10px var(--font-mono)}
.history-pager button {
width:28px;min-height:28px;padding:0;border-color:transparent}
.answer-text {
font:13px/1.65 var(--font-sans);overflow-wrap:anywhere}
.answer-text>:first-child,.log-answer>:first-child {
margin-top:0}
.answer-text>:last-child,.log-answer>:last-child {
margin-bottom:0}
.answer-text p,.log-answer p {
margin:0 0 10px}
.answer-text h1,.answer-text h2,.answer-text h3,.answer-text h4,.answer-text h5,.answer-text h6,.log-answer h1,.log-answer h2,.log-answer h3,.log-answer h4,.log-answer h5,.log-answer h6 {
margin:16px 0 7px;color:var(--text);font-family:var(--font-sans);font-weight:650;line-height:1.3;letter-spacing:-.015em}
.answer-text h1,.log-answer h1 {
font-size:17px}
.answer-text h2,.log-answer h2 {
font-size:15px}
.answer-text h3,.log-answer h3 {
font-size:14px}
.answer-text h4,.answer-text h5,.answer-text h6,.log-answer h4,.log-answer h5,.log-answer h6 {
font-size:13px}
.answer-text code,.log-answer code {
padding:1px 4px;border:1px solid var(--hairline);border-radius:4px;background:var(--surface-2);font:12px/1.55 var(--font-mono);color:#e4e4e7}
.answer-text pre,.log-answer pre {
max-width:100%;margin:10px 0 12px;padding:10px 12px;overflow:auto;border:1px solid var(--hairline);border-radius:var(--radius-control);background:var(--surface);white-space:pre}
.answer-text pre code,.log-answer pre code {
padding:0;border:0;border-radius:0;background:transparent;font-size:11.5px;color:var(--text)}
.answer-text ul,.answer-text ol,.log-answer ul,.log-answer ol {
margin:7px 0 11px;padding-left:22px}
.answer-text li,.log-answer li {
margin:3px 0}
.answer-text blockquote,.log-answer blockquote {
margin:10px 0;padding:2px 0 2px 12px;border-left:2px solid var(--hairline-strong);color:var(--subtle)}
.answer-text hr,.log-answer hr {
height:1px;margin:14px 0;border:0;background:var(--hairline)}
.answer-text a,.log-answer a {
color:var(--ember-soft);text-decoration-color:rgba(255,154,74,.45);text-underline-offset:2px}
.answer-text a:hover,.log-answer a:hover {
text-decoration-color:currentColor}
.answer.streaming .answer-text:after {
content:"";display:inline-block;width:7px;height:1em;background:var(--ember);vertical-align:-2px;margin-left:2px;animation:blink .8s steps(1) infinite}
.error {
position:fixed;top:calc(var(--topbar-h) + 10px);left:50%;translate:-50% 0;z-index:60;max-width:min(560px,calc(100vw - 24px));padding:10px 14px;border:1px solid rgba(231,123,134,.4);border-radius:var(--radius-control);background:var(--surface-2);color:#ff9ca5;white-space:pre-wrap;box-shadow:0 6px 24px rgba(0,0,0,.5)}
.error:empty {
display:none}
.structure-section {
contain:layout;min-width:0;padding:14px 14px 100px;overflow-x:hidden}
.structure-head {
display:flex;align-items:center;gap:12px;margin:0;flex-wrap:wrap}
.structure-head:has(> :not([hidden])) {
margin-bottom:10px}
.structure-mode-switch {
width:max-content;margin:0}
.structure-neighbours {
display:flex;align-items:center;gap:7px;color:var(--subtle);font-size:12px;cursor:pointer}
.structure-neighbours input {
width:auto;height:auto;margin:0;accent-color:var(--ember)}
#structure-graph {
max-width:100%;overflow-x:auto;overflow-y:hidden}
.structure-graph-svg {
display:block;max-width:none}
.structure-graph-node,.structure-graph-edge {
cursor:pointer}
.structure-graph-node rect {
fill:var(--surface-1);stroke:var(--hairline);stroke-width:1}
.structure-graph-node text {
fill:currentColor;font:12px var(--font-mono)}
.structure-graph-node.status-added,.structure-graph-edge.status-added,.structure-graph-marker.status-added {
color:var(--green)}
.structure-graph-node.status-removed,.structure-graph-edge.status-removed,.structure-graph-marker.status-removed {
color:var(--rose)}
.structure-graph-node.status-modified,.structure-graph-edge.status-modified,.structure-graph-marker.status-modified {
color:var(--amber)}
.structure-graph-node.status-unchanged,.structure-graph-node.status-renamed,.structure-graph-node.status-context,.structure-graph-edge.status-unchanged,.structure-graph-marker.status-unchanged {
color:var(--muted)}
.structure-graph-marker.status-selected {
color:var(--ember)}
.structure-graph-edge .structure-graph-line {
stroke:currentColor;stroke-width:1;vector-effect:non-scaling-stroke}
.structure-graph-edge.status-removed .structure-graph-line {
stroke-dasharray:4 3}
.structure-graph-edge.type-only {
opacity:.7}
.structure-graph-marker path {
fill:currentColor}
.structure-graph-node.graph-selected rect,.structure-graph-edge.graph-selected .structure-graph-line {
stroke:var(--ember);stroke-width:2}
.structure-graph-evidence {
margin-top:12px;border-top:1px solid var(--hairline)}
.structure-comparison {
margin:0 0 10px;color:var(--subtle);font:12px var(--font-mono)}
.structure-partial {
margin:0 0 14px;padding:10px 12px;border:1px solid var(--amber);border-radius:var(--radius-card);background:var(--surface-1);color:var(--subtle)}
.structure-partial p {
margin:0}
.structure-partial details {
margin-top:6px}
.structure-partial summary {
width:max-content;max-width:100%;color:var(--amber);cursor:pointer;font:600 11px var(--font-mono)}
.structure-partial ul {
margin:7px 0 0;padding-left:20px;overflow-wrap:anywhere}
.structure-error-card {
display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--rose);border-radius:var(--radius-card);background:var(--surface-1)}
.structure-error-card p {
flex:1;min-width:0;margin:0;color:var(--rose);overflow-wrap:anywhere}
.structure-zero {
display:block;padding:24px 0;color:var(--muted)}
.structure-file {
min-width:0;border:1px solid var(--hairline);border-radius:var(--radius-card);overflow:clip;background:var(--surface-1)}
.structure-file + .structure-file {
margin-top:10px}
.structure-file-head {
position:static;min-width:0}
.structure-file-path {
min-width:0;margin:0;font:12px var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status-chip,.connection-kind,.connection-type,.connection-context {
flex:none;color:var(--muted);font:600 10px var(--font-mono);letter-spacing:.1em;text-transform:uppercase}
.status-added {
color:var(--green)}
.status-removed {
color:var(--rose)}
.status-modified {
color:var(--amber)}
.status-context {
color:var(--muted)}
.structure-file-note {
display:block;padding:6px 14px;border-bottom:1px solid var(--hairline);color:var(--muted);font:11px var(--font-mono);overflow-wrap:anywhere}
.connection-list {
min-width:0}
.connection-row {
width:100%;min-width:0;min-height:32px;display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:9px;padding:3px 12px;border:0;border-radius:0;background:transparent;text-align:left;white-space:normal}
.connection-target-wrap {
min-width:0;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.connection-row:hover:not(:disabled) {
background:var(--surface-2)}
.connection-row.selected {
position:relative;z-index:1;outline:1px solid var(--ember);outline-offset:-1px;background:var(--surface-2)}
.connection-target {
min-width:0;color:var(--text);font:12px var(--font-mono);overflow-wrap:anywhere}
.connection-evidence {
margin:0;padding:0;list-style:none;border-top:1px solid var(--hairline);background:var(--surface)}
.connection-evidence li {
min-width:0;display:flex;align-items:center;gap:12px;padding:7px 12px 7px 22px;border-left:2px solid var(--hairline-strong)}
.connection-evidence li + li {
border-top:1px solid var(--hairline)}
.evidence-code {
flex:1;min-width:0;color:var(--subtle);font:12px/1.5 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.open-in-diff,.ask-tutor-evidence {
flex:none}
.log-section {
contain:layout;padding:20px 14px 100px;border-top:1px solid var(--hairline);scroll-margin-top:8px}
.log-head {
display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.log-head h2 {
margin:0 auto 0 0;white-space:nowrap}
.log-entry {
border-left:1px solid var(--hairline-strong);padding:12px 0 14px 14px;margin-top:14px}
.log-entry + .log-entry {
border-top:1px solid var(--hairline-strong);margin-top:20px;padding-top:20px}
.log-entry h3 {
font-size:14px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}
.metadata {
font:11px var(--font-mono);color:var(--muted)}
.log-answer {
line-height:1.6;margin:10px 0;color:#d2d2d6;overflow-wrap:anywhere}
.log-entry textarea {
min-height:66px}
.entry-actions {
display:flex;align-items:center;gap:6px;margin-top:7px;flex-wrap:wrap}
.quiz-outcome[aria-pressed="true"] {
color:#7ee2ad;border-color:var(--green);background:rgba(85,201,147,.1)}
.review[aria-pressed="true"] {
color:#f2c766;border-color:var(--amber)}
.saved {
font-size:11px;color:var(--subtle)}
.mobile-ask {
display:none}
.sr-only {
position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@keyframes spin {
to {
transform:rotate(360deg)}
}
@keyframes blink {
50% {
opacity:0}
}

@media(max-width:860px) {
:root {
--filehead-top:calc(var(--topbar-h) + 105px)}
body {
height:auto;min-height:100%;overflow:auto}
body.modal-open {
overflow:hidden}
.topbar {
padding:0 12px;gap:8px}
.brand {
font-size:9px;white-space:nowrap}
.source-summary {
flex:1;min-width:0;margin-left:0;padding-left:12px;font-size:11px}
.source-summary span {
max-width:22vw}
.workbench {
height:auto;display:block}
.diff-pane {
border:0}
.source-setup {
margin:12px;padding:16px}
.source-grid,.two,.three {
grid-template-columns:1fr}
.toolbar {
position:sticky;top:var(--topbar-h);z-index:10;height:auto;padding:3px 8px;gap:4px;flex-wrap:wrap}
.toolbar button,.toolbar select {
min-height:var(--control-h-touch);height:auto}
.toolbar select {
min-width:0;max-width:none;flex:1}
.toolbar button {
width:44px;padding:0;flex:none}
.view-switch {
flex:1 1 100%;width:100%}
.view-switch .view-tab {
width:auto;flex:1;min-height:var(--control-h-touch)}
.toolbar .totals {
margin-left:4px;white-space:nowrap}
.select-toggle,.source-change {
display:block;width:auto!important;padding:0 8px!important}
@media(max-width:520px) {
:root {
--filehead-top:calc(var(--topbar-h) + 153px)}
.connection {
font-size:0;gap:0}
.source-summary {
display:none}
.toolbar {
column-gap:2px}
.toolbar select {
flex:1 1 100%}
.toolbar .totals {
margin-left:0}
.structure-file-path {
overflow:visible;text-overflow:clip;white-space:normal;overflow-wrap:anywhere}
.connection-row {
grid-template-columns:auto auto auto minmax(0,1fr);grid-template-areas:"kind type status ." "target target target target";gap:2px 8px;padding-top:5px;padding-bottom:5px}
.connection-kind {
grid-area:kind}
.connection-target-wrap {
grid-area:target}
.connection-type {
grid-area:type}
.connection-status {
grid-area:status}
.connection-evidence li {
align-items:stretch;flex-direction:column;padding-left:12px}
.open-in-diff,.ask-tutor-evidence {
width:100%;min-height:var(--control-h-touch)}
}
.diff-scroll {
overflow:visible}
.structure-section {
padding-left:8px;padding-right:8px}
.structure-neighbours {
min-height:var(--control-h-touch)}
.connection-row {
min-height:var(--control-h-touch)}
.file-head {
top:var(--filehead-top);min-height:var(--control-h-touch);height:var(--control-h-touch)}
.diff-row {
grid-template-columns:44px 44px 20px minmax(0,1fr);min-height:30px;line-height:30px}
.open-config {
display:block;flex:none;min-height:36px;padding:0 10px;border-color:transparent}
.ask-open {
display:none}
.rail {
display:none}
.rail.config-open {
display:block;position:fixed;inset:0;z-index:50;overflow-x:hidden;overflow-y:scroll;background:var(--surface-1);padding:18px;animation:slide .18s ease-out}
.rail-head {
display:flex;padding:0;flex-direction:row}
.rail-toggle {
position:static;width:auto;min-height:44px;padding:0 14px}
.config-section {
width:auto;padding:16px 0 28px}
.config-actions button {
min-height:44px}
.tutor.open {
display:block;position:fixed;inset:0;z-index:50;overflow-x:hidden;overflow-y:scroll;background:var(--surface-1);padding:18px;margin:0;max-width:none;border:0;border-radius:0;animation:slide .18s ease-out}
.close-dialog {
display:block;min-height:var(--control-h-touch)}
.log-section {
scroll-margin-top:var(--filehead-top)}
.line-action {
top:6px}
.mobile-ask {
display:block;position:fixed;z-index:30;left:12px;right:12px;bottom:12px;min-height:48px;box-shadow:0 4px 18px #000;background:var(--ember);color:#160a02;border-color:var(--ember);font-weight:700}
.mobile-ask:disabled {
opacity:1}
.structure-error-card button,.structure-partial summary,.open-in-diff,.ask-tutor-evidence {
min-height:var(--control-h-touch)}
.structure-partial summary {
padding:8px 4px}
.source-actions .primary {
min-height:var(--control-h-touch)}
.field select,.field input,.field textarea {
min-height:var(--control-h-touch)}
@keyframes slide {
from {
transform:translateY(16px);opacity:.5}
}
}

@media(prefers-reduced-motion:reduce) {
*,*:before,*:after {
animation:none!important;transition:none!important;scroll-behavior:auto!important}
}
`;
