import { describe, expect, it } from "vitest";
import { decideGate } from "../extensions/gates.ts";

describe("decideGate — plan-only", () => {
  it("blocks git push", () => {
    expect(decideGate("plan-only", "git push origin main").block).toBe(true);
  });

  it("blocks git push with a leading env var assignment", () => {
    expect(decideGate("plan-only", "VAR=1 git push origin main").block).toBe(true);
  });

  it("blocks git commit inside an && chain", () => {
    expect(decideGate("plan-only", "cd x && git commit -m hi").block).toBe(true);
  });

  it("blocks gh pr create", () => {
    expect(decideGate("plan-only", "gh pr create --title foo").block).toBe(true);
  });

  it("allows plain builds", () => {
    expect(decideGate("plan-only", "npm run build").block).toBe(false);
  });

  it("allows git status", () => {
    expect(decideGate("plan-only", "git status").block).toBe(false);
  });

  it("allows git diff", () => {
    expect(decideGate("plan-only", "git diff HEAD~1").block).toBe(false);
  });

  it("includes a reason naming the verb and how to unblock", () => {
    const decision = decideGate("plan-only", "git push");
    expect(decision.reason).toContain("git push");
    expect(decision.reason).toContain("/mode local or ship");
  });
});

describe("decideGate — local", () => {
  it("blocks git push", () => {
    expect(decideGate("local", "git push origin main").block).toBe(true);
  });

  it("blocks gh pr merge", () => {
    expect(decideGate("local", "gh pr merge 42").block).toBe(true);
  });

  it("allows git commit", () => {
    expect(decideGate("local", "git commit -m hi").block).toBe(false);
  });
});

describe("decideGate — ship", () => {
  it("allows git push", () => {
    expect(decideGate("ship", "git push origin main").block).toBe(false);
  });

  it("allows gh pr merge", () => {
    expect(decideGate("ship", "gh pr merge 42").block).toBe(false);
  });
});

describe("decideGate — catastrophic rm -rf, all modes", () => {
  for (const mode of ["plan-only", "local", "ship"] as const) {
    it(`blocks rm -rf / in ${mode} mode`, () => {
      expect(decideGate(mode, "rm -rf /").block).toBe(true);
    });

    it(`allows rm -rf ./node_modules in ${mode} mode`, () => {
      expect(decideGate(mode, "rm -rf ./node_modules").block).toBe(false);
    });

    it(`allows rm -rf /tmp/foo in ${mode} mode`, () => {
      expect(decideGate(mode, "rm -rf /tmp/foo").block).toBe(false);
    });
  }
});
