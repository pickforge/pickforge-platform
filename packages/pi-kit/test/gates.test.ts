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

describe("decideGate — review regressions", () => {
  it("blocks git -C <dir> push in plan-only", () => {
    expect(decideGate("plan-only", "git -C /some/repo push origin main").block).toBe(true);
  });

  it("blocks git --git-dir=.git push in local", () => {
    expect(decideGate("local", "git --git-dir=.git push").block).toBe(true);
  });

  it("blocks git -c user.name=x commit in plan-only", () => {
    expect(decideGate("plan-only", "git -c user.name=x commit -m hi").block).toBe(true);
  });

  it("allows git merge-base in plan-only", () => {
    expect(decideGate("plan-only", "git merge-base main HEAD").block).toBe(false);
  });

  it("allows git push-to-checkout style subcommands only when not blocked verbs", () => {
    expect(decideGate("local", "git push-to-checkout").block).toBe(false);
  });

  it("blocks absolute-path git binary push in local", () => {
    expect(decideGate("local", "/usr/bin/git push").block).toBe(true);
  });

  for (const mode of ["plan-only", "local", "ship"] as const) {
    it(`blocks rm -r / (no force) in ${mode}`, () => {
      expect(decideGate(mode, "rm -r /").block).toBe(true);
    });

    it(`blocks rm -rf /* in ${mode}`, () => {
      expect(decideGate(mode, "rm -rf /*").block).toBe(true);
    });

    it(`blocks rm --recursive $HOME/* in ${mode}`, () => {
      expect(decideGate(mode, "rm --recursive $HOME/*").block).toBe(true);
    });
  }

  it("still allows plain recursive rm on a project path chained after build", () => {
    expect(decideGate("plan-only", "bun run build && rm -rf dist && mkdir dist").block).toBe(false);
  });
});
