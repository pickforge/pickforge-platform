import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Both loaders sit exactly one directory below the package root: Pi imports
 * `src/paths.ts` from TS source and the built CLI bundles this file into
 * `dist/cli.js`, so one `..` reaches the shipped skill from either location.
 */
export function defaultSkillPath(): string {
  return fileURLToPath(new URL("../skills/review-tutor/SKILL.md", import.meta.url));
}

export interface StatePaths {
  root: string;
  projectKey: string;
  projectDir: string;
  projectFile: string;
  logFile: string;
  inputsDir: string;
}

export function resolveStatePaths(
  canonicalRepo: string,
  override = process.env.REVIEW_TUTOR_HOME,
): StatePaths {
  if (override !== undefined && (!override.trim() || !isAbsolute(override))) {
    throw new Error(
      "state path failed: expected REVIEW_TUTOR_HOME to be a non-empty absolute path; correct or unset it and retry",
    );
  }
  const root = override ?? join(homedir(), ".pickforge", "review-tutor");
  const projectKey = createHash("sha256").update(canonicalRepo).digest("hex");
  const projectDir = join(root, "projects", projectKey);
  return {
    root,
    projectKey,
    projectDir,
    projectFile: join(projectDir, "project.json"),
    logFile: join(projectDir, "log.jsonl"),
    inputsDir: join(projectDir, "inputs"),
  };
}
