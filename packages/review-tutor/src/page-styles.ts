export const pageStyles = `:root {
color-scheme:dark;--canvas:#0a0a0b;--panel:#0f0f11;--raised:#141417;--text:#f2f2f3;--subtle:#a4a4ab;--muted:#777780;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--ember:#ff7a1a;--green:#55c993;--rose:#e77b86;--amber:#d9a441;font:14px Geist,Inter,ui-sans-serif,system-ui,sans-serif}
* {
box-sizing:border-box}
[hidden] {
display:none!important}
html,body {
height:100%;margin:0;background:var(--canvas);color:var(--text)}
body {
overflow:hidden;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:24px 24px}
button,input,select,textarea {
font:inherit;color:inherit}
button,select,input,textarea {
border:1px solid var(--line2);background:var(--raised);border-radius:8px}
button {
min-height:36px;padding:0 12px;cursor:pointer}
button:hover:not(:disabled) {
border-color:rgba(255,255,255,.28)}
button:disabled {
cursor:not-allowed;opacity:.48}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible {
outline:2px solid rgba(255,122,26,.6);outline-offset:2px}
input,select,textarea {
width:100%;padding:9px 10px}
textarea {
resize:vertical}
.topbar {
height:48px;display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid var(--line);background:rgba(10,10,11,.96);position:sticky;top:0;z-index:20}
.dots {
display:flex;gap:6px}
.dots i {
width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.15)}
.brand,.eyebrow {
font:600 10px Geist Mono,ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase}
.source-summary {
min-width:0;display:flex;align-items:center;gap:8px;color:var(--subtle);margin-left:12px}
.source-summary span {
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.connection {
margin-left:auto;color:var(--subtle);font-size:12px}
.connection:before {
content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:7px}
.ghost {
background:transparent}
.workbench {
height:calc(100vh - 48px);display:grid;grid-template-columns:minmax(640px,1fr) 400px}
.diff-pane {
min-width:0;min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--line)}
.source-setup {
margin:20px;border:1px solid var(--line2);border-radius:14px;background:var(--panel);padding:20px}
.source-setup[hidden] {
display:none}
.source-setup h1 {
font-size:24px;margin:5px 0 4px}
.source-setup p {
color:var(--subtle);margin:0 0 18px}
.source-grid {
display:grid;grid-template-columns:1fr 1fr;gap:12px}
.field {
display:block}
.field>span,.group-label {
display:block;color:var(--subtle);font-size:12px;margin:0 0 6px}
.source-field {
grid-column:1/-1}
.source-field textarea {
min-height:150px;font-family:Geist Mono,ui-monospace,monospace}
.source-actions {
grid-column:1/-1;display:flex;justify-content:flex-end}
.primary {
border-color:var(--ember);background:var(--ember);color:#160a02;font-weight:700}
.primary.busy-neutral {
border-color:var(--line2);background:var(--raised);color:var(--text)}
.toolbar {
height:50px;flex:none;display:flex;align-items:center;gap:8px;padding:7px 14px;border-bottom:1px solid var(--line);background:var(--panel)}
.toolbar select {
width:auto;max-width:260px}
.toolbar .totals {
margin-left:auto;font:12px Geist Mono,ui-monospace,monospace}
.add {
color:var(--green)}
.delete {
color:var(--rose)}
.select-toggle {
display:none}
.diff-scroll {
overflow:auto;min-height:0;scroll-behavior:smooth}
.empty {
padding:48px 24px;color:var(--subtle)}
.file {
border-bottom:1px solid var(--line)}
.file-head {
position:sticky;top:0;z-index:3;background:#101012;display:flex;align-items:center;gap:12px;padding:0 14px;height:42px}
.file-head button {
border:0;background:transparent;padding:0;width:32px}
.file-path {
font:12.5px Geist Mono,ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-counts {
margin-left:auto;font:12px Geist Mono,ui-monospace,monospace}
.rows {
min-width:max-content}
.diff-row {
display:grid;grid-template-columns:52px 52px 24px minmax(500px,1fr);min-height:25px;align-items:stretch;font:12.5px/25px Geist Mono,ui-monospace,monospace;position:relative}
.diff-row.meta {
display:block;padding:5px 14px;min-height:25px;color:#92929b;background:rgba(255,255,255,.018);font:11px/1.4 Geist Mono,ui-monospace,monospace;white-space:pre-wrap}
.diff-row.hunk {
display:block;padding:0 14px;color:#aaaab2;background:rgba(255,255,255,.03);font-size:11px}
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
color:#85858e;text-align:right;padding-right:12px;border-right:1px solid var(--line);user-select:none}
.marker {
text-align:center;color:var(--subtle)}
.code {
white-space:pre;padding:0 14px}
.rail {
min-height:0;overflow-y:auto;background:var(--panel)}
.tutor {
padding:18px 18px 22px;border-bottom:1px solid var(--line)}
.dialog-head {
display:flex;align-items:center;justify-content:space-between}
.dialog-head h2 {
font-size:18px;margin:5px 0 14px}
.close-dialog {
display:none}
.selection-card {
padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:14px}
.selection-meta {
font:12px Geist Mono,ui-monospace,monospace}
.selection-preview {
color:var(--subtle);font:11px/1.5 Geist Mono,ui-monospace,monospace;white-space:pre-wrap;margin:7px 0}
.two {
display:grid;grid-template-columns:1fr 1fr;gap:10px}
.matches {
border:0;padding:0;margin:12px 0}
.matches legend {
padding:0}
.helper {
font-size:12px;color:var(--subtle);margin:4px 0 8px}
.three {
display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
.question {
min-height:82px}
.ask-row {
display:flex;align-items:center;gap:8px;margin-top:10px}
.ask-row .primary {
flex:1}
.ask-helper {
min-height:18px;color:var(--subtle);font-size:12px;margin:7px 0}
.pill {
font:10px Geist Mono,ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em;color:var(--subtle)}
.pulse {
display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ember);margin-right:7px;animation:pulse 1.2s ease-in-out infinite}
.spinner {
display:inline-block;width:12px;height:12px;border:2px solid rgba(0,0,0,.3);border-top-color:#160a02;border-radius:50%;margin-right:7px;vertical-align:-2px;animation:spin .7s linear infinite}
.answer {
min-height:90px;margin-top:15px;padding-top:14px;border-top:1px solid var(--line)}
.answer-text {
font:13px/1.65 Geist Mono,ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.answer.streaming .answer-text:after {
content:"";display:inline-block;width:7px;height:1em;background:var(--ember);vertical-align:-2px;margin-left:2px;animation:blink .8s steps(1) infinite}
.error {
color:#ff9ca5;min-height:0;white-space:pre-wrap}
.log-section {
padding:20px 18px 100px}
.log-head {
display:flex;align-items:center;gap:7px}
.log-head h2 {
margin:0 auto 0 0}
.log-entry {
border-left:1px solid var(--line2);padding:12px 0 14px 14px;margin-top:12px}
.log-entry h3 {
font-size:14px;margin:0 0 6px}
.metadata {
font:11px Geist Mono,ui-monospace,monospace;color:#9b9ba3}
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
display:flex;min-width:0;margin-left:0;font-size:11px}
.source-summary span {
max-width:22vw}
@media(max-width:520px) {
.source-summary span {
display:none}
}
.source-summary .ghost {
min-height:44px}
.workbench {
height:auto;display:block}
.diff-pane {
border:0}
.source-setup {
margin:12px;padding:16px}
.source-grid,.two,.three {
grid-template-columns:1fr}
.toolbar {
position:sticky;top:48px;z-index:10;padding:3px 8px;gap:4px;overflow:hidden}
.toolbar button,.toolbar select {
min-height:44px}
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
top:98px;min-height:44px;height:44px}
.diff-row {
grid-template-columns:44px 44px 20px minmax(500px,1fr);min-height:30px;line-height:30px}
.rail {
overflow:visible}
.tutor {
display:none}
.tutor.open {
display:block;position:fixed;inset:0;z-index:50;overflow:auto;background:var(--panel);padding:18px;animation:slide .18s ease-out}
.close-dialog {
display:block;min-height:44px}
.log-section {
border-top:1px solid var(--line)}
.mobile-ask {
display:block;position:fixed;z-index:30;left:12px;right:12px;bottom:12px;min-height:48px;box-shadow:0 4px 18px #000;background:var(--ember);color:#160a02;border-color:var(--ember);font-weight:700}
.mobile-ask:disabled {
opacity:1}
.source-actions .primary {
min-height:44px}
.field select,.field input,.field textarea {
min-height:44px}
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
