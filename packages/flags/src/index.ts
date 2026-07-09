export interface FlagDefinition {
  description: string;
  /** Ship-time default; omitted means false. Launch flip = change this in code and release. */
  default?: boolean;
}

export interface FlagState {
  key: string;
  description: string;
  defaultValue: boolean;
  override: boolean | undefined;
  enabled: boolean;
}

/** App-supplied persistence for overrides (e.g. settings storage). */
export interface FlagOverrideStore {
  get(key: string): boolean | undefined;
  set(key: string, value: boolean | undefined): void;
}

export interface Flags<K extends string> {
  isEnabled(key: K): boolean;
  setOverride(key: K, value: boolean | undefined): void;
  /** Settings/debug surface: every flag in definition order with its effective state. */
  list(): FlagState[];
  /** Notify on any override change. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function createFlags<const D extends Record<string, FlagDefinition>>(
  definitions: D,
  options?: { store?: FlagOverrideStore },
): Flags<Extract<keyof D, string>> {
  type Key = Extract<keyof D, string>;

  const keys = Object.keys(definitions) as Key[];
  const keySet = new Set<string>(keys);
  const store = options?.store ?? createMemoryStore();
  const listeners = new Set<() => void>();

  const assertKnownKey = (key: Key): void => {
    if (!keySet.has(key)) {
      throw new TypeError(`Unknown flag key: ${key}`);
    }
  };

  const getDefinition = (key: Key): FlagDefinition => definitions[key] as FlagDefinition;

  const getDefaultValue = (key: Key): boolean => getDefinition(key).default === true;

  const getOverride = (key: Key): boolean | undefined => {
    const value = store.get(key);

    return typeof value === "boolean" ? value : undefined;
  };

  return {
    isEnabled(key) {
      assertKnownKey(key);

      const override = getOverride(key);

      return override ?? getDefaultValue(key);
    },
    setOverride(key, value) {
      assertKnownKey(key);
      store.set(key, value);

      for (const listener of listeners) {
        listener();
      }
    },
    list() {
      return keys.map((key) => {
        const definition = getDefinition(key);
        const defaultValue = definition.default === true;
        const override = getOverride(key);

        return {
          key,
          description: definition.description,
          defaultValue,
          override,
          enabled: override ?? defaultValue,
        };
      });
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function createMemoryStore(): FlagOverrideStore {
  const overrides = new Map<string, boolean>();

  return {
    get(key) {
      return overrides.get(key);
    },
    set(key, value) {
      if (value === undefined) {
        overrides.delete(key);
        return;
      }

      overrides.set(key, value);
    },
  };
}
