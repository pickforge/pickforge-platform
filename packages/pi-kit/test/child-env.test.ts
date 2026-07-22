import { describe, expect, it } from "vitest";
import { createChildEnvironment } from "../src/child-env.ts";

describe("createChildEnvironment", () => {
  it("keeps only the minimal runtime allowlist", () => {
    const environment = createChildEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/lane",
      USER: "lane",
      LOGNAME: "lane",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp/lane",
      LANG: "en_US.UTF-8",
      LANGUAGE: "en_US",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "pi",
      TERM_PROGRAM_VERSION: "1.0",
      XDG_CONFIG_HOME: "/home/lane/.config",
      XDG_CACHE_HOME: "/home/lane/.cache",
      XDG_DATA_HOME: "/home/lane/.local/share",
      XDG_STATE_HOME: "/home/lane/.local/state",
      XDG_RUNTIME_DIR: "/tmp/lane-runtime",
      OPENAI_API_KEY: "sentinel-key",
      ANTHROPIC_AUTH_TOKEN: "sentinel-auth",
      COOKIE: "sentinel-cookie",
      AWS_ACCESS_KEY_ID: "sentinel-aws",
      GOOGLE_APPLICATION_CREDENTIALS: "/sentinel/gcp.json",
      AZURE_CLIENT_SECRET: "sentinel-azure",
      SSH_AUTH_SOCK: "/sentinel/agent.sock",
    });

    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/lane",
      USER: "lane",
      LOGNAME: "lane",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp/lane",
      LANG: "en_US.UTF-8",
      LANGUAGE: "en_US",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "pi",
      TERM_PROGRAM_VERSION: "1.0",
      XDG_CONFIG_HOME: "/home/lane/.config",
      XDG_CACHE_HOME: "/home/lane/.cache",
      XDG_DATA_HOME: "/home/lane/.local/share",
      XDG_STATE_HOME: "/home/lane/.local/state",
      XDG_RUNTIME_DIR: "/tmp/lane-runtime",
    });
    expect(Object.values(environment).some((value) => value?.startsWith("sentinel"))).toBe(false);
  });
});
