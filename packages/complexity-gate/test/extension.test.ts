import { describe, expect, it, vi } from "vitest";
import complexityGateExtension from "../extensions/complexity-gate.ts";

const violation = "FAIL 1 file, 1 function, 1 violation\nFAIL src/a.ts  1 function, 1 violation\nDETAILS complexity-gate check --verbose <file>\n";

function host(stdout = violation, code = 1, stderr = "") {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
  const sendUserMessage = vi.fn();
  const exec = vi.fn(async () => ({ code, stdout, stderr }));
  const pi = { exec, sendUserMessage, on: (name: string, handler: never) => handlers.set(name, handler) };
  complexityGateExtension(pi as never);
  const ctx = { cwd: "/repo", ui: { notify: vi.fn() } };
  return { handlers, sendUserMessage, exec, ctx };
}

describe("Pi extension", () => {
  it("injects feedback after an edited file violates", async () => {
    const { handlers, ctx, exec } = host();
    const result = await handlers.get("tool_result")!({ toolName: "edit", input: { path: "src/a.ts" }, content: [] }, ctx) as any;
    expect(exec).toHaveBeenCalledWith("complexity-gate", ["check", "--summary", "src/a.ts"], { cwd: "/repo" });
    expect(result.content[0].text).toContain("FAIL src/a.ts  1 function");
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("stays silent when clean", async () => {
    const { handlers, ctx, sendUserMessage } = host("", 0);
    expect(await handlers.get("tool_result")!({ toolName: "write", input: { path: "src/a.ts" }, content: [] }, ctx)).toBeUndefined();
    await handlers.get("agent_end")!({}, ctx);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("limits changed-file follow-ups to three per session", async () => {
    const { handlers, ctx, sendUserMessage } = host();
    for (let count = 0; count < 5; count += 1) await handlers.get("agent_end")!({}, ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Fix the listed files"), { deliverAs: "followUp" });
  });

  it("caps unexpected command output before adding it to context", async () => {
    const huge = Array.from({ length: 200 }, (_, index) => `FAIL src/${index}.ts:2 work  depth 5 > 4`).join("\n");
    const { handlers, ctx, sendUserMessage } = host(huge);
    await handlers.get("agent_end")!({}, ctx);
    const message = sendUserMessage.mock.calls[0]![0] as string;
    expect(message).toContain("output truncated");
    expect(message.length).toBeLessThan(8500);
  });

  it("warns once without adding command errors to model context", async () => {
    const { handlers, ctx, sendUserMessage } = host("", 2, "--changed requires a Git repository with HEAD");
    await handlers.get("agent_end")!({}, ctx);
    await handlers.get("agent_end")!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});
