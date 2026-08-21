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
    pendingQuiz = null;
  const QUIZ_IDS_KEY = "reviewTutorQuizEntryIds";
  const MAX_QUIZ_IDS = 100;
  const MAX_SELECTED_BYTES = 16 * 1024;
  const MAX_CONTEXT_BYTES = 32 * 1024;
  const MOBILE_BREAKPOINT = 1040;
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
      } else target.lines.push({ kind: "meta", text: line });
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
      const origin = rowNode(activeRow);
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
      node.setAttribute("aria-pressed", String(selected));
    }
    const oldActiveNode = rowNode(previousActive), activeNode = rowNode(activeRow);
    if (oldActiveNode && oldActiveNode !== activeNode) oldActiveNode.tabIndex = -1;
    if (activeNode) activeNode.tabIndex = 0;
    if (!activeRow) {
      const first = document.querySelector('.diff-row[data-row]');
      if (first) { first.tabIndex = 0; activeRow = { fileIndex: Number(first.dataset.file), rowIndex: Number(first.dataset.row) }; }
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
    updateActions();
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
        selectionAnchor = { fileIndex, rowIndex };
        chooseRow(fileIndex, rowIndex, false, false);
        event.preventDefault();
        return;
      case "Enter":
        chooseRow(fileIndex, rowIndex, true, true);
        event.preventDefault();
        return;
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
    chooseRow(fileIndex, target, event.shiftKey, false);
    event.preventDefault();
    const next = rowNode({ fileIndex, rowIndex: target });
    if (next) next.focus();
  }
  function renderDiff() {
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
        row.setAttribute("role", "button");
        row.setAttribute("aria-pressed", "false");
        row.setAttribute("aria-label", file.path + " line " + data.selectLine);
        row.tabIndex = activeRow
          ? -1
          : fileIndex === 0 && rowIndex === file.lines.findIndex(rowSelectable)
            ? 0
            : -1;
        row.append(makeSpan("line-no", data.old == null ? "" : String(data.old)));
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
        if (event.pointerType === "touch" && !touchSelection) return;
        const fileIndex = Number(row.dataset.file), rowIndex = Number(row.dataset.row);
        if (touchSelection && selectionAnchor) chooseRow(fileIndex, rowIndex, true, true);
        else chooseRow(fileIndex, rowIndex, event.shiftKey, false);
      });
      rows.addEventListener("keydown", (event) => {
        const row = event.target.closest(".diff-row[data-row]");
        if (row && rows.contains(row)) handleRowKey(event, Number(row.dataset.file), Number(row.dataset.row));
      });
      disclosure.addEventListener("click", () => {
        const expanded = disclosure.getAttribute("aria-expanded") === "true";
        disclosure.setAttribute("aria-expanded", String(!expanded));
        disclosure.setAttribute("aria-label", (expanded ? "Expand " : "Collapse ") + file.path);
        disclosure.textContent = expanded ? "▸" : "▾";
        rows.hidden = expanded;
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
  function updateActions(questionState = currentQuestionState) {
    element("load").disabled = loading;
    const hasQuestion = element("question").value.trim().length > 0;
    const active = asking || ["queued", "running"].includes(questionState);
    element("ask").disabled = !currentSource || !hasQuestion || active;
    element("ask").classList.toggle("busy-neutral", active);
    element("cancel").disabled =
      questionState !== "queued" && questionState !== "running";
    element("ask-helper").textContent = !currentSource
      ? "Load a source first."
      : !hasQuestion
        ? "Enter a question to ask the tutor."
        : "Ready to ask.";
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
    if (typeof question.answer === "string") element("answer-text").textContent = question.answer;
    element("question-state").replaceChildren();
    if (question.state === "running") {
      const pulse = document.createElement("span");
      pulse.className = "pulse";
      pulse.setAttribute("aria-hidden", "true");
      element("question-state").append(
        pulse,
        document.createTextNode("running"),
      );
      element("answer").classList.add("streaming");
      announce("Tutor is answering.");
    } else {
      element("question-state").textContent = question.state;
      element("answer").classList.remove("streaming");
    }
    if (question.state === "queued") {
      announce("Question queued.");
      setAskLabel("Queued");
    }
    if (question.state === "running") setAskLabel("Running");
    if (question.state === "answered") {
      element("answer-text").textContent = question.answer;
      announce("Answer complete.");
      setAskLabel("Ask");
      refreshLog().catch((error) => showError(error, "Log refresh"));
    }
    if (question.state === "cancelled") {
      pendingQuiz = null;
      element("answer-text").textContent = question.answer;
      element("answer-tail").textContent = "Cancelled.";
      announce("Cancelled.");
      setAskLabel("Ask");
    }
    if (question.state === "failed") {
      pendingQuiz = null;
      element("answer-text").textContent = question.answer;
      if (question.error)
        showError(new Error(question.error.message), "Question");
      announce("Question failed.");
      setAskLabel("Ask");
    }
    updateActions();
  }
  async function reconcileQuestion() {
    if (!currentQuestionId) return;
    const snapshot = await api("/api/state");
    const question = snapshot.questions.find((item) => item.id === currentQuestionId);
    if (question) updateQuestion(question);
  }
  async function submitQuestion() {
    if (asking || !currentSource || !element("question").value.trim()) return;
    asking = true;
    clearError();
    element("answer-tail").textContent = "";
    element("answer-text").textContent = "";
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
      try {
        await reconcileQuestion();
      } catch (error) {
        showError(error, "State reconciliation");
      }
    } catch (error) {
      pendingQuiz = null;
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
      answer.textContent = entry.answer;
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
  }
  async function refreshLog() {
    const revision = logRevision;
    const next = await api("/api/log?limit=100");
    if (revision !== logRevision) return;
    const active = document.activeElement;
    if (active?.matches('.log-entry textarea') || active?.closest('.entry-actions')) {
      deferredLogEntries = next;
      return;
    }
    logEntries = next;
    renderLog();
  }
  function setBackgroundIsolated(isolated) {
    for (const node of [document.querySelector(".topbar"), element("diff-pane"), element("log-section"), element("mobile-ask")]) {
      if (!node) continue;
      if (isolated) node.setAttribute("inert", "");
      else node.removeAttribute("inert");
    }
  }
  function openTutor(opener) {
    if (innerWidth > MOBILE_BREAKPOINT) return;
    lastTutorOpener = opener;
    const tutor = element("tutor");
    tutor.classList.add("open");
    tutor.setAttribute("role", "dialog");
    tutor.setAttribute("aria-modal", "true");
    setBackgroundIsolated(true);
    tutor.focus();
  }
  function closeTutor() {
    const tutor = element("tutor");
    tutor.classList.remove("open");
    tutor.setAttribute("role", "region");
    tutor.removeAttribute("aria-modal");
    setBackgroundIsolated(false);
    if (lastTutorOpener) lastTutorOpener.focus();
  }
  function trapDialog(event) {
    if (event.key === "Escape" && element("tutor").classList.contains("open")) {
      closeTutor();
      return;
    }
    if (event.key !== "Tab" || !element("tutor").classList.contains("open"))
      return;
    const focusable = [
      ...element("tutor").querySelectorAll(
        "button:not([disabled]):not([hidden]),select:not([disabled]):not([hidden]),textarea:not([disabled]):not([hidden]),input:not([disabled]):not([hidden])",
      ),
    ];
    const first = focusable[0],
      last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      last.focus();
      event.preventDefault();
    } else if (!event.shiftKey && document.activeElement === last) {
      first.focus();
      event.preventDefault();
    }
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
      if (delta && delta.id === currentQuestionId) {
        element("answer-text").textContent += delta.text;
        element("answer").classList.add("streaming");
      }
    });
    events.addEventListener("question", (event) => {
      const question = parseEvent(event, "Question update");
      if (question && question.id === currentQuestionId)
        updateQuestion(question);
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
        currentQuestionId = question?.id;
      }
      if (question) updateQuestion(question);
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
    element("source-setup").hidden = true;
    element("change-source").hidden = false;
    element("top-source").textContent = source.label;
    renderDiff();
    updateActions();
  }
  element("kind").addEventListener("change", updateSourceFields);
  element("model").addEventListener("change", updateThinking);
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
    rowNode(activeRow)?.focus();
  });
  element("mobile-ask").addEventListener("click", (event) =>
    openTutor(event.currentTarget),
  );
  element("close-tutor").addEventListener("click", closeTutor);
  element("tutor").addEventListener("keydown", trapDialog);
  addEventListener("resize", () => {
    const tutor = element("tutor");
    if (innerWidth <= MOBILE_BREAKPOINT || !tutor.classList.contains("open")) return;
    const fallback = rowNode(activeRow) || element("change-source");
    tutor.classList.remove("open");
    tutor.setAttribute("role", "region");
    tutor.removeAttribute("aria-modal");
    setBackgroundIsolated(false);
    if (fallback && !fallback.hidden) fallback.focus();
  });
  element("cancel").addEventListener("click", async () => {
    clearError();
    try {
      updateQuestion(
        await api("/api/questions/" + currentQuestionId + "/cancel", {
          method: "POST",
          body: "{}",
        }),
      );
    } catch (error) {
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
  initialize().catch((error) => {
    element("connection").textContent = "failed";
    element("connection").dataset.state = "failed";
    showError(error, "Startup");
  });
})();
`;
