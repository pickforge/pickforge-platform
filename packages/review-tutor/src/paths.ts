import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
