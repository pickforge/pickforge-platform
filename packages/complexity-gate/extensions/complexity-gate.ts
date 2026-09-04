import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_FEEDBACK_LINES = 24;
const MAX_FEEDBACK_CHARS = 8192;
const TRUNCATED = "... complexity-gate output truncated";

type GateResult = { feedback?: string; error?: string; clean: boolean };

async function check(pi: ExtensionAPI, cwd: string, args: string[]): Promise<GateResult> {
  try {
    const result = await pi.exec("complexity-gate", ["check", ...args], { cwd });
    if (result.code === 0) return { clean: true };
    if (result.code === 1) return { clean: false, feedback: bounded(result.stdout) };
    return { clean: false, error: result.stderr.trim() || `exit ${result.code}` };
  } catch {
    return { clean: false, error: "command failed" };
  }
}

function bounded(output: string): string {
  const value = output.trim();
  const sourceLines = value.split("\n");
  let clipped = sourceLines.slice(0, MAX_FEEDBACK_LINES).join("\n");
  let truncated = sourceLines.length > MAX_FEEDBACK_LINES;
  const available = MAX_FEEDBACK_CHARS - TRUNCATED.length - 1;
  if (clipped.length > available) {
    clipped = clipped.slice(0, available);
    truncated = true;
  }
  return truncated ? `${clipped}\n${TRUNCATED}` : clipped;
}

function notify(ctx: ExtensionContext, message: string): void {
  try { ctx.ui.notify(message, "warning"); } catch {}
}

function fileFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as { path?: unknown; file_path?: unknown }).path ?? (input as { file_path?: unknown }).file_path;
  return typeof value === "string" ? value : undefined;
}

export default function complexityGateExtension(pi: ExtensionAPI): void {
  let blocks = 0;
  let warned = false;
  pi.on("session_start", () => { blocks = 0; warned = false; });
  const warnOnce = (ctx: ExtensionContext, error: string): void => {
    if (warned) return;
    warned = true;
    notify(ctx, `complexity-gate skipped: ${error.slice(0, 240)}`);
  };
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      const file = fileFromInput(event.input);
      if (!file) return;
      const result = await check(pi, ctx.cwd, ["--summary", file]);
      if (result.error) { warnOnce(ctx, result.error); return; }
      if (!result.feedback) return;
      notify(ctx, "complexity-gate found violations in the edited file");
      return { content: [...event.content, { type: "text" as const, text: `\ncomplexity-gate feedback:\n${result.feedback}` }] };
    } catch { return; }
  });
  pi.on("agent_end", async (_event, ctx) => {
    try {
      const result = await check(pi, ctx.cwd, ["--changed"]);
      if (result.error) { warnOnce(ctx, result.error); return; }
      if (result.clean) { blocks = 0; return; }
      if (!result.feedback) return;
      notify(ctx, "complexity-gate found violations in changed functions");
      if (blocks >= 3) return;
      blocks += 1;
      pi.sendUserMessage(`${result.feedback}\nFix the listed files, then finish.`, { deliverAs: "followUp" });
    } catch { return; }
  });
}
