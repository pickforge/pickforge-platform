export const pageScript = String.raw`
(function () {
  const HUMAN_LANGUAGES = [
    "English",
    "Português (Brasil)",
    "Español",
    "Français",
    "Deutsch",
    "Italiano",
    "日本語",
    "한국어",
    "简体中文",
    "हिन्दी",
  ];
  const PROGRAMMING_LANGUAGES = [
    "TypeScript",
    "JavaScript",
    "Python",
    "Dart",
    "Go",
    "Rust",
    "Java",
    "Kotlin",
    "Swift",
    "C#",
    "C++",
    "C",
    "Ruby",
    "PHP",
    "SQL",
    "Shell",
  ];
  const element = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const incoming = params.get("session");
  if (incoming) {
    sessionStorage.setItem("reviewTutorSession", incoming);
    history.replaceState({}, "", location.pathname);
  }
  const token = sessionStorage.getItem("reviewTutorSession");
  let state,
    currentSource,
    currentQuestionId,
    currentQuestionState,
    files = [],
    preambleText = "",
    selection = null,
    selectionAnchor = null,
    activeRow = null,
    loading = false,
    asking = false,
    touchSelection = false,
    lastTutorOpener = null,
    logEntries = [],
    pendingQuiz = null,
    answerMarkdown = "",
    activeView = "diff",
    composerSelectionKey = null,
    historyEntries = [],
    historyIndex = 0,
    activeHistoryBadge = null;
  const learningBadgeGroups = new Map();
  let railCollapsed = sessionStorage.getItem("reviewTutorRailCollapsed") === "1";
  let restoreComposerOnDesktop = false;
  const QUIZ_IDS_KEY = "reviewTutorQuizEntryIds";
  const MAX_QUIZ_IDS = 100;
  const MAX_SELECTED_BYTES = 16 * 1024;
  const MAX_CONTEXT_BYTES = 32 * 1024;
  const MOBILE_BREAKPOINT = 860;
  const encoder = new TextEncoder();
  function readQuizEntryIds() {
    try {
      const value = JSON.parse(sessionStorage.getItem(QUIZ_IDS_KEY) || "[]");
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length > 256))
        throw new Error("Invalid stored quiz entry IDs");
      return value.slice(-MAX_QUIZ_IDS);
    } catch {
      sessionStorage.removeItem(QUIZ_IDS_KEY);
      return [];
    }
  }
  const quizEntryIds = new Set(readQuizEntryIds());
  const noteDrafts = new Map();
  let deferredLogEntries = null;
  let logRevision = 0;
  let logRefreshSequence = 0;
  const pendingAskEvents = [];
  const matchSelects = [
    element("match-1"),
    element("match-2"),
    element("match-3"),
  ];
  function showError(error, action, focus = false) {
    const message = error instanceof Error ? error.message : String(error);
    element("error").textContent = action + " failed: " + message;
    if (focus) element("error").focus();
  }
  function clearError() {
    element("error").textContent = "";
  }
  function announce(text) {
    element("lifecycle").textContent = text;
  }
  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        message = (await response.json()).error || message;
      } catch {}
      throw new Error(message);
    }
    return response.headers.get("content-type")?.includes("json")
      ? response.json()
      : response.text();
  }
  function option(value, label = value) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = label;
    return node;
  }
  function fill(select, values, none = false) {
    select.replaceChildren();
    if (none) select.append(option("", "None"));
    for (const value of values) select.append(option(value));
  }
  function appendInline(parent, text, depth = 0) {
    let buffer = "";
    const flush = () => {
      if (buffer) parent.append(document.createTextNode(buffer));
      buffer = "";
    };
    for (let index = 0; index < text.length;) {
      if (text[index] === "\\" && index + 1 < text.length) {
        buffer += text[index + 1];
        index += 2;
        continue;
      }
      if (text.charCodeAt(index) === 96) {
        let length = 1;
        while (text.charCodeAt(index + length) === 96) length++;
        const delimiter = String.fromCharCode(96).repeat(length);
        const close = text.indexOf(delimiter, index + length);
        if (close >= 0) {
          flush();
          const code = document.createElement("code");
          code.textContent = text.slice(index + length, close);
          parent.append(code);
          index = close + length;
          continue;
        }
      }
      const strongMarker = text.slice(index, index + 2);
      if (depth < 8 && (strongMarker === "**" || strongMarker === "__")) {
        const close = text.indexOf(strongMarker, index + 2);
        if (close > index + 2) {
          flush();
          const strong = document.createElement("strong");
          appendInline(strong, text.slice(index + 2, close), depth + 1);
          parent.append(strong);
          index = close + 2;
          continue;
        }
      }
      if (depth < 8 && text[index] === "[") {
        const separator = text.indexOf("](", index + 1);
        const close = separator < 0 ? -1 : text.indexOf(")", separator + 2);
        if (separator > index + 1 && close > separator + 2) {
          const href = text.slice(separator + 2, close).trim();
          let safe = false;
          try {
            const url = new URL(href);
            safe = url.protocol === "http:" || url.protocol === "https:";
          } catch {}
          if (safe) {
            flush();
            const link = document.createElement("a");
            link.href = href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            appendInline(link, text.slice(index + 1, separator), depth + 1);
            parent.append(link);
            index = close + 1;
            continue;
          }
        }
      }
      const marker = text[index];
      if (
        depth < 8 && (marker === "*" || marker === "_") &&
        text[index + 1] && !/\s/.test(text[index + 1]) &&
        (marker !== "_" || index === 0 || !/[\w]/.test(text[index - 1]))
      ) {
        const close = text.indexOf(marker, index + 1);
        if (close > index + 1 && !/\s/.test(text[close - 1])) {
          flush();
          const emphasis = document.createElement("em");
          appendInline(emphasis, text.slice(index + 1, close), depth + 1);
          parent.append(emphasis);
          index = close + 1;
          continue;
        }
      }
      buffer += text[index];
      index++;
    }
    flush();
  }
  function fenceAt(line) {
    const indent = line.length - line.trimStart().length;
    if (indent > 3) return null;
    const trimmed = line.trimStart();
    const character = trimmed[0];
    if (!character || (character.charCodeAt(0) !== 96 && character !== "~")) return null;
    let length = 0;
    while (trimmed[length] === character) length++;
    return length >= 3
      ? { character, length, info: trimmed.slice(length).trim() }
      : null;
  }
  function listItem(line) {
    const unordered = line.match(/^ {0,3}[-+*][ \t]+(.+)$/);
    if (unordered) return { ordered: false, content: unordered[1] };
    const ordered = line.match(/^ {0,3}\d+[.)][ \t]+(.+)$/);
    return ordered ? { ordered: true, content: ordered[1] } : null;
  }
  function startsMarkdownBlock(line) {
    return Boolean(
      !line.trim() || fenceAt(line) || /^ {0,3}#{1,6}[ \t]+/.test(line) ||
      /^ {0,3}>[ \t]?/.test(line) || listItem(line) ||
      /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(line),
    );
  }
  function renderMarkdown(container, markdown, depth = 0) {
    container.replaceChildren();
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      if (!line.trim()) {
        index++;
        continue;
      }
      const fence = fenceAt(line);
      if (fence) {
        const content = [];
        index++;
        while (index < lines.length) {
          const closing = fenceAt(lines[index]);
          if (closing && closing.character === fence.character && closing.length >= fence.length && !closing.info) {
            index++;
            break;
          }
          content.push(lines[index]);
          index++;
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = content.join("\n");
        const language = fence.info.split(/\s+/)[0];
        if (/^[\w#+.-]+$/.test(language || "")) code.dataset.language = language;
        pre.append(code);
        container.append(pre);
        continue;
      }
      const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
      if (heading) {
        const node = document.createElement("h" + heading[1].length);
        appendInline(node, heading[2]);
        container.append(node);
        index++;
        continue;
      }
      if (/^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(line)) {
        container.append(document.createElement("hr"));
        index++;
        continue;
      }
      if (depth < 8 && /^ {0,3}>[ \t]?/.test(line)) {
        const quoted = [];
        while (index < lines.length && /^ {0,3}>[ \t]?/.test(lines[index])) {
          quoted.push(lines[index].replace(/^ {0,3}>[ \t]?/, ""));
          index++;
        }
        const blockquote = document.createElement("blockquote");
        renderMarkdown(blockquote, quoted.join("\n"), depth + 1);
        container.append(blockquote);
        continue;
      }
      const firstItem = listItem(line);
      if (firstItem) {
        const list = document.createElement(firstItem.ordered ? "ol" : "ul");
        while (index < lines.length) {
          const item = listItem(lines[index]);
          if (!item || item.ordered !== firstItem.ordered) break;
          const node = document.createElement("li");
          appendInline(node, item.content);
          list.append(node);
          index++;
        }
        container.append(list);
        continue;
      }
      const paragraphLines = [line];
      index++;
      while (index < lines.length && !startsMarkdownBlock(lines[index])) {
        paragraphLines.push(lines[index]);
        index++;
      }
      const paragraph = document.createElement("p");
      paragraphLines.forEach((part, partIndex) => {
        const hardBreak = / {2,}$/.test(part);
        appendInline(paragraph, hardBreak ? part.replace(/ {2,}$/, "") : part);
        if (partIndex < paragraphLines.length - 1)
          paragraph.append(hardBreak ? document.createElement("br") : document.createTextNode(" "));
      });
      container.append(paragraph);
    }
  }
  function updateAnswerVisibility() {
    element("answer").hidden = !answerMarkdown.trim() && !element("answer-tail").textContent.trim();
  }
  function setAnswer(markdown) {
    answerMarkdown = typeof markdown === "string" ? markdown : "";
    renderMarkdown(element("answer-text"), answerMarkdown);
    updateAnswerVisibility();
  }
  function appendAnswer(markdown) {
    answerMarkdown += markdown;
    renderMarkdown(element("answer-text"), answerMarkdown);
    updateAnswerVisibility();
  }
  function setAnswerTail(text) {
    element("answer-tail").textContent = text;
    updateAnswerVisibility();
  }
  const diffControls = ["files", "previous-file", "next-file", "select-lines", "open-composer", "totals"];
  function setView(view, focusPanel = false) {
    activeView = view === "log" ? "log" : "diff";
    if (activeView === "log") hideInlineComposer();
    element("diff").hidden = activeView !== "diff";
    element("log-section").hidden = activeView !== "log";
    for (const id of diffControls) element(id).hidden = activeView !== "diff";
    element("mobile-ask").hidden = activeView !== "diff";
    for (const name of ["diff", "log"]) {
      const tab = element("view-" + name);
      const selected = name === activeView;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    announce(activeView === "log" ? "Learning log view." : "Diff view.");
    if (focusPanel) (activeView === "log" ? element("log-title") : element("view-diff")).focus();
  }
  function handleViewKey(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) return;
    const tabs = [element("view-diff"), element("view-log")];
    const current = tabs.indexOf(event.currentTarget);
    if (["Enter", " "].includes(event.key)) {
      setView(event.currentTarget.id === "view-log" ? "log" : "diff");
    } else {
      const target = event.key === "Home"
        ? tabs[0]
        : event.key === "End"
          ? tabs.at(-1)
          : event.key === "ArrowLeft"
            ? tabs[Math.max(0, current - 1)]
            : tabs[Math.min(tabs.length - 1, current + 1)];
      target.focus();
    }
    event.preventDefault();
  }
  function updateSourceFields() {
    for (const id of [
      "revision-field",
      "range-field",
      "pr-field",
      "paste-field",
    ])
      element(id).hidden = true;
    const map = {
      commit: "revision-field",
      range: "range-field",
      pr: "pr-field",
      paste: "paste-field",
    };
    if (map[element("kind").value])
      element(map[element("kind").value]).hidden = false;
  }
  function parseUnifiedDiff(content, label) {
    const lines = content.split("\n");
    const unified = lines.some((line) => line.startsWith("diff --git ")) &&
      lines.some((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line));
    if (!unified) return {
      preamble: "",
      files: [{
        path: label,
        kind: "plain",
        lines: lines.map((text, index) => ({ kind: "context", text, old: index + 1, new: null, selectLine: index + 1, block: 0 })),
        additions: 0,
        deletions: 0,
      }],
    };
    const result = [];
    const preamble = [];
    let file = null, oldLine = 0, newLine = 0, inHunk = false, block = -1, started = false;
    function ensure() {
      if (!file) {
        file = { path: label, kind: "diff", lines: [], additions: 0, deletions: 0 };
        result.push(file);
      }
      return file;
    }
    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        started = true;
        const body = line.slice(11).replaceAll('"', "");
        const marker = body.indexOf(" b/");
        const headerPath = (marker >= 0 ? body.slice(marker + 3) : body.split(" ")[1] || body.split(" ")[0] || "").replace(/^b\//, "");
        file = { path: headerPath || label, kind: "diff", lines: [], additions: 0, deletions: 0 };
        result.push(file);
        inHunk = false;
        continue;
      }
      if (!started) {
        preamble.push(line);
        continue;
      }
      if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
        if (line.startsWith("+++ ")) {
          const path = line.slice(4).replace(/^b\//, "");
          if (path !== "/dev/null") ensure().path = path;
        }
        continue;
      }
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (!match) { ensure().lines.push({ kind: "meta", text: line }); inHunk = false; continue; }
        oldLine = Number(match[1]); newLine = Number(match[2]); inHunk = true; block++;
        ensure().lines.push({ kind: "hunk", text: line, block });
        continue;
      }
      const target = ensure();
      if (!inHunk) { target.lines.push({ kind: "meta", text: line }); continue; }
      if (line.startsWith("+")) {
        target.lines.push({ kind: "addition", text: line.slice(1), old: null, new: newLine++, selectLine: newLine - 1, block });
        target.additions++;
      } else if (line.startsWith("-")) {
        target.lines.push({ kind: "deletion", text: line.slice(1), old: oldLine++, new: null, selectLine: oldLine - 1, block });
        target.deletions++;
      } else if (line.startsWith(" ")) {
        target.lines.push({ kind: "context", text: line.slice(1), old: oldLine++, new: newLine++, selectLine: newLine - 1, block });
      } else target.lines.push({ kind: "meta", text: line, block });
    }
    return { preamble: preamble.join("\n").trim(), files: result };
  }
  function makeSpan(className, text) {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    return node;
  }
  function rowSelectable(rowData) {
    return (
      !!rowData &&
      (rowData.kind === "addition" ||
      rowData.kind === "deletion" ||
      rowData.kind === "context")
    );
  }
  function rowNode(position) {
    return position && document.querySelector('[data-file="' + position.fileIndex + '"][data-row="' + position.rowIndex + '"]');
  }
  function rowControl(position) {
    return rowNode(position)?.querySelector(".line-select") || null;
  }
  function chooseRow(fileIndex, rowIndex, extend, confirm) {
    const file = files[fileIndex], row = file.lines[rowIndex];
    if (!rowSelectable(row)) return;
    clearError();
    const previousAnchor = selectionAnchor;
    if (!extend || !selectionAnchor || selectionAnchor.fileIndex !== fileIndex || file.lines[selectionAnchor.rowIndex].block !== row.block)
      selectionAnchor = { fileIndex, rowIndex };
    const start = Math.min(selectionAnchor.rowIndex, rowIndex), end = Math.max(selectionAnchor.rowIndex, rowIndex);
    const chosen = file.lines.slice(start, end + 1).filter(rowSelectable);
    const text = chosen.map((item) => item.text).join("\n");
    const context = file.lines.slice(Math.max(0, start - 3), Math.min(file.lines.length, end + 4)).filter(rowSelectable).map((item) => item.text).join("\n");
    if (encoder.encode(text).byteLength > MAX_SELECTED_BYTES || encoder.encode(context).byteLength > MAX_CONTEXT_BYTES) {
      selectionAnchor = previousAnchor;
      element("error").textContent = "Selection is too large: select at most 16 KiB of code and 32 KiB of context.";
      announce("Selection not changed because it is too large.");
      return;
    }
    const commonNew = chosen.every((item) => item.new != null);
    const commonOld = chosen.every((item) => item.old != null);
    const side = commonNew ? "new" : commonOld ? "old" : null;
    const next = { file: file.path, text, context, fileIndex, start, end, count: chosen.length };
    if (side) {
      next.startLine = Math.min(...chosen.map((item) => item[side]));
      next.endLine = Math.max(...chosen.map((item) => item[side]));
    }
    const previousSelection = selection, previousActive = activeRow;
    selection = next;
    activeRow = { fileIndex, rowIndex };
    updateSelection(previousSelection, previousActive);
    if (confirm) {
      const origin = rowControl(activeRow);
      touchSelection = false;
      selectionAnchor = null;
      element("select-lines").setAttribute("aria-pressed", "false");
      openTutor(origin);
      element("question").focus();
    }
  }
  function updateSelection(previousSelection = selection, previousActive = activeRow) {
    const changed = new Set();
    for (const range of [previousSelection, selection]) if (range)
      for (let index = range.start; index <= range.end; index++) changed.add(range.fileIndex + ":" + index);
    for (const key of changed) {
      const [fileIndex, rowIndex] = key.split(":").map(Number), node = rowNode({ fileIndex, rowIndex });
      if (!node) continue;
      const selected = !!selection && fileIndex === selection.fileIndex && rowIndex >= selection.start && rowIndex <= selection.end;
      node.classList.toggle("selected", selected);
      rowControl({ fileIndex, rowIndex })?.setAttribute("aria-pressed", String(selected));
    }
    const oldActiveControl = rowControl(previousActive), activeControl = rowControl(activeRow);
    if (oldActiveControl && oldActiveControl !== activeControl) oldActiveControl.tabIndex = -1;
    if (activeControl) activeControl.tabIndex = 0;
    if (!activeRow) {
      const first = document.querySelector('.diff-row[data-row]');
      if (first) {
        activeRow = { fileIndex: Number(first.dataset.file), rowIndex: Number(first.dataset.row) };
        rowControl(activeRow).tabIndex = 0;
      }
    }
    if (!selection) {
      element("selection-summary").textContent = "No code selected";
      element("selection-preview").textContent = "";
      element("clear-selection").hidden = true;
    } else {
      element("selection-summary").textContent = selection.startLine == null
        ? selection.file + " · " + selection.count + " selected lines"
        : selection.file + " · lines " + selection.startLine + "-" + selection.endLine;
      const lines = selection.text.split("\n");
      element("selection-preview").textContent = lines.slice(0, 6).join("\n") + (lines.length > 6 ? "\n…" + (lines.length - 6) + " more" : "");
      element("clear-selection").hidden = false;
    }
    element("selection-helper").hidden = !selection;
    updateActions();
  }
  function anchorComposer(forceDock = false) {
    const tutor = element("tutor");
    const endRow = selection && rowNode({ fileIndex: selection.fileIndex, rowIndex: selection.end });
    const inline = !forceDock && tutor.classList.contains("open") && endRow && innerWidth > MOBILE_BREAKPOINT && !endRow.closest(".rows")?.hidden;
    const active = tutor.contains(document.activeElement) ? document.activeElement : null;
    const caret = active?.tagName === "TEXTAREA" ? [active.selectionStart, active.selectionEnd] : null;
    let moved = false;
    if (inline) {
      if (tutor.previousElementSibling !== endRow) { endRow.after(tutor); moved = true; }
    } else if (tutor.parentElement !== element("diff-pane") || tutor.nextElementSibling !== element("diff-scroll")) {
      element("diff-scroll").before(tutor);
      moved = true;
    }
    if (moved && active) {
      active.focus({ preventScroll: true });
      if (caret) active.setSelectionRange(caret[0], caret[1]);
    }
    return moved;
  }
  function reanchorOpenComposer() {
    const tutor = element("tutor"), moved = anchorComposer();
    if (moved && tutor.classList.contains("open") && innerWidth > MOBILE_BREAKPOINT)
      tutor.scrollIntoView({ block: "nearest" });
    return moved;
  }
  function hideInlineComposer() {
    const tutor = element("tutor");
    if (tutor.getAttribute("role") === "dialog" || !tutor.classList.contains("open")) return;
    restoreComposerOnDesktop = false;
    tutor.classList.remove("open");
    if (activeHistoryBadge) activeHistoryBadge.setAttribute("aria-expanded", "false");
    anchorComposer();
  }
  function selectionContains(fileIndex, rowIndex) {
    return !!selection && selection.fileIndex === fileIndex && rowIndex >= selection.start && rowIndex <= selection.end;
  }
  function selectionIdentity(value = selection) {
    if (!value) return (currentSource?.digest || "none") + ":all";
    return [currentSource?.digest || "none", value.file, value.startLine ?? value.start, value.endLine ?? value.end, value.text].join(":");
  }
  function clearHistoryState() {
    historyEntries = [];
    historyIndex = 0;
    element("history-pager").hidden = true;
    if (activeHistoryBadge) activeHistoryBadge.setAttribute("aria-expanded", "false");
    activeHistoryBadge = null;
  }
  function resetComposer() {
    if (["queued", "running"].includes(currentQuestionState)) return;
    currentQuestionId = undefined;
    currentQuestionState = undefined;
    element("question").value = "";
    element("question-state").textContent = "";
    element("answer").classList.remove("streaming");
    setAnswerTail("");
    setAnswer("");
    setAskLabel("Ask");
    clearHistoryState();
    updateActions();
  }
  function prepareFreshComposer() {
    const next = selectionIdentity();
    if (composerSelectionKey !== next && !["queued", "running"].includes(currentQuestionState)) resetComposer();
    composerSelectionKey = next;
  }
  function rangeForEntry(entry) {
    if (!currentSource || entry.source?.digest !== currentSource.digest || !entry.selection?.file ||
        !Number.isInteger(entry.selection.startLine) || !Number.isInteger(entry.selection.endLine)) return null;
    const fileIndex = files.findIndex((file) => file.path === entry.selection.file);
    if (fileIndex < 0) return null;
    const file = files[fileIndex];
    const expectedText = entry.selection.text || "";
    for (let start = 0; start < file.lines.length; start++) {
      const first = file.lines[start];
      if (!rowSelectable(first) || first.selectLine !== entry.selection.startLine) continue;
      const chosen = [];
      let candidateText = "";
      for (let end = start; end < file.lines.length && file.lines[end].block === first.block; end++) {
        if (!rowSelectable(file.lines[end])) continue;
        chosen.push(file.lines[end]);
        candidateText = candidateText ? candidateText + "\n" + file.lines[end].text : file.lines[end].text;
        if (candidateText.length > expectedText.length) break;
        if (candidateText !== expectedText) continue;
        const commonNew = chosen.every((item) => item.new != null);
        const commonOld = chosen.every((item) => item.old != null);
        const side = commonNew ? "new" : commonOld ? "old" : null;
        if (!side) continue;
        const startLine = Math.min(...chosen.map((item) => item[side]));
        const endLine = Math.max(...chosen.map((item) => item[side]));
        if (startLine === entry.selection.startLine && endLine === entry.selection.endLine)
          return { fileIndex, start, end };
      }
    }
    return null;
  }
  function restoreEntryRange(entry) {
    const range = rangeForEntry(entry);
    if (!range) return false;
    selectionAnchor = { fileIndex: range.fileIndex, rowIndex: range.start };
    chooseRow(range.fileIndex, range.end, true, false);
    selectionAnchor = null;
    return true;
  }
  function renderHistoryEntry(index) {
    const item = historyEntries[index];
    if (!item || !restoreEntryRange(item.entry)) return;
    historyIndex = index;
    currentQuestionId = undefined;
    currentQuestionState = "answered";
    composerSelectionKey = selectionIdentity();
    element("question").value = item.entry.question;
    element("question-state").textContent = "answered";
    setAnswer(item.entry.answer);
    setAnswerTail("Saved answer · " + new Date(item.entry.createdAt).toLocaleString());
    const pager = element("history-pager");
    pager.hidden = historyEntries.length < 2;
    element("history-position").textContent = (index + 1) + " of " + historyEntries.length;
    element("history-previous").disabled = index === 0;
    element("history-next").disabled = index === historyEntries.length - 1;
    setAskLabel("Ask");
    updateActions();
    reanchorOpenComposer();
  }
  function openHistory(groupKey, badge) {
    if (["queued", "running"].includes(currentQuestionState)) {
      showError(new Error("cancel or wait for the current answer before opening a saved answer"), "Saved answer");
      return;
    }
    const group = learningBadgeGroups.get(groupKey);
    if (!group?.length) return;
    clearHistoryState();
    historyEntries = [...group].sort((left, right) => new Date(right.entry.createdAt) - new Date(left.entry.createdAt));
    activeHistoryBadge = badge;
    badge.setAttribute("aria-expanded", "true");
    setView("diff");
    renderHistoryEntry(0);
    openTutor(badge, true);
    element("question").focus();
    announce("Saved answer restored.");
  }
  function updateLearningBadges() {
    const existing = new Map([...document.querySelectorAll(".tutored-badge")]
      .map((badge) => [badge.dataset.historyKey, badge]));
    const nextGroups = new Map();
    for (const entry of logEntries) {
      const range = rangeForEntry(entry);
      if (!range) continue;
      const key = range.fileIndex + ":" + range.start;
      const group = nextGroups.get(key) || [];
      group.push({ entry, range });
      nextGroups.set(key, group);
    }
    for (const [key, badge] of existing) {
      if (!nextGroups.has(key)) badge.remove();
    }
    document.querySelectorAll(".diff-row.has-tutored").forEach((row) => row.classList.remove("has-tutored"));
    learningBadgeGroups.clear();
    for (const [key, group] of nextGroups) {
      learningBadgeGroups.set(key, group);
      const row = rowNode({ fileIndex: group[0].range.fileIndex, rowIndex: group[0].range.start });
      if (!row) continue;
      const count = group.length;
      const first = group[0].entry.selection;
      let badge = existing.get(key);
      if (!badge || !badge.isConnected) {
        badge = document.createElement("button");
        badge.className = "tutored-badge";
        badge.type = "button";
        badge.dataset.historyKey = key;
        badge.setAttribute("aria-expanded", "false");
        row.append(badge);
      }
      badge.textContent = count === 1 ? "¶" : String(count);
      badge.setAttribute("aria-label", count + " saved " + (count === 1 ? "answer" : "answers") + ", lines " + first.startLine + "–" + first.endLine);
      row.classList.add("has-tutored");
    }
  }
  function handleRowKey(event, fileIndex, rowIndex) {
    let target = rowIndex;
    switch (event.key) {
      case "ArrowUp":
        target = Math.max(0, rowIndex - 1);
        break;
      case "ArrowDown":
        target = Math.min(files[fileIndex].lines.length - 1, rowIndex + 1);
        break;
      case " ":
        hideInlineComposer();
        selectionAnchor = { fileIndex, rowIndex };
        chooseRow(fileIndex, rowIndex, false, false);
        event.preventDefault();
        return;
      case "Enter": {
        if (!selectionContains(fileIndex, rowIndex)) chooseRow(fileIndex, rowIndex, false, false);
        const origin = rowControl({ fileIndex, rowIndex });
        openTutor(origin);
        element("question").focus();
        event.preventDefault();
        return;
      }
      default:
        return;
    }
    const direction = target < rowIndex ? -1 : 1;
    while (
      target >= 0 &&
      target < files[fileIndex].lines.length &&
      !rowSelectable(files[fileIndex].lines[target])
    ) {
      target += direction;
    }
    if (target < 0 || target >= files[fileIndex].lines.length) return;
    hideInlineComposer();
    chooseRow(fileIndex, target, event.shiftKey, false);
    event.preventDefault();
    const next = rowControl({ fileIndex, rowIndex: target });
    if (next) next.focus();
  }
  function renderDiff() {
    anchorComposer(true);
    const container = element("diff");
    container.replaceChildren();
    if (preambleText) {
      const preambleNode = document.createElement("div");
      preambleNode.className = "diff-preamble";
      preambleNode.textContent = preambleText;
      container.append(preambleNode);
    }
    const fileSelect = element("files");
    fileSelect.replaceChildren();
    let additions = 0,
      deletions = 0;
    files.forEach((file, fileIndex) => {
      additions += file.additions;
      deletions += file.deletions;
      fileSelect.append(
        option(
          String(fileIndex),
          "Files (" + files.length + ") · " + file.path,
        ),
      );
      const article = document.createElement("article");
      article.className = "file " + file.kind;
      article.id = "file-" + fileIndex;
      const head = document.createElement("div");
      head.className = "file-head";
      const disclosure = document.createElement("button");
      disclosure.textContent = "▾";
      disclosure.setAttribute("aria-label", "Collapse " + file.path);
      disclosure.setAttribute("aria-expanded", "true");
      const path = makeSpan("file-path", file.path);
      const counts = document.createElement("span");
      counts.className = "file-counts";
      counts.append(
        makeSpan("add", "+" + file.additions),
        document.createTextNode(" "),
        makeSpan("delete", "−" + file.deletions),
      );
      head.append(disclosure, path, counts);
      const rows = document.createElement("div");
      rows.className = "rows";
      rows.setAttribute("role", "group");
      rows.setAttribute("aria-label", file.path + " selectable lines");
      file.lines.forEach((data, rowIndex) => {
        const row = document.createElement("div");
        row.className = "diff-row " + data.kind;
        if (data.kind === "hunk" || data.kind === "meta") {
          row.textContent = data.text;
          rows.append(row);
          return;
        }
        row.dataset.file = String(fileIndex);
        row.dataset.row = String(rowIndex);
        const firstLineNumber = document.createElement("button");
        firstLineNumber.type = "button";
        firstLineNumber.className = "line-no line-select";
        firstLineNumber.textContent = data.old == null ? "" : String(data.old);
        firstLineNumber.setAttribute("aria-pressed", "false");
        firstLineNumber.setAttribute("aria-label", file.path + " line " + data.selectLine);
        firstLineNumber.tabIndex = activeRow
          ? -1
          : fileIndex === 0 && rowIndex === file.lines.findIndex(rowSelectable)
            ? 0
            : -1;
        const lineAction = makeSpan("line-action", "+");
        lineAction.setAttribute("aria-hidden", "true");
        firstLineNumber.prepend(lineAction);
        row.append(firstLineNumber);
        if (file.kind !== "plain") row.append(makeSpan("line-no", data.new == null ? "" : String(data.new)));
        row.append(
          makeSpan(
            "marker",
            data.kind === "addition"
              ? "+"
              : data.kind === "deletion"
                ? "−"
                : " ",
          ),
          makeSpan("code", data.text),
        );
        rows.append(row);
      });
      rows.addEventListener("pointerdown", (event) => {
        const row = event.target.closest(".diff-row[data-row]");
        if (!row || !rows.contains(row)) return;
        const touch = event.pointerType === "touch";
        if (event.target.closest(".tutored-badge")) return;
        if (touch && !touchSelection) return;
        if (!touch && event.target.closest(".line-action")) return;
        if (!touch && !event.target.closest(".line-no,.marker")) return;
        if (!touch) hideInlineComposer();
        const fileIndex = Number(row.dataset.file), rowIndex = Number(row.dataset.row);
        if (touchSelection && selectionAnchor) chooseRow(fileIndex, rowIndex, true, true);
        else {
          chooseRow(fileIndex, rowIndex, event.shiftKey, false);
          if (!touch) rowControl({ fileIndex, rowIndex })?.focus({ preventScroll: true });
        }
      });
      rows.addEventListener("click", (event) => {
        const badge = event.target.closest(".tutored-badge");
        if (badge) {
          event.stopPropagation();
          openHistory(badge.dataset.historyKey, badge);
          return;
        }
        const action = event.target.closest(".line-action");
        if (!action || event.pointerType === "touch") return;
        const row = action.closest(".diff-row[data-row]");
        if (!row || !rows.contains(row)) return;
        const fileIndex = Number(row.dataset.file), rowIndex = Number(row.dataset.row);
        if (!selectionContains(fileIndex, rowIndex)) chooseRow(fileIndex, rowIndex, false, false);
        openTutor(rowControl({ fileIndex, rowIndex }));
        element("question").focus();
      });
      rows.addEventListener("mousedown", (event) => {
        if (event.target.closest(".line-no,.marker") && !event.target.closest(".tutored-badge")) event.preventDefault();
      });
      rows.addEventListener("keydown", (event) => {
        if (event.target.closest(".tutored-badge")) return;
        const control = event.target.closest(".line-select");
        const row = control?.closest(".diff-row[data-row]");
        if (row && rows.contains(row)) handleRowKey(event, Number(row.dataset.file), Number(row.dataset.row));
      });
      disclosure.addEventListener("click", () => {
        const expanded = disclosure.getAttribute("aria-expanded") === "true";
        disclosure.setAttribute("aria-expanded", String(!expanded));
        disclosure.setAttribute("aria-label", (expanded ? "Expand " : "Collapse ") + file.path);
        disclosure.textContent = expanded ? "▸" : "▾";
        rows.hidden = expanded;
        if (rows.contains(element("tutor"))) reanchorOpenComposer();
      });
      article.append(head, rows);
      container.append(article);
    });
    fileSelect.disabled = !files.length;
    element("previous-file").disabled = files.length < 2;
    element("next-file").disabled = files.length < 2;
    element("totals").replaceChildren(
      makeSpan("add", "+" + additions),
      document.createTextNode(" "),
      makeSpan("delete", "−" + deletions),
    );
    updateSelection();
    updateLearningBadges();
  }
  function scrollFile(index) {
    const target = element("file-" + index);
    if (target) target.scrollIntoView({ block: "start" });
    element("files").value = String(index);
  }
  function moveFile(delta) {
    const current = Number(element("files").value || 0);
    scrollFile((current + delta + files.length) % files.length);
  }
  function setAskLabel(text, spinner = false) {
    element("ask").replaceChildren();
    if (spinner) {
      const icon = document.createElement("span");
      icon.className = "spinner";
      icon.setAttribute("aria-hidden", "true");
      element("ask").append(icon);
    }
    element("ask").append(document.createTextNode(text));
  }
  function canAsk(questionState = currentQuestionState) {
    return !!currentSource && !asking && !["queued", "running"].includes(questionState) && !!element("question").value.trim();
  }
  function updateActions(questionState = currentQuestionState) {
    element("load").disabled = loading;
    const hasQuestion = element("question").value.trim().length > 0;
    const active = asking || ["queued", "running"].includes(questionState);
    element("ask").disabled = !canAsk(questionState);
    element("ask").classList.toggle("busy-neutral", active);
    element("cancel").disabled =
      questionState !== "queued" && questionState !== "running";
    element("ask-helper").textContent = !currentSource
      ? "Load a source first."
      : !hasQuestion
        ? "Enter a question to ask the tutor."
        : "";
    const selectionLabel = selection && selection.startLine != null
      ? selection.file + ":" + selection.startLine + "-" + selection.endLine
      : selection ? selection.count + " selected lines" : "";
    element("mobile-ask").textContent =
      questionState === "queued"
        ? "Tutor queued — reopen"
        : questionState === "running"
          ? "Tutor is answering — reopen"
        : selection
          ? "Ask about " + selectionLabel
          : "Ask the tutor";
  }
  function updateQuestion(question) {
    currentQuestionState = question.state;
    if (typeof question.answer === "string") setAnswer(question.answer);
    element("question-state").textContent = question.state;
    if (question.state === "running") {
      element("answer").classList.add("streaming");
      announce("Tutor is answering.");
    } else element("answer").classList.remove("streaming");
    if (question.state === "queued") {
      announce("Question queued.");
      setAskLabel("Queued");
    }
    if (question.state === "running") setAskLabel("Running");
    if (question.state === "answered") {
      announce("Answer complete.");
      setAskLabel("Ask");
      refreshLog().catch((error) => showError(error, "Log refresh"));
    }
    if (question.state === "cancelled") {
      pendingQuiz = null;
      setAnswerTail("Cancelled.");
      announce("Cancelled.");
      setAskLabel("Ask");
    }
    if (question.state === "failed") {
      pendingQuiz = null;
      if (question.error)
        showError(new Error(question.error.message), "Question");
      announce("Question failed.");
      setAskLabel("Ask");
    }
    updateActions();
  }
  async function reconcileQuestion() {
    if (!currentQuestionId) return null;
    const snapshot = await api("/api/state");
    const question = snapshot.questions.find((item) => item.id === currentQuestionId);
    if (question) updateQuestion(question);
    return question || null;
  }
  function bufferAskEvent(type, payload) {
    if (type === "question") {
      for (let index = pendingAskEvents.length - 1; index >= 0; index--)
        if (pendingAskEvents[index].payload.id === payload.id) pendingAskEvents.splice(index, 1);
    } else {
      const previous = pendingAskEvents.at(-1);
      if (previous?.type === type && previous.payload.id === payload.id) {
        previous.payload = { ...payload, text: previous.payload.text + payload.text };
        return;
      }
    }
    pendingAskEvents.push({ type, payload });
    if (pendingAskEvents.length > 256) pendingAskEvents.shift();
  }
  function replayAskEvents(questionId) {
    const events = pendingAskEvents.filter((event) => event.payload.id === questionId);
    pendingAskEvents.length = 0;
    for (const event of events) {
      if (event.type === "question") updateQuestion(event.payload);
      else {
        appendAnswer(event.payload.text);
        element("answer").classList.add("streaming");
      }
    }
  }
  async function submitQuestion() {
    if (!canAsk()) return;
    asking = true;
    pendingAskEvents.length = 0;
    currentQuestionId = undefined;
    currentQuestionState = undefined;
    clearError();
    clearHistoryState();
    composerSelectionKey = selectionIdentity();
    setAnswerTail("");
    setAnswer("");
    element("ask").setAttribute("aria-busy", "true");
    setAskLabel("Asking…", true);
    announce("Question sent. Waiting for the tutor.");
    updateActions();
    try {
      const safeSelection = selection || {
        text: "",
        file: undefined,
        startLine: undefined,
        endLine: undefined,
        context: undefined,
      };
      pendingQuiz =
        element("mode").value === "quiz"
          ? {
              inputId: currentSource.id,
              question: element("question").value,
              modelId: element("model").value,
              selection: safeSelection,
              submittedAt: Date.now(),
            }
          : null;
      const result = await api("/api/ask", {
        method: "POST",
        body: JSON.stringify({
          protocol: "rt/1",
          inputId: currentSource.id,
          selection: {
            text: safeSelection.text,
            file: safeSelection.file,
            startLine: safeSelection.startLine,
            endLine: safeSelection.endLine,
            context: safeSelection.context,
          },
          question: element("question").value,
          modelId: element("model").value,
          thinkingLevel: element("thinking").value,
          preferences: {
            explanationLanguage: element("language").value,
            comparisonLanguages: matchSelects
              .map((select) => select.value)
              .filter(Boolean)
              .slice(0, 3),
          },
          mode: element("mode").value,
        }),
      });
      currentQuestionId = result.id;
      updateQuestion(result);
      replayAskEvents(result.id);
      try {
        await reconcileQuestion();
      } catch (error) {
        showError(error, "State reconciliation");
      }
    } catch (error) {
      pendingQuiz = null;
      pendingAskEvents.length = 0;
      showError(error, "Question");
      announce("Question failed.");
      setAskLabel("Ask");
    } finally {
      asking = false;
      element("ask").setAttribute("aria-busy", "false");
      updateActions();
    }
  }
  function updateMatches() {
    const selected = new Set(
      matchSelects
        .map((select) => select.value.toLocaleLowerCase())
        .filter(Boolean),
    );
    for (const select of matchSelects)
      for (const option of select.options)
        option.disabled =
          !!option.value &&
          option.value !== select.value &&
          selected.has(option.value.toLocaleLowerCase());
  }
  async function patchLog(id, patch) {
    return api("/api/log/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
  function metadata(entry) {
    const parts = [entry.source.label];
    if (entry.selection.file) parts.push(entry.selection.file);
    if (entry.selection.startLine)
      parts.push(
        "lines " +
          entry.selection.startLine +
          "-" +
          (entry.selection.endLine || entry.selection.startLine),
      );
    parts.push(new Date(entry.createdAt).toLocaleString());
    return parts.join(" · ");
  }
  function renderLog() {
    const container = element("log");
    container.replaceChildren();
    const entries = [...logEntries]
      .reverse()
      .filter(
        (entry) => element("log-filter").value !== "later" || entry.reviewLater,
      );
    if (!entries.length) {
      container.append(makeSpan("helper", "No learning entries yet."));
      updateLearningBadges();
      return;
    }
    for (const entry of entries) {
      const item = document.createElement("article");
      item.className = "log-entry";
      item.dataset.entryId = entry.id;
      const title = document.createElement("h3");
      title.textContent = entry.question;
      const meta = makeSpan("metadata", metadata(entry));
      const answer = document.createElement("div");
      answer.className = "log-answer";
      renderMarkdown(answer, entry.answer);
      const noteLabel = document.createElement("label");
      noteLabel.className = "field";
      noteLabel.append(makeSpan("", "Note"));
      const note = document.createElement("textarea");
      note.value = noteDrafts.has(entry.id) ? noteDrafts.get(entry.id) : entry.note || "";
      note.maxLength = 16384;
      const saved = makeSpan("saved", "");
      note.addEventListener("input", () => {
        noteDrafts.set(entry.id, note.value);
        saved.textContent = "";
      });
      note.addEventListener("blur", async () => {
        try {
          logRevision++;
          await patchLog(entry.id, { note: note.value });
          entry.note = note.value;
          noteDrafts.delete(entry.id);
          saved.textContent = "saved";
          if (deferredLogEntries) {
            const active = document.activeElement;
            if (!active?.matches(".log-entry textarea") && !active?.closest(".entry-actions")) {
              logEntries = deferredLogEntries;
              deferredLogEntries = null;
              renderLog();
            }
          }
        } catch (error) {
          showError(error, "Note save");
        }
      });
      noteLabel.append(note);
      const actions = document.createElement("div");
      actions.className = "entry-actions";
      const review = document.createElement("button");
      review.className = "ghost review";
      review.setAttribute("aria-pressed", String(entry.reviewLater));
      review.textContent = "Review later";
      review.addEventListener("click", async () => {
        const next = !entry.reviewLater;
        try {
          logRevision++;
          await patchLog(entry.id, { reviewLater: next });
          entry.reviewLater = next;
          review.setAttribute("aria-pressed", String(next));
          if (element("log-filter").value === "later") renderLog();
        } catch (error) {
          showError(error, "Review later");
        }
      });
      actions.append(review, saved);
      if (quizEntryIds.has(entry.id) || entry.quizOutcome) {
        for (const [label, outcome] of [
          ["Got it", "got_it"],
          ["Almost", "almost"],
          ["Review again", "review_again"],
        ]) {
          const button = document.createElement("button");
          button.className = "ghost quiz-outcome";
          button.textContent = label;
          button.setAttribute(
            "aria-pressed",
            String(entry.quizOutcome === outcome),
          );
          button.addEventListener("click", async () => {
            try {
              logRevision++;
              await patchLog(entry.id, { quizOutcome: outcome });
              entry.quizOutcome = outcome;
              actions.querySelectorAll(".quiz-outcome").forEach((candidate) => {
                candidate.setAttribute("aria-pressed", String(candidate === button));
              });
            } catch (error) {
              showError(error, "Quiz outcome");
            }
          });
          actions.append(button);
        }
      }
      item.append(title, meta, answer, noteLabel, actions);
      container.append(item);
    }
    updateLearningBadges();
  }
  async function refreshLog() {
    const revision = logRevision;
    const sequence = ++logRefreshSequence;
    const next = await api("/api/log?limit=100");
    if (revision !== logRevision || sequence !== logRefreshSequence) return;
    const active = document.activeElement;
    if (active?.matches('.log-entry textarea') || active?.closest('.entry-actions')) {
      deferredLogEntries = next;
      return;
    }
    logEntries = next;
    renderLog();
  }
  function setBackgroundIsolated(isolated, owner) {
    const nodes = owner === "config"
      ? [document.querySelector(".topbar"), element("diff-pane"), element("mobile-ask")]
      : [document.querySelector(".topbar"), element("source-setup"), document.querySelector(".toolbar"), element("diff-scroll"), document.querySelector(".rail"), element("mobile-ask")];
    for (const node of nodes) {
      if (!node) continue;
      if (isolated) node.setAttribute("inert", "");
      else node.removeAttribute("inert");
    }
  }
  function updateModalLock() {
    const tutorOpen = element("tutor").classList.contains("open") && element("tutor").getAttribute("role") === "dialog";
    const rail = document.querySelector(".rail");
    const configOpen = rail.classList.contains("config-open") && rail.getAttribute("role") === "dialog";
    document.body.classList.toggle("modal-open", tutorOpen || configOpen);
  }
  function closeConfig(restore = true) {
    const rail = document.querySelector(".rail");
    const wasOpen = rail.classList.contains("config-open");
    rail.classList.remove("config-open");
    rail.removeAttribute("role");
    rail.removeAttribute("aria-modal");
    rail.removeAttribute("aria-labelledby");
    setBackgroundIsolated(false, "config");
    updateModalLock();
    if (restore && wasOpen) element("open-config").focus();
  }
  function openConfig() {
    if (element("tutor").getAttribute("role") === "dialog") closeTutor(false);
    const rail = document.querySelector(".rail");
    rail.classList.add("config-open");
    rail.setAttribute("role", "dialog");
    rail.setAttribute("aria-modal", "true");
    rail.setAttribute("aria-labelledby", "config-title");
    setBackgroundIsolated(true, "config");
    updateModalLock();
    rail.focus({ preventScroll: true });
  }
  function applyRail() {
    const workbench = document.querySelector(".workbench"), rail = document.querySelector(".rail"), toggle = element("toggle-rail");
    if (innerWidth > MOBILE_BREAKPOINT) {
      closeConfig(false);
      workbench.classList.toggle("rail-collapsed", railCollapsed);
      element("config-section").hidden = railCollapsed;
      toggle.setAttribute("aria-controls", "config-section");
      toggle.setAttribute("aria-expanded", String(!railCollapsed));
      toggle.setAttribute("aria-label", (railCollapsed ? "Expand" : "Collapse") + " configuration");
      toggle.textContent = railCollapsed ? "‹" : "›";
    } else {
      workbench.classList.remove("rail-collapsed");
      element("config-section").hidden = false;
      toggle.removeAttribute("aria-controls");
      toggle.removeAttribute("aria-expanded");
      toggle.setAttribute("aria-label", "Close configuration");
      toggle.textContent = "Close";
    }
  }
  function openTutor(opener, preserve = false) {
    if (!preserve) prepareFreshComposer();
    lastTutorOpener = opener;
    restoreComposerOnDesktop = true;
    const tutor = element("tutor");
    if (innerWidth > MOBILE_BREAKPOINT) {
      tutor.classList.add("open");
      reanchorOpenComposer();
      return;
    }
    closeConfig(false);
    tutor.classList.add("open");
    tutor.setAttribute("role", "dialog");
    tutor.setAttribute("aria-modal", "true");
    setBackgroundIsolated(true, "tutor");
    updateModalLock();
    tutor.focus();
  }
  function closeTutor(restore = true) {
    const tutor = element("tutor"), dialog = tutor.getAttribute("role") === "dialog";
    restoreComposerOnDesktop = false;
    tutor.classList.remove("open");
    if (activeHistoryBadge) activeHistoryBadge.setAttribute("aria-expanded", "false");
    tutor.setAttribute("role", "region");
    tutor.removeAttribute("aria-modal");
    if (dialog) setBackgroundIsolated(false, "tutor");
    anchorComposer();
    updateModalLock();
    const fallback = dialog ? lastTutorOpener : (selection ? rowControl(activeRow) : lastTutorOpener) || rowControl(activeRow) || element("open-composer");
    if (restore && fallback) fallback.focus();
  }
  function trapFocus(event, container) {
    if (event.key !== "Tab" || container.getAttribute("role") !== "dialog") return;
    const focusable = [...container.querySelectorAll("button:not([disabled]),select:not([disabled]),textarea:not([disabled]),input:not([disabled]),a[href]")]
      .filter((node) => !node.closest("[hidden]"));
    const first = focusable[0], last = focusable.at(-1), active = document.activeElement;
    if (!first || !last || !container.contains(active)) return;
    if (!focusable.includes(active)) { (event.shiftKey ? last : first).focus(); event.preventDefault(); }
    else if (event.shiftKey && active === first) { last.focus(); event.preventDefault(); }
    else if (!event.shiftKey && active === last) { first.focus(); event.preventDefault(); }
  }
  function trapDialog(event) {
    if (event.key === "Escape" && element("tutor").classList.contains("open")) { closeTutor(); return; }
    trapFocus(event, element("tutor"));
  }
  async function initialize() {
    fill(element("language"), HUMAN_LANGUAGES);
    for (const select of matchSelects) {
      fill(select, PROGRAMMING_LANGUAGES, true);
      select.addEventListener("change", updateMatches);
    }
    state = await api("/api/state");
    fill(
      element("model"),
      state.models.map((model) => model.id),
    );
    for (let i = 0; i < state.models.length; i++)
      element("model").options[i].textContent = state.models[i].label;
    updateThinking();
    currentSource = state.input;
    if (currentSource) acceptSource(currentSource);
    updateActions();
    await refreshLog();
    const events = new EventSource(
      "/api/events?session=" + encodeURIComponent(token),
    );
    events.onopen = () => {
      element("connection").textContent = "connected";
      element("connection").dataset.state = "connected";
      reconcileQuestion().catch((error) => showError(error, "State reconciliation"));
    };
    events.onerror = () => {
      element("connection").textContent = "reconnecting";
      element("connection").dataset.state = "reconnecting";
    };
    function parseEvent(event, action) {
      try {
        return JSON.parse(event.data);
      } catch (error) {
        showError(error, action);
      }
    }
    events.addEventListener("answer_delta", (event) => {
      const delta = parseEvent(event, "Live answer");
      if (!delta) return;
      if (asking && !currentQuestionId) bufferAskEvent("answer_delta", delta);
      else if (delta.id === currentQuestionId) {
        appendAnswer(delta.text);
        element("answer").classList.add("streaming");
      }
    });
    events.addEventListener("question", (event) => {
      const question = parseEvent(event, "Question update");
      if (!question) return;
      if (asking && !currentQuestionId) bufferAskEvent("question", question);
      else if (question.id === currentQuestionId) updateQuestion(question);
    });
    events.addEventListener("state", (event) => {
      const snapshot = parseEvent(event, "State update");
      if (!snapshot) return;
      if (snapshot.input && snapshot.input.id !== currentSource?.id)
        acceptSource(snapshot.input);
      let question = snapshot.questions.find(
        (item) => item.id === currentQuestionId,
      );
      if (!currentQuestionId) {
        question = snapshot.questions
          .filter((item) => ["queued", "running"].includes(item.state))
          .at(-1);
        if (asking && question) bufferAskEvent("question", question);
        else currentQuestionId = question?.id;
      }
      if (question && question.id === currentQuestionId) updateQuestion(question);
    });
    events.addEventListener("source", (event) => {
      const source = parseEvent(event, "Source update");
      if (source && source.id !== currentSource?.id) acceptSource(source);
    });
    events.addEventListener("log_update", (event) => {
      const entry = parseEvent(event, "Log update");
      if (entry && pendingQuiz && quizEntryMatchesPending(entry)) {
        quizEntryIds.add(entry.id);
        while (quizEntryIds.size > MAX_QUIZ_IDS) quizEntryIds.delete(quizEntryIds.values().next().value);
        sessionStorage.setItem(QUIZ_IDS_KEY, JSON.stringify([...quizEntryIds]));
        pendingQuiz = null;
      }
      refreshLog().catch((error) => showError(error, "Log refresh"));
    });
    setInterval(() => {
      api("/api/heartbeat", { method: "POST", body: "{}" }).catch(() =>
        announce("Heartbeat failed."),
      );
    }, 10000);
  }
  function quizEntryMatchesPending(entry) {
    if (entry.inputId !== pendingQuiz.inputId || entry.question !== pendingQuiz.question || entry.modelId !== pendingQuiz.modelId) return false;
    const createdAt = new Date(entry.createdAt).getTime();
    if (createdAt < pendingQuiz.submittedAt || createdAt - pendingQuiz.submittedAt > 300000) return false;
    const expected = pendingQuiz.selection;
    return entry.selection.text === expected.text &&
      entry.selection.file === expected.file &&
      entry.selection.startLine === expected.startLine &&
      entry.selection.endLine === expected.endLine;
  }
  function updateThinking() {
    const model = state?.models.find(
      (candidate) => candidate.id === element("model").value,
    );
    fill(element("thinking"), model?.thinkingLevels || []);
  }
  function acceptSource(source) {
    currentSource = source;
    const parsed = parseUnifiedDiff(source.content, source.label);
    files = parsed.files;
    preambleText = parsed.preamble;
    selection = null;
    selectionAnchor = null;
    activeRow = null;
    composerSelectionKey = null;
    if (!["queued", "running"].includes(currentQuestionState)) resetComposer();
    setView("diff");
    element("source-setup").hidden = true;
    element("change-source").hidden = false;
    element("top-source").textContent = source.label;
    renderDiff();
    updateActions();
  }
  element("kind").addEventListener("change", updateSourceFields);
  element("model").addEventListener("change", updateThinking);
  for (const id of ["view-diff", "view-log"]) {
    element(id).addEventListener("click", () => setView(id === "view-log" ? "log" : "diff"));
    element(id).addEventListener("keydown", handleViewKey);
  }
  element("history-previous").addEventListener("click", () => renderHistoryEntry(Math.max(0, historyIndex - 1)));
  element("history-next").addEventListener("click", () => renderHistoryEntry(Math.min(historyEntries.length - 1, historyIndex + 1)));
  element("question").addEventListener("input", updateActions);
  element("question").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      submitQuestion();
    }
  });
  element("ask").addEventListener("click", submitQuestion);
  element("load").addEventListener("click", async () => {
    if (loading) return;
    loading = true;
    clearError();
    element("load").textContent = "Loading…";
    updateActions();
    try {
      const kind = element("kind").value,
        request = { protocol: "rt/1", kind };
      if (kind === "paste") {
        request.content = element("paste").value;
        if (element("paste-label").value.trim())
          request.label = element("paste-label").value;
      } else if (kind === "commit")
        request.revision = element("revision").value;
      else if (kind === "range") {
        request.from = element("range-from").value;
        request.to = element("range-to").value;
      } else if (kind === "pr") request.url = element("pr-url").value;
      acceptSource(
        await api("/api/source", {
          method: "POST",
          body: JSON.stringify(request),
        }),
      );
    } catch (error) {
      showError(error, "Source load", true);
    } finally {
      loading = false;
      element("load").textContent = "Load source";
      updateActions();
    }
  });
  element("change-source").addEventListener("click", () => {
    element("source-setup").hidden = false;
    element("source-setup").scrollIntoView();
  });
  element("files").addEventListener("change", (event) =>
    scrollFile(Number(event.target.value)),
  );
  element("previous-file").addEventListener("click", () => moveFile(-1));
  element("next-file").addEventListener("click", () => moveFile(1));
  element("select-lines").addEventListener("click", () => {
    touchSelection = !touchSelection;
    element("select-lines").setAttribute(
      "aria-pressed",
      String(touchSelection),
    );
    selectionAnchor = null;
  });
  element("clear-selection").addEventListener("click", () => {
    const previousSelection = selection;
    selection = null;
    selectionAnchor = null;
    updateSelection(previousSelection, activeRow);
    reanchorOpenComposer();
    rowControl(activeRow)?.focus();
  });
  element("mobile-ask").addEventListener("click", (event) => openTutor(event.currentTarget));
  element("open-composer").addEventListener("click", (event) => { openTutor(event.currentTarget); element("question").focus(); });
  element("open-config").addEventListener("click", openConfig);
  element("toggle-rail").addEventListener("click", () => {
    if (innerWidth <= MOBILE_BREAKPOINT) { closeConfig(); return; }
    railCollapsed = !railCollapsed;
    sessionStorage.setItem("reviewTutorRailCollapsed", railCollapsed ? "1" : "0");
    applyRail();
  });
  element("jump-log").addEventListener("click", () => {
    if (innerWidth <= MOBILE_BREAKPOINT) closeConfig(false);
    setView("log", true);
  });
  element("close-tutor").addEventListener("click", closeTutor);
  element("tutor").addEventListener("keydown", trapDialog);
  document.querySelector(".rail").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && event.currentTarget.getAttribute("role") === "dialog") { closeConfig(); return; }
    trapFocus(event, event.currentTarget);
  });
  addEventListener("resize", () => {
    const tutor = element("tutor"), focusedInside = tutor.contains(document.activeElement);
    if (innerWidth <= MOBILE_BREAKPOINT) {
      if (tutor.classList.contains("open") && tutor.getAttribute("role") !== "dialog") {
        restoreComposerOnDesktop = true;
        tutor.classList.remove("open");
        anchorComposer();
        if (focusedInside) (rowControl(activeRow) || element("change-source")).focus();
      }
    } else {
      if (tutor.getAttribute("role") === "dialog") {
        restoreComposerOnDesktop = true;
        tutor.setAttribute("role", "region");
        tutor.removeAttribute("aria-modal");
        setBackgroundIsolated(false, "tutor");
        updateModalLock();
      }
      if (restoreComposerOnDesktop) {
        tutor.classList.add("open");
        reanchorOpenComposer();
      } else {
        tutor.classList.remove("open");
        anchorComposer();
      }
      const fallback = rowControl(activeRow) || element("change-source");
      if (focusedInside && !tutor.classList.contains("open") && fallback && !fallback.hidden) fallback.focus();
    }
    applyRail();
  });
  element("cancel").addEventListener("click", async () => {
    clearError();
    try {
      updateQuestion(
        await api("/api/questions/" + encodeURIComponent(currentQuestionId) + "/cancel", {
          method: "POST",
          body: "{}",
        }),
      );
    } catch (error) {
      let canonical = null;
      try {
        canonical = await reconcileQuestion();
      } catch {}
      if (!canonical || ["queued", "running"].includes(canonical.state))
        showError(error, "Cancellation");
    }
  });
  element("refresh").addEventListener("click", () => {
    clearError();
    refreshLog().catch((error) => showError(error, "Log refresh"));
  });
  element("log-filter").addEventListener("change", renderLog);
  element("export").addEventListener("click", async () => {
    clearError();
    try {
      const response = await fetch("/api/export", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!response.ok) throw new Error(response.statusText);
      const blob = await response.blob(),
        link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "review-tutor.html";
      link.click();
      const objectUrl = link.href;
      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
    } catch (error) {
      showError(error, "Export");
    }
  });
  updateSourceFields();
  setView("diff");
  applyRail();
  initialize().catch((error) => {
    element("connection").textContent = "failed";
    element("connection").dataset.state = "failed";
    showError(error, "Startup");
  });
})();
`;
