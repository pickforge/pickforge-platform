const CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_ADDRESS",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_NAME",
  "LC_PAPER",
  "LC_TELEPHONE",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_DIRS",
] as const;

export function createChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}
