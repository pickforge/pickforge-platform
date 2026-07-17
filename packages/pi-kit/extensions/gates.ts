/**
 * pi-kit delivery-mode gate — blocks bash commands per the active delivery mode.
 *
 * Modes:
 *  - "plan-only": blocks any git/gh command that commits or ships (commit, push, merge, pr create/merge).
 *  - "local"    : allows local commits, blocks anything that reaches a remote (push, pr merge).
 *  - "ship"     : no delivery-mode blocking.
 * All modes always block catastrophic `rm -rf` targeting `/`, `~`, `$HOME`, or `*`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

export type DeliveryMode = "plan-only" | "local" | "ship";

export interface GateDecision {
  block: boolean;
  reason?: string;
}

interface BlockRule {
  pattern: RegExp;
  verb: string;
}

const PLAN_ONLY_BLOCKED: BlockRule[] = [
  { pattern: /\bgit\s+push\b/i, verb: "git push" },
  { pattern: /\bgit\s+merge\b/i, verb: "git merge" },
  { pattern: /\bgit\s+commit\b/i, verb: "git commit" },
  { pattern: /\bgh\s+pr\s+create\b/i, verb: "gh pr create" },
  { pattern: /\bgh\s+pr\s+merge\b/i, verb: "gh pr merge" },
];

const LOCAL_BLOCKED: BlockRule[] = [
  { pattern: /\bgit\s+push\b/i, verb: "git push" },
  { pattern: /\bgh\s+pr\s+merge\b/i, verb: "gh pr merge" },
];

/** Bare tokens that make `rm -rf <target>` catastrophic — never a subpath like /tmp/foo or ./node_modules. */
const DANGEROUS_RM_TARGETS: Record<string, true> = { "/": true, "~": true, "~/": true, $HOME: true, "$HOME/": true, "*": true };

function isCatastrophicRm(command: string): boolean {
  for (const raw of command.split(/&&|\|\||[;|]/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    const rmIndex = tokens.findIndex((t) => t === "rm" || /(?:^|\/)rm$/.test(t));
    if (rmIndex === -1) continue;

    let hasRecursive = false;
    let hasForce = false;
    let hasDangerousTarget = false;
    for (const arg of tokens.slice(rmIndex + 1)) {
      const stripped = arg.replace(/^["']|["']$/g, "");
      if (/^--recursive$/i.test(stripped)) hasRecursive = true;
      else if (/^--force$/i.test(stripped)) hasForce = true;
      else if (/^-[a-z]+$/i.test(stripped)) {
        if (/r/i.test(stripped)) hasRecursive = true;
        if (/f/i.test(stripped)) hasForce = true;
      } else if (DANGEROUS_RM_TARGETS[stripped]) {
        hasDangerousTarget = true;
      }
    }
    if (hasRecursive && hasForce && hasDangerousTarget) return true;
  }
  return false;
}

/** Pure gate decision — kept separate from extension wiring so it's directly testable. */
export function decideGate(mode: DeliveryMode, command: string): GateDecision {
  if (isCatastrophicRm(command)) {
    return { block: true, reason: "catastrophic rm -rf blocked in all modes" };
  }

  const rules = mode === "plan-only" ? PLAN_ONLY_BLOCKED : mode === "local" ? LOCAL_BLOCKED : [];
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      return {
        block: true,
        reason: `delivery mode ${mode} blocks ${rule.verb}; /mode local or ship to allow`,
      };
    }
  }
  return { block: false };
}

export default function (pi: ExtensionAPI) {
  let mode: DeliveryMode = "local";

  pi.registerCommand("mode", {
    description: "Show or set the delivery-mode gate (plan-only | local | ship)",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (!arg) {
        ctx.ui.notify(`mode: ${mode}`, "info");
        return;
      }
      if (arg !== "plan-only" && arg !== "local" && arg !== "ship") {
        ctx.ui.notify("usage: /mode <plan-only|local|ship>", "error");
        return;
      }
      mode = arg;
      ctx.ui.notify(`mode: ${mode}`, "info");
      ctx.ui.setStatus("mode", mode === "local" ? undefined : `mode: ${mode}`);
      try {
        pi.appendEntry("pikit-mode", { mode });
      } catch {
        // best effort — session persistence is not load-bearing for the gate itself
      }
    },
  });

  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;
    if (typeof command !== "string") return undefined;

    const decision = decideGate(mode, command);
    if (decision.block) {
      return { block: true, reason: decision.reason };
    }
    return undefined;
  });
}
