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

const GIT_BLOCKED: Record<DeliveryMode, Record<string, true>> = {
  "plan-only": { push: true, merge: true, commit: true },
  local: { push: true },
  ship: {},
};

const GH_PR_BLOCKED: Record<DeliveryMode, Record<string, true>> = {
  "plan-only": { create: true, merge: true },
  local: { merge: true },
  ship: {},
};

/** git global options that consume a following argument. */
const GIT_OPT_WITH_ARG: Record<string, true> = {
  "-C": true,
  "-c": true,
  "--git-dir": true,
  "--work-tree": true,
  "--namespace": true,
  "--exec-path": true,
};

/** Bare tokens that make a recursive rm catastrophic — never a subpath like /tmp/foo or ./node_modules. */
const DANGEROUS_RM_TARGETS: Record<string, true> = {
  "/": true,
  "/*": true,
  "~": true,
  "~/": true,
  "~/*": true,
  $HOME: true,
  "$HOME/": true,
  "$HOME/*": true,
  "*": true,
};

/** Resolve the effective subcommand after git's global options. */
function gitSubcommand(tokens: string[], gitIndex: number): string | undefined {
  let i = gitIndex + 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (GIT_OPT_WITH_ARG[t]) {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    return t;
  }
  return undefined;
}

/** Split a shell command into chained sub-commands and tokenize, dropping leading env assignments. */
function subCommands(command: string): string[][] {
  const out: string[][] = [];
  for (const raw of command.split(/&&|\|\||[;|]/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    let start = 0;
    while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!)) start++;
    if (start < tokens.length) out.push(tokens.slice(start));
  }
  return out;
}

function isCatastrophicRm(tokens: string[]): boolean {
  const rmIndex = tokens.findIndex((t) => t === "rm" || /(?:^|\/)rm$/.test(t));
  if (rmIndex === -1) return false;

  let hasRecursive = false;
  let hasDangerousTarget = false;
  for (const arg of tokens.slice(rmIndex + 1)) {
    const stripped = arg.replace(/^["']|["']$/g, "");
    if (/^--recursive$/i.test(stripped)) hasRecursive = true;
    else if (/^-[a-z]+$/i.test(stripped)) {
      if (/r/i.test(stripped)) hasRecursive = true;
    } else if (DANGEROUS_RM_TARGETS[stripped]) {
      hasDangerousTarget = true;
    }
  }
  return hasRecursive && hasDangerousTarget;
}

/** Pure gate decision — kept separate from extension wiring so it's directly testable. */
export function decideGate(mode: DeliveryMode, command: string): GateDecision {
  for (const tokens of subCommands(command)) {
    if (isCatastrophicRm(tokens)) {
      return { block: true, reason: "catastrophic recursive rm blocked in all modes" };
    }

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === "git" || /(?:^|\/)git$/.test(t)) {
        const sub = gitSubcommand(tokens, i);
        if (sub && GIT_BLOCKED[mode][sub]) {
          return { block: true, reason: `delivery mode ${mode} blocks git ${sub}; /mode local or ship to allow` };
        }
      } else if (t === "gh" || /(?:^|\/)gh$/.test(t)) {
        const rest = tokens.slice(i + 1).filter((tok) => !tok.startsWith("-"));
        if (rest[0] === "pr" && rest[1] && GH_PR_BLOCKED[mode][rest[1]]) {
          return { block: true, reason: `delivery mode ${mode} blocks gh pr ${rest[1]}; /mode local or ship to allow` };
        }
      }
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
