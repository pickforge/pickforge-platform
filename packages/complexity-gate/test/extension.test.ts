import { describe, expect, it, vi } from "vitest";
import complexityGateExtension from "../extensions/complexity-gate.ts";

const violation = JSON.stringify({ violations: [{ file: "src/a.ts", line: 2, function: "work", metric: "depth", value: 5, limit: 4 }] });

function host(stdout = violation, code = 1) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
  const sendUserMessage = vi.fn();
  const exec = vi.fn(async () => ({ code, stdout, stderr: "" }));
  const pi = { exec, sendUserMessage, on: (name: string, handler: never) => handlers.set(name, handler) };
  complexityGateExtension(pi as never);
  const ctx = { cwd: "/repo", ui: { notify: vi.fn() } };
  return { handlers, sendUserMessage, exec, ctx };
}

describe("Pi extension", () => {
  it("injects feedback after an edited file violates", async () => {
    const { handlers, ctx, exec } = host();
    const result = await handlers.get("tool_result")!({ toolName: "edit", input: { path: "src/a.ts" }, content: [] }, ctx) as any;
    expect(exec).toHaveBeenCalledWith("complexity-gate", ["check", "src/a.ts", "--format", "json"], { cwd: "/repo" });
    expect(result.content[0].text).toContain("FAIL src/a.ts:2 work");
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("stays silent when clean", async () => {
    const { handlers, ctx, sendUserMessage } = host(JSON.stringify({ violations: [] }), 0);
    expect(await handlers.get("tool_result")!({ toolName: "write", input: { path: "src/a.ts" }, content: [] }, ctx)).toBeUndefined();
    await handlers.get("agent_end")!({}, ctx);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("limits changed-file follow-ups to three per session", async () => {
    const { handlers, ctx, sendUserMessage } = host();
    for (let count = 0; count < 5; count += 1) await handlers.get("agent_end")!({}, ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Refactor the listed functions"), { deliverAs: "followUp" });
  });
});
