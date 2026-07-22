#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLaneMcpServer } from "./create-server.ts";

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown error";
}

async function main(): Promise<void> {
  const { server, coordinator } = createLaneMcpServer();
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  let reported = false;

  const shutdown = (reason: string): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        let firstError: unknown;
        try {
          await coordinator.shutdown(reason);
        } catch (error) {
          firstError = error;
        }
        try {
          await server.close();
        } catch (error) {
          firstError ??= error;
        }
        if (firstError !== undefined) throw firstError;
      })();
    }
    return shutdownPromise;
  };

  const requestShutdown = (reason: string): void => {
    void shutdown(reason).catch((error) => {
      if (!reported) {
        reported = true;
        console.error(`pickforge-lanes-mcp: ${boundedError(error)}`);
      }
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", () => requestShutdown("received SIGINT"));
  process.once("SIGTERM", () => requestShutdown("received SIGTERM"));
  process.stdin.once("end", () => requestShutdown("stdin ended"));
  process.stdin.once("close", () => requestShutdown("stdin closed"));
  server.server.onclose = () => requestShutdown("transport closed");

  try {
    await server.connect(transport);
  } catch (error) {
    await shutdown("transport startup failed");
    throw error;
  }
}

void main().catch((error) => {
  console.error(`pickforge-lanes-mcp: ${boundedError(error)}`);
  process.exitCode = 1;
});
