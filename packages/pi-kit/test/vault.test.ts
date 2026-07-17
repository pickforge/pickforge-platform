import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendPromotion } from "../extensions/vault.ts";

describe("appendPromotion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pikit-vault-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file with a header when missing", () => {
    const path = appendPromotion(dir, "first claim", "pi session /tmp/x");
    const content = readFileSync(path, "utf8");
    expect(content.startsWith("# Review queue\n")).toBe(true);
    expect(content).toContain("- claim: first claim");
    expect(content).toContain("- source: pi session /tmp/x");
    expect(content).toContain("- status: pending review");
  });

  it("appends without clobbering existing content", () => {
    const path1 = appendPromotion(dir, "first claim", "src-1");
    const path2 = appendPromotion(dir, "second claim", "src-2");
    expect(path1).toBe(path2);

    const content = readFileSync(path2, "utf8");
    expect(content).toContain("- claim: first claim");
    expect(content).toContain("- claim: second claim");
  });

  it("accumulates multiple entries across repeated calls", () => {
    appendPromotion(dir, "claim a", "src-a");
    appendPromotion(dir, "claim b", "src-b");
    appendPromotion(dir, "claim c", "src-c");

    const content = readFileSync(join(dir, "REVIEW_QUEUE.md"), "utf8");
    const claimCount = (content.match(/- claim:/g) ?? []).length;
    expect(claimCount).toBe(3);
    expect(content).toContain("- claim: claim a");
    expect(content).toContain("- claim: claim b");
    expect(content).toContain("- claim: claim c");
  });

  it("preserves manually added content in the file", () => {
    appendPromotion(dir, "first claim", "src-1");
    const path = join(dir, "REVIEW_QUEUE.md");
    const before = readFileSync(path, "utf8");
    // simulate a human edit between promotions
    const withNote = `${before}\n<!-- reviewer note -->\n`;
    writeFileSync(path, withNote, "utf8");

    appendPromotion(dir, "second claim", "src-2");
    const after = readFileSync(path, "utf8");
    expect(after).toContain("<!-- reviewer note -->");
    expect(after).toContain("- claim: second claim");
  });
});
