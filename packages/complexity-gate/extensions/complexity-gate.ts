import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Violation = { file: string; line: number; function: string; metric: string; value: number; limit: number };
type GateResult = { violations?: Violation[] };

function report(result: GateResult): string {
  return (result.violations ?? []).map((item) =>
    `FAIL ${item.file}:${item.line} ${item.function}  ${item.metric} ${item.value} > ${item.limit}`,
  ).join("\n");
}

async function check(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  try {
    const result = await pi.exec("complexity-gate", ["check", ...args, "--format", "json"], { cwd });
    if (result.code !== 0 && result.code !== 1) return "";
    return report(JSON.parse(result.stdout) as GateResult);
  } catch {
    return "";
  }
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
  pi.on("session_start", () => { blocks = 0; });
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      const file = fileFromInput(event.input);
      if (!file) return;
      const feedback = await check(pi, ctx.cwd, [file]);
      if (!feedback) return;
      notify(ctx, "complexity-gate found violations in the edited file");
      return { content: [...event.content, { type: "text" as const, text: `\ncomplexity-gate feedback:\n${feedback}` }] };
    } catch { return; }
  });
  pi.on("agent_end", async (_event, ctx) => {
    try {
      const feedback = await check(pi, ctx.cwd, ["--changed"]);
      if (!feedback) { blocks = 0; return; }
      notify(ctx, "complexity-gate found violations in changed functions");
      if (blocks >= 3) return;
      blocks += 1;
      pi.sendUserMessage(`${feedback}\nRefactor the listed functions (see the complexity-gate skill), then finish.`, { deliverAs: "followUp" });
    } catch { return; }
  });
}
