export const pageStyles = `:root {
color-scheme:dark;--surface:#0a0a0b;--surface-1:#0f0f11;--surface-2:#141417;--text:#f2f2f3;--subtle:#a4a4ab;--muted:#6e6e75;--hairline:rgba(255,255,255,.08);--hairline-strong:rgba(255,255,255,.14);--ember:#ff7a1a;--ember-soft:#ff9a4a;--green:#55c993;--rose:#e77b86;--amber:#d9a441;--font-sans:Geist,Inter,ui-sans-serif,system-ui,sans-serif;--font-mono:Geist Mono,ui-monospace,SFMono-Regular,Menlo,monospace;--radius-card:14px;--radius-control:8px;--control-h:36px;--control-h-touch:44px;--topbar-h:52px;--toolbar-h:46px;--filehead-h:40px;--field-gap:14px;--rail-pad:20px;font:14px/1.5 var(--font-sans)}
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
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible {
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
height:calc(100vh - var(--topbar-h));display:grid;grid-template-columns:minmax(640px,1fr) 400px}
.diff-pane {
min-width:0;min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--hairline)}
.source-setup {
margin:20px;border:1px solid var(--hairline-strong);border-radius:var(--radius-card);background:var(--surface-1);padding:20px}
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
height:var(--toolbar-h);flex:none;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--hairline);background:var(--surface-1)}
.toolbar select {
width:auto;max-width:280px}
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
padding:56px 24px;color:var(--muted)}
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
min-width:max-content}
.diff-row {
display:grid;grid-template-columns:52px 52px 24px minmax(500px,1fr);min-height:25px;align-items:stretch;font:12.5px/25px var(--font-mono);position:relative}
.diff-row.meta {
display:block;padding:3px 14px;min-height:0;color:var(--muted);background:transparent;font:10.5px/1.5 var(--font-mono);white-space:pre-wrap}
.diff-row.hunk {
display:block;padding:2px 14px;min-height:0;color:#aaaab2;background:rgba(255,255,255,.03);font-size:11px;line-height:1.6}
.diff-row.addition {
background:rgba(60,190,125,.07);box-shadow:inset 2px 0 var(--green)}
.diff-row.deletion {
background:rgba(220,80,95,.07);box-shadow:inset 2px 0 var(--rose)}
.diff-row[aria-pressed="true"] {
background:rgba(255,122,26,.11);box-shadow:inset 2px 0 var(--ember)}
.file.plain .diff-row {
grid-template-columns:52px 24px minmax(500px,1fr)}
.file.plain .line-no:nth-child(2) {
display:none}
.line-no {
color:#85858e;text-align:right;padding-right:12px;border-right:1px solid var(--hairline);user-select:none;font-variant-numeric:tabular-nums}
.marker {
text-align:center;color:var(--subtle)}
.code {
white-space:pre;padding:0 14px}
.rail {
min-height:0;overflow-y:auto;background:var(--surface-1)}
.tutor {
padding:var(--rail-pad) var(--rail-pad) 22px;border-bottom:1px solid var(--hairline)}
.dialog-head {
display:flex;align-items:flex-start;justify-content:space-between}
.dialog-head h2 {
font-size:18px;font-weight:700;letter-spacing:-.02em;margin:4px 0 0}
.close-dialog {
display:none}
.lede {
color:var(--subtle);font-size:13px;margin:6px 0 16px}
.selection-card {
padding:12px 0;border-top:1px solid var(--hairline);border-bottom:1px solid var(--hairline);margin-bottom:16px}
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
.tutor>.field,.tutor>.two {
margin-bottom:var(--field-gap)}
.ask-row {
display:flex;align-items:center;gap:8px}
.ask-row .primary {
flex:1}
.ask-helper {
min-height:18px;color:var(--subtle);font-size:12px;margin:8px 0 0}
.pill {
font:10px var(--font-mono);text-transform:uppercase;letter-spacing:.12em;color:var(--subtle)}
.pulse {
display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ember);margin-right:7px;animation:pulse 1.2s ease-in-out infinite}
.spinner {
display:inline-block;width:12px;height:12px;border:2px solid rgba(0,0,0,.3);border-top-color:#160a02;border-radius:50%;margin-right:7px;vertical-align:-2px;animation:spin .7s linear infinite}
.answer {
margin-top:16px;padding-top:12px;border-top:1px solid var(--hairline)}
.answer-label {
display:block;font:600 10px var(--font-mono);letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.answer-text {
font:12.5px/1.65 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.answer.streaming .answer-text:after {
content:"";display:inline-block;width:7px;height:1em;background:var(--ember);vertical-align:-2px;margin-left:2px;animation:blink .8s steps(1) infinite}
.error {
color:#ff9ca5;min-height:0;white-space:pre-wrap}
.log-section {
padding:var(--rail-pad) var(--rail-pad) 100px}
.log-head {
display:flex;align-items:center;gap:8px}
.log-head h2 {
margin:0 auto 0 0;white-space:nowrap}
.log-entry {
border-left:1px solid var(--hairline-strong);padding:12px 0 14px 14px;margin-top:14px}
.log-entry h3 {
font-size:14px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}
.metadata {
font:11px var(--font-mono);color:var(--muted)}
.log-answer {
white-space:pre-wrap;line-height:1.55;margin:10px 0;color:#d2d2d6}
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
@keyframes pulse {
50% {
opacity:.35}
}
@keyframes blink {
50% {
opacity:0}
}

@media(max-width:1040px) {
body {
overflow:auto}
.topbar {
padding:0 12px;gap:8px}
.brand {
font-size:9px;white-space:nowrap}
.source-summary {
flex:1;min-width:0;margin-left:0;padding-left:12px;font-size:11px}
.source-summary span {
max-width:22vw}
@media(max-width:520px) {
.source-summary span {
display:none}
}
.workbench {
height:auto;display:block}
.diff-pane {
border:0}
.source-setup {
margin:12px;padding:16px}
.source-grid,.two,.three {
grid-template-columns:1fr}
.toolbar {
position:sticky;top:var(--topbar-h);z-index:10;height:auto;padding:3px 8px;gap:4px;overflow:hidden}
.toolbar button,.toolbar select {
min-height:var(--control-h-touch);height:auto}
.toolbar select {
min-width:0;max-width:none;flex:1}
.toolbar button {
width:44px;padding:0;flex:none}
.toolbar .totals {
margin-left:4px;white-space:nowrap}
.select-toggle {
display:block;width:auto!important;padding:0 8px!important}
.diff-scroll {
overflow:visible}
.file-head {
top:102px;min-height:var(--control-h-touch);height:var(--control-h-touch)}
.diff-row {
grid-template-columns:44px 44px 20px minmax(500px,1fr);min-height:30px;line-height:30px}
.rail {
overflow:visible}
.tutor {
display:none}
.tutor.open {
display:block;position:fixed;inset:0;z-index:50;overflow:auto;background:var(--surface-1);padding:18px;animation:slide .18s ease-out}
.close-dialog {
display:block;min-height:var(--control-h-touch)}
.log-section {
border-top:1px solid var(--hairline)}
.mobile-ask {
display:block;position:fixed;z-index:30;left:12px;right:12px;bottom:12px;min-height:48px;box-shadow:0 4px 18px #000;background:var(--ember);color:#160a02;border-color:var(--ember);font-weight:700}
.mobile-ask:disabled {
opacity:1}
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
