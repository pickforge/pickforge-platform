import { describe, expect, it, vi } from "vitest";
import { adapterProcess, createOpenCodePlugin, type GateRunner } from "../src/opencode-plugin.ts";

async function hooks(runGate: GateRunner) {
  const promptAsync = vi.fn(async () => ({}));
  const plugin = createOpenCodePlugin(runGate);
  const result = await plugin({
    client: { session: { promptAsync } },
    directory: "/repo",
  } as never);
  return { result, promptAsync };
}

describe("OpenCode plugin", () => {
  it("runs the package wrapper directly outside Windows", () => {
    expect(adapterProcess("linux")).toMatchObject({ command: expect.stringContaining("/bin/complexity-gate"), args: [] });
    expect(adapterProcess("win32")).toMatchObject({ command: "node", args: [expect.stringContaining("/bin/complexity-gate")] });
  });

  it("adds complexity feedback to edit tool output", async () => {
    const runGate = vi.fn(async () => "FAIL src/a.ts:2 work  depth 5 > 4");
    const { result } = await hooks(runGate);
    const output = { title: "Edit", output: "done", metadata: {} };
    await result["tool.execute.after"]!({
      tool: "edit",
      sessionID: "session",
      callID: "call",
      args: { filePath: "src/a.ts" },
    }, output);
    expect(runGate).toHaveBeenCalledWith({
      event: "PostToolUse",
      sessionID: "session",
      directory: "/repo",
      tool: "Edit",
      file: "src/a.ts",
    });
    expect(output.output).toContain("complexity-gate feedback");
  });

  it("continues an idle session when changed functions violate", async () => {
    const runGate = vi.fn(async () => "FAIL src/a.ts:2 work  depth 5 > 4");
    const { result, promptAsync } = await hooks(runGate);
    await result.event!({ event: { type: "session.idle", properties: { sessionID: "session" } } as never });
    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: "session" },
      query: { directory: "/repo" },
      body: { parts: [{ type: "text", text: expect.stringContaining("FAIL src/a.ts") }] },
    });
  });

  it("ignores unrelated tools and clean idle sessions", async () => {
    const runGate = vi.fn(async () => undefined);
    const { result, promptAsync } = await hooks(runGate);
    const output = { title: "Read", output: "done", metadata: {} };
    await result["tool.execute.after"]!({ tool: "read", sessionID: "session", callID: "call", args: {} }, output);
    await result.event!({ event: { type: "session.idle", properties: { sessionID: "session" } } as never });
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(output.output).toBe("done");
  });
});
