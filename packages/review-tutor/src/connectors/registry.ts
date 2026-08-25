import { execFile } from "node:child_process";
import type { ReviewTutorFlags } from "../flags.ts";
import { ClaudeCodeConnector } from "./claude-code.ts";
import { PiConnector } from "./pi.ts";
import type {
  Discovery,
  DiscoveryDeps,
  HarnessConnector,
  HarnessId,
  ModelChoice,
} from "./types.ts";

export interface ConnectorRegistry {
  connectors(): HarnessConnector[];
  byId(id: string): HarnessConnector | undefined;
  resolve(modelId: string): { connector: HarnessConnector; model: string } | undefined;
  discoveries(): Promise<Array<{ connector: HarnessConnector; discovery: Discovery }>>;
}

function which(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { encoding: "utf8", shell: false }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
}

export function createConnectorRegistry(options: {
  flags: ReviewTutorFlags;
  piModels: ModelChoice[];
  piVersion?: string;
  which?: DiscoveryDeps["which"];
}): ConnectorRegistry {
  const pi = new PiConnector();
  const optionalConnectors: HarnessConnector[] = [new ClaudeCodeConnector()];
  const dependencies: DiscoveryDeps = {
    piModels: options.piModels,
    ...(options.piVersion ? { piVersion: options.piVersion } : {}),
    which: options.which ?? which,
  };

  const connectors = (): HarnessConnector[] => [
    pi,
    ...(options.flags.isEnabled("reviewTutorHarnessConnectors") ? optionalConnectors : []),
  ];

  return {
    connectors,
    byId(id) {
      return connectors().find((connector) => connector.id === id);
    },
    resolve(modelId) {
      const { harness, model } = splitModelId(modelId);
      const connector = this.byId(harness as HarnessId);
      return connector ? { connector, model } : undefined;
    },
    async discoveries() {
      return Promise.all(connectors().map(async (connector) => ({
        connector,
        discovery: await connector.discover(dependencies),
      })));
    },
  };
}

// A harness namespace is the text before the first ":" only when that ":" precedes any "/"; provider ids may contain ":".
export function splitModelId(modelId: string): { harness: string; model: string } {
  const separator = modelId.indexOf(":");
  const slash = modelId.indexOf("/");
  const namespaced = separator >= 0 && (slash < 0 || separator < slash);
  return namespaced
    ? { harness: modelId.slice(0, separator), model: modelId.slice(separator + 1) }
    : { harness: "pi", model: modelId };
}
