import type { ReviewTutorFlags } from "../flags.ts";
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
  discover(connector: HarnessConnector): Promise<Discovery>;
}

export function createConnectorRegistry(options: {
  flags: ReviewTutorFlags;
  piModels: ModelChoice[];
  piVersion?: string;
}): ConnectorRegistry {
  const pi = new PiConnector();
  const optionalConnectors: HarnessConnector[] = [];
  const dependencies: DiscoveryDeps = {
    piModels: options.piModels,
    ...(options.piVersion ? { piVersion: options.piVersion } : {}),
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
      const separator = modelId.indexOf(":");
      const harness = separator < 0 ? "pi" : modelId.slice(0, separator);
      const connector = this.byId(harness as HarnessId);
      if (!connector) return undefined;
      return { connector, model: separator < 0 ? modelId : modelId.slice(separator + 1) };
    },
    discover(connector) {
      return connector.discover(dependencies);
    },
  };
}
