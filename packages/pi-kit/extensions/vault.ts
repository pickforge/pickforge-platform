/**
 * pi-kit /promote — append a pending claim to the curated-memory review queue.
 * Never overwrites; appends only, creating the file (with header) on first use.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REVIEW_QUEUE_HEADER = "# Review queue\n";
const REVIEW_QUEUE_FILENAME = "REVIEW_QUEUE.md";
const VAULT_DIR_ENV = "PIKIT_VAULT_DIR";
const DEFAULT_VAULT_DIR = "/home/dev/AgentMemory";

/** Pure append — creates the file with a header when missing, otherwise appends. Returns the written path. */
export function appendPromotion(dir: string, text: string, source: string): string {
  const path = `${dir}/${REVIEW_QUEUE_FILENAME}`;
  mkdirSync(dirname(path), { recursive: true });

  const block = `\n## ${new Date().toISOString()} pending\n- claim: ${text}\n- source: ${source}\n- status: pending review\n`;
  if (!existsSync(path)) {
    writeFileSync(path, REVIEW_QUEUE_HEADER + block, "utf8");
    return path;
  }
  const existing = readFileSync(path, "utf8");
  writeFileSync(path, existing + block, "utf8");
  return path;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("promote", {
    description: "Promote a claim to the curated-memory review queue",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify("usage: /promote <claim text>", "error");
        return;
      }

      const dir = process.env[VAULT_DIR_ENV] ?? DEFAULT_VAULT_DIR;
      const sessionId = ctx.sessionManager.getSessionFile();
      const source = sessionId ? `pi session ${sessionId}` : `pi session (cwd: ${ctx.cwd})`;

      const path = appendPromotion(dir, text, source);
      ctx.ui.notify(`promoted to ${path}`, "info");
    },
  });
}
