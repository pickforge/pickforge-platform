import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = join(import.meta.dirname, "..");

describe("@pickforge/brand CSS exports", () => {
  it("exports every CSS entry", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };

    for (const target of Object.values(packageJson.exports)) {
      expect(readFileSync(join(packageRoot, target), "utf8").trim()).not.toHaveLength(0);
    }
  });

  it("exports the shared app chrome and keeps it token-only", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(packageJson.exports).toHaveProperty("./chrome.css", "./src/chrome.css");

    const chrome = readFileSync(join(packageRoot, "src/chrome.css"), "utf8");
    for (const selector of [".pf-titlebar", ".pf-mark", ".pf-winctl", ".pf-resize", ".pf-statusbar"]) {
      expect(chrome).toContain(selector);
    }
    expect(chrome).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(chrome).not.toMatch(/^\s*@import\b/m);
  });

  it("keeps canonical prefixed tokens and unprefixed compatibility tokens", () => {
    const tokens = readFileSync(join(packageRoot, "src/tokens.css"), "utf8");
    const compat = readFileSync(join(packageRoot, "src/compat-unprefixed.css"), "utf8");

    expect(tokens).toContain("--pf-ember: #ff7a1a");
    expect(tokens).toContain("--pf-surface: #0a0a0b");
    expect(compat).toContain("--ember: var(--pf-ember)");
    expect(compat).toContain("--surface: var(--pf-surface)");
  });
});
