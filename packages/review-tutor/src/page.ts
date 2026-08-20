export const pageHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Review Tutor</title>
  <style>
    body { font: 16px system-ui; max-width: 900px; margin: auto; padding: 1rem; line-height: 1.45; }
    label { display: block; margin: .75rem 0; }
    input, textarea, select, button { font: inherit; }
    textarea, input, select { box-sizing: border-box; width: 100%; padding: .5rem; }
    textarea { min-height: 7rem; }
    button { margin: .5rem .5rem .5rem 0; padding: .5rem 1rem; }
    pre { white-space: pre-wrap; background: #eee; padding: 1rem; min-height: 4rem; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .status { font-weight: bold; }
    .error { color: #8b0000; }
    .log-entry { border-top: 1px solid #ccc; padding: .75rem 0; white-space: pre-wrap; }
    @media (max-width: 600px) { .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Review Tutor</h1>
  <p>Secure local prototype. GitHub is the source of truth.</p>
  <p id="connection" class="status" role="status" aria-live="polite">Connection: starting</p>
  <p id="error" class="error" role="alert"></p>

  <section>
    <h2>Source</h2>
    <label>Source kind
      <select id="kind">
        <option value="worktree">Local worktree diff</option>
        <option value="staged">Staged diff</option>
        <option value="commit">Commit</option>
        <option value="range">Commit range</option>
        <option value="pr">GitHub PR URL</option>
        <option value="paste">Pasted code</option>
      </select>
    </label>
    <label>Source value or pasted code<textarea id="source"></textarea></label>
    <button id="load">Load source</button>
    <p id="current">No source loaded.</p>
  </section>

  <section>
    <h2>Ask</h2>
    <div class="row">
      <label>Model<select id="model"></select></label>
      <label>Thinking<select id="thinking"></select></label>
    </div>
    <label>Explanation language<input id="language" value="English" maxlength="64"></label>
    <label>Comparison languages, comma-separated, up to three<input id="comparisons"></label>
    <label>Selected code<textarea id="selected" maxlength="16384"></textarea></label>
    <label>Nearby context<textarea id="context" maxlength="32768"></textarea></label>
    <label>Question<textarea id="question" maxlength="4096"></textarea></label>
    <label>Mode
      <select id="mode"><option value="explain">Explain</option><option value="quiz">Quiz</option></select>
    </label>
    <button id="ask" disabled>Ask</button>
    <button id="cancel" disabled>Cancel</button>
    <h3>Answer</h3>
    <pre id="answer" aria-live="polite"></pre>
  </section>

  <section>
    <h2>Recent log</h2>
    <button id="refresh">Refresh log</button>
    <button id="export">Export HTML</button>
    <div id="log"></div>
  </section>

  <script>
    (function () {
      const element = (id) => document.getElementById(id);
      const params = new URLSearchParams(location.search);
      const incoming = params.get("session");
      if (incoming) {
        sessionStorage.setItem("reviewTutorSession", incoming);
        history.replaceState({}, "", location.pathname);
      }
      const token = sessionStorage.getItem("reviewTutorSession");
      let state;
      let currentSource;
      let currentQuestionId;
      let currentQuestionState;
      let loading = false;
      let asking = false;

      function showError(error, action) {
        const message = error instanceof Error ? error.message : String(error);
        element("error").textContent = action + " failed: " + message;
      }

      function clearError() {
        element("error").textContent = "";
      }

      function updateActions(questionState = currentQuestionState) {
        element("load").disabled = loading;
        element("ask").disabled = !currentSource || asking;
        element("cancel").disabled = questionState !== "queued" && questionState !== "running";
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

      function replaceOptions(select, values, valueOf, labelOf) {
        select.replaceChildren();
        for (const value of values) {
          const option = document.createElement("option");
          option.value = valueOf(value);
          option.textContent = labelOf(value);
          select.append(option);
        }
      }

      function updateThinking() {
        const model = state.models.find((candidate) => candidate.id === element("model").value);
        replaceOptions(element("thinking"), model?.thinkingLevels || [], String, String);
      }

      function updateModels() {
        replaceOptions(element("model"), state.models, (model) => model.id, (model) => model.label);
        updateThinking();
      }

      async function refreshLog() {
        const entries = await api("/api/log?limit=20");
        const container = element("log");
        container.replaceChildren();
        for (const entry of entries) {
          const item = document.createElement("article");
          item.className = "log-entry";
          const question = document.createElement("strong");
          question.textContent = entry.question;
          const answer = document.createElement("div");
          answer.textContent = entry.answer;
          item.append(question, answer);
          container.append(item);
        }
      }

      async function initialize() {
        state = await api("/api/state");
        updateModels();
        currentSource = state.input;
        element("current").textContent = currentSource ? currentSource.label : "No source loaded.";
        updateActions();
        await refreshLog();

        const events = new EventSource("/api/events?session=" + encodeURIComponent(token));
        events.onopen = () => { element("connection").textContent = "Connection: connected"; };
        events.onerror = () => { element("connection").textContent = "Connection: reconnecting"; };
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
            element("answer").textContent += delta.text;
          }
        });
        events.addEventListener("question", (event) => {
          const question = parseEvent(event, "Question update");
          if (!question || question.id !== currentQuestionId) return;
          currentQuestionState = question.state;
          if (["answered", "failed", "cancelled"].includes(currentQuestionState)) {
            element("answer").textContent = question.answer;
            if (currentQuestionState === "failed" && question.error) {
              showError(new Error(question.error.message), "Question");
            }
            refreshLog().catch((error) => showError(error, "Log refresh"));
          }
          updateActions();
        });
        events.addEventListener("state", (event) => {
          const snapshot = parseEvent(event, "State update");
          if (!snapshot) return;
          currentSource = snapshot.input;
          element("current").textContent = currentSource
            ? currentSource.label
            : "No source loaded.";
          let question = snapshot.questions.find(
            (candidate) => candidate.id === currentQuestionId,
          );
          if (!currentQuestionId) {
            question = snapshot.questions
              .filter((candidate) => ["queued", "running"].includes(candidate.state))
              .at(-1);
            currentQuestionId = question?.id;
          }
          if (question) {
            currentQuestionState = question.state;
            element("answer").textContent = question.answer;
            if (currentQuestionState === "failed" && question.error) {
              showError(new Error(question.error.message), "Question");
            }
          }
          updateActions();
        });

        setInterval(() => {
          api("/api/heartbeat", { method: "POST", body: "{}" })
            .catch((error) => showError(error, "Heartbeat"));
        }, 10_000);
      }

      element("model").addEventListener("change", updateThinking);
      element("load").addEventListener("click", async () => {
        if (loading) return;
        loading = true;
        clearError();
        updateActions();
        try {
          const kind = element("kind").value;
          const value = element("source").value;
          const request = { protocol: "rt/1", kind };
          if (kind === "paste") request.content = value;
          else if (kind === "commit") request.revision = value;
          else if (kind === "range") [request.from, request.to] = value.split("...");
          else if (kind === "pr") request.url = value;
          currentSource = await api("/api/source", { method: "POST", body: JSON.stringify(request) });
          element("current").textContent = currentSource.label;
        } catch (error) {
          showError(error, "Source load");
        } finally {
          loading = false;
          updateActions();
        }
      });

      element("ask").addEventListener("click", async () => {
        if (asking || !currentSource) return;
        asking = true;
        clearError();
        updateActions();
        element("answer").textContent = "";
        try {
          const result = await api("/api/ask", {
            method: "POST",
            body: JSON.stringify({
              protocol: "rt/1",
              inputId: currentSource.id,
              selection: { text: element("selected").value, context: element("context").value },
              question: element("question").value,
              modelId: element("model").value,
              thinkingLevel: element("thinking").value,
              preferences: {
                explanationLanguage: element("language").value,
                comparisonLanguages: element("comparisons").value.split(",").map((value) => value.trim()).filter(Boolean),
              },
              mode: element("mode").value,
            }),
          });
          currentQuestionId = result.id;
          currentQuestionState = result.state;
          element("answer").textContent = result.answer;
          updateActions(currentQuestionState);
        } catch (error) {
          showError(error, "Question");
        } finally {
          asking = false;
          updateActions(currentQuestionState);
        }
      });

      element("cancel").addEventListener("click", async () => {
        clearError();
        try {
          const result = await api("/api/questions/" + currentQuestionId + "/cancel", {
            method: "POST",
            body: "{}",
          });
          currentQuestionState = result.state;
          updateActions(currentQuestionState);
        } catch (error) {
          showError(error, "Cancellation");
        }
      });

      element("refresh").addEventListener("click", () => {
        clearError();
        refreshLog().catch((error) => showError(error, "Log refresh"));
      });

      element("export").addEventListener("click", async () => {
        clearError();
        try {
          const response = await fetch("/api/export", { headers: { Authorization: "Bearer " + token } });
          if (!response.ok) throw new Error(response.statusText);
          const blob = await response.blob();
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = "review-tutor.html";
          link.click();
          const objectUrl = link.href;
          setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
        } catch (error) {
          showError(error, "Export");
        }
      });

      initialize().catch((error) => {
        element("connection").textContent = "Connection: failed";
        showError(error, "Startup");
      });
    })();
  </script>
</body>
</html>`;
