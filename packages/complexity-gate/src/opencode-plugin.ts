import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

type OpenCodeInput = {
  client: {
    session: {
      promptAsync(options: {
        path: { id: string };
        query: { directory: string };
        body: { parts: Array<{ type: "text"; text: string }> };
      }): Promise<unknown>;
    };
  };
  directory: string;
};

type OpenCodeHooks = {
  "tool.execute.after": (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>;
  event: (input: {
    event: { type: string; properties?: { sessionID?: string } };
  }) => Promise<void>;
};

type OpenCodePlugin = (input: OpenCodeInput) => Promise<OpenCodeHooks>;

type GateRequest = {
  event: "PostToolUse" | "Stop";
  sessionID: string;
  directory: string;
  tool?: string;
  file?: string;
};

export type GateRunner = (request: GateRequest) => Promise<string | undefined>;

const wrapper = fileURLToPath(new URL("../bin/complexity-gate", import.meta.url));

export function adapterProcess(platform = process.platform): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: "node", args: [wrapper] }
    : { command: wrapper, args: [] };
}

function adapterInput(request: GateRequest): string {
  return JSON.stringify({
    hook_event_name: request.event,
    session_id: request.sessionID,
    cwd: request.directory,
    tool_name: request.tool,
    tool_input: request.file ? { file_path: request.file } : {},
  });
}

async function runAdapter(request: GateRequest): Promise<string | undefined> {
  return new Promise((resolve) => {
    const executable = adapterProcess();
    const child = spawn(executable.command, [...executable.args, "hook", "codex"], {
      cwd: request.directory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      console.warn(`complexity-gate: ${error.message}`);
      resolve(undefined);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`complexity-gate: hook failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
        resolve(undefined);
        return;
      }
      try {
        const result = stdout.trim() ? JSON.parse(stdout) as { reason?: unknown } : {};
        resolve(typeof result.reason === "string" ? result.reason : undefined);
      } catch {
        console.warn("complexity-gate: hook returned invalid JSON");
        resolve(undefined);
      }
    });
    child.stdin.end(adapterInput(request));
  });
}

function mappedTool(tool: string): string | undefined {
  if (tool === "edit") return "Edit";
  if (tool === "write") return "Write";
  if (tool === "apply_patch") return "apply_patch";
}

function editedFile(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as { filePath?: unknown }).filePath
    ?? (args as { file_path?: unknown }).file_path
    ?? (args as { path?: unknown }).path;
  return typeof value === "string" ? value : undefined;
}

export function createOpenCodePlugin(runGate: GateRunner = runAdapter): OpenCodePlugin {
  return async ({ client, directory }) => ({
    "tool.execute.after": async (input, output) => {
      const tool = mappedTool(input.tool);
      if (!tool) return;
      const reason = await runGate({
        event: "PostToolUse",
        sessionID: input.sessionID,
        directory,
        tool,
        file: editedFile(input.args),
      });
      if (reason) output.output += `\n\ncomplexity-gate feedback:\n${reason}`;
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle" || !event.properties?.sessionID) return;
      const reason = await runGate({
        event: "Stop",
        sessionID: event.properties.sessionID,
        directory,
      });
      if (!reason) return;
      await client.session.promptAsync({
        path: { id: event.properties.sessionID },
        query: { directory },
        body: { parts: [{ type: "text", text: reason }] },
      });
    },
  });
}
