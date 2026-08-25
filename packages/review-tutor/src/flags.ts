import {
  createFlags,
  type FlagOverrideStore,
  type Flags,
} from "@pickforge/flags";

const definitions = {
  reviewTutorHarnessConnectors: {
    description: "Show Claude Code and Codex harness connectors in Review Tutor",
    default: false,
  },
} as const;

export type ReviewTutorFlag = keyof typeof definitions;
export type ReviewTutorFlags = Flags<ReviewTutorFlag>;

function environmentStore(value = process.env.REVIEW_TUTOR_FLAGS): FlagOverrideStore {
  const enabled = new Set((value ?? "").split(",").map((key) => key.trim()).filter(Boolean));
  const overrides = new Map<string, boolean>();
  for (const key of Object.keys(definitions)) {
    if (enabled.has(key)) overrides.set(key, true);
  }
  return {
    get: (key) => overrides.get(key),
    set(key, next) {
      if (next === undefined) overrides.delete(key);
      else overrides.set(key, next);
    },
  };
}

export function createReviewTutorFlags(store?: FlagOverrideStore): ReviewTutorFlags {
  return createFlags(definitions, { store: store ?? environmentStore() });
}
