import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import type { ExecFile } from "../src/inputs.ts";
import type { InputSnapshot, StructureEdge, StructureSnapshot } from "../src/protocol.ts";
import { startReviewTutorServer } from "../src/server.ts";
import {
  buildStructureSnapshot, maskLiterals, parseUnifiedDiff, structureSnapshotFor, structureSnapshotWithNeighbours,
} from "../src/structure.ts";

const skillPath = fileURLToPath(new URL("../skills/review-tutor/SKILL.md", import.meta.url));
const temporaryRoots: string[] = [];
const registry = () => createConnectorRegistry({
  which: async () => undefined,
  execFile: async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); },
  piModels: [{ id: "provider/model", label: "Model", thinkingLevels: ["low"] }],
});

afterEach(async () => {
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function input(content: string, kind: InputSnapshot["kind"] = "worktree"): InputSnapshot {
  return {
    id: "input-1",
    kind,
    label: kind === "pr" ? "#7 Example by dev" : "Local worktree diff",
    digest: "digest",
    byteCount: Buffer.byteLength(content),
    content,
  };
}

function edgesFrom(snapshot: StructureSnapshot, from: string): StructureEdge[] {
  return snapshot.edges.filter((edge) => edge.from === from);
}

function edge(snapshot: StructureSnapshot, from: string, to: string): StructureEdge | undefined {
  return snapshot.edges.find((candidate) => candidate.from === from && candidate.to === to);
}

const RENAME_DIFF = `diff --git a/src/helper.ts b/src/helper.ts
index 1111111..2222222 100644
--- a/src/helper.ts
+++ b/src/helper.ts
@@ -1,2 +1,2 @@
-export const helper = (value: number) => value;
+export const helper = (value: number): number => value;

diff --git a/src/config/index.ts b/src/config/index.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/config/index.ts
@@ -0,0 +1,2 @@
+export interface Config { name: string }
+export const defaults: Config = { name: "review" };
diff --git a/src/mixed.ts b/src/mixed.ts
index 4444444..5555555 100644
--- a/src/mixed.ts
+++ b/src/mixed.ts
@@ -1,2 +1,2 @@
-export type Mixed = string;
+export type Mixed = string | number;
 export const value = 1;
diff --git a/src/old-name.ts b/src/renamed.ts
similarity index 88%
rename from src/old-name.ts
rename to src/renamed.ts
index 6666666..7777777 100644
--- a/src/old-name.ts
+++ b/src/renamed.ts
@@ -1,4 +1,5 @@
 import { helper } from "./helper.js";
+import type { Config } from "./config";
 import { type Mixed, value } from "./mixed.ts";

 export const total = helper(value);
`;

describe("diff parsing", () => {
  it("tracks renames, statuses, and line counts", () => {
    const parsed = parseUnifiedDiff(RENAME_DIFF);
    expect(parsed.reasons).toEqual([]);
    expect(parsed.files.map((file) => `${file.path}:${file.status}`)).toEqual([
      "src/helper.ts:modified",
      "src/config/index.ts:added",
      "src/mixed.ts:modified",
      "src/renamed.ts:renamed",
    ]);
    const renamed = parsed.files.at(-1)!;
    expect(renamed.oldPath).toBe("src/old-name.ts");
    expect(renamed.additions).toBe(1);
    expect(parsed.files[0]!.additions).toBe(1);
    expect(parsed.files[0]!.deletions).toBe(1);
  });

  it("reports a malformed diff as a partial snapshot instead of throwing", () => {
    const snapshot = buildStructureSnapshot(input("this is not a diff at all\njust prose\n"));
    expect(snapshot.files).toEqual([]);
    expect(snapshot.comparison.partial).toBe(true);
    expect(snapshot.comparison.reasons[0]).toContain("diff parse failed: expected unified diff file headers");
  });
});

describe("connection analysis", () => {
  const snapshot = buildStructureSnapshot(input(RENAME_DIFF));

  it("keeps rename provenance on the file entry", () => {
    const renamed = snapshot.files.find((file) => file.path === "src/renamed.ts")!;
    expect(renamed.status).toBe("renamed");
    expect(renamed.renamedFrom).toBe("src/old-name.ts");
    expect(renamed.analyzed).toBe(true);
  });

  it("resolves a .js specifier to the .ts file under bundler conventions", () => {
    const found = edge(snapshot, "src/renamed.ts", "src/helper.ts")!;
    expect(found.specifier).toBe("./helper.js");
    expect(found.kind).toBe("import");
    expect(found.status).toBe("unchanged");
    expect(found.evidence).toEqual([
      { path: "src/renamed.ts", line: 1, text: "import { helper } from \"./helper.js\";" },
    ]);
  });

  it("resolves an extensionless specifier through a directory index and marks type-only imports", () => {
    const found = edge(snapshot, "src/renamed.ts", "src/config/index.ts")!;
    expect(found.typeOnly).toBe(true);
    expect(found.status).toBe("added");
    expect(found.evidence[0]!.line).toBe(2);
  });

  it("treats an inline type specifier inside a value import as a value edge", () => {
    const found = edge(snapshot, "src/renamed.ts", "src/mixed.ts")!;
    expect(found.typeOnly).toBe(false);
    expect(found.status).toBe("unchanged");
  });

  it("stays complete for a Git worktree comparison", () => {
    expect(snapshot.comparison).toMatchObject({ kind: "worktree", partial: false, reasons: [] });
    expect(snapshot.limits.truncated).toBe(false);
  });
});

const KINDS_DIFF = `diff --git a/src/target.ts b/src/target.ts
--- a/src/target.ts
+++ b/src/target.ts
@@ -1 +1,2 @@
 export const target = 1;
+export const extra = 2;
diff --git a/src/legacy.js b/src/legacy.js
--- a/src/legacy.js
+++ b/src/legacy.js
@@ -1 +1,2 @@
 module.exports = { legacy: true };
+module.exports.more = true;
diff --git a/src/entry.ts b/src/entry.ts
--- a/src/entry.ts
+++ b/src/entry.ts
@@ -1,10 +1,16 @@
 import "./target.ts";
+import { target } from "./target.ts";
 export { target as reexported } from "./target.ts";
+export type { Target } from "./target.ts";
 const legacy = require("./legacy.js");
-const gone = require("./target.ts");
 const lazy = () => import("./target.ts");
 const dynamic = (name) => import(name);
 const built = require(\`./\${name}.js\`);
 import { readFile } from "node:fs/promises";
 import react from "react";
 import { missing } from "./not-in-diff.ts";
-// import { commented } from "./target.ts";
+const sample = "import { fake } from './target.ts'";
`;

describe("edge kinds and honest omissions", () => {
  const snapshot = buildStructureSnapshot(input(KINDS_DIFF));

  it("supports import, re-export, require, and dynamic-import edges", () => {
    const kinds = edgesFrom(snapshot, "src/entry.ts")
      .map((found) => `${found.kind}:${found.to}:${found.typeOnly}:${found.status}`);
    expect(kinds).toEqual([
      "require:src/legacy.js:false:unchanged",
      "dynamic-import:src/target.ts:false:unchanged",
      "import:src/target.ts:false:unchanged",
      "import:src/target.ts:false:added",
      "reexport:src/target.ts:false:unchanged",
      "reexport:src/target.ts:true:added",
      "require:src/target.ts:false:removed",
    ]);
  });

  it("keeps side-effect imports and merges duplicate statements per state", () => {
    const sideEffect = edgesFrom(snapshot, "src/entry.ts")
      .find((found) => found.kind === "import" && found.status === "unchanged")!;
    expect(sideEffect.specifier).toBe("./target.ts");
    expect(sideEffect.evidence).toHaveLength(1);
  });

  it("omits non-literal specifiers, external modules, and out-of-scope paths without inventing edges", () => {
    const reasons = snapshot.limits.omitted.map((omission) => `${omission.path ?? ""}|${omission.reason}`);
    expect(reasons).toContain("src/entry.ts|external modules (2): node:fs/promises, react");
    expect(reasons.filter((reason) => reason.includes("non-literal specifier"))).toHaveLength(2);
    expect(reasons).toContain("src/entry.ts|specifier './not-in-diff.ts' at line 11 matches no changed file: no import data outside the changed set");
    expect(snapshot.comparison.partial).toBe(true);
    expect(snapshot.comparison.reasons.some((reason) => reason.includes("no import data"))).toBe(true);
  });

  it("never reads an import out of a comment or a string literal", () => {
    expect(edgesFrom(snapshot, "src/entry.ts").some((found) => found.specifier === "./commented.ts")).toBe(false);
    expect(edgesFrom(snapshot, "src/entry.ts").some((found) => found.specifier === "./fake.ts")).toBe(false);
  });

  it("masks comments and string bodies while preserving offsets", () => {
    const source = "import a from \"./x\"; // import b from \"./y\"\n/* import c from \"./z\" */";
    const masked = maskLiterals(source);
    expect(masked).toHaveLength(source.length);
    expect(masked).toContain("import a from \"   \";");
    expect(masked.slice(20)).toMatch(/^[ \n]+$/);
  });
});

const REMOVAL_DIFF = `diff --git a/docs/guide.md b/docs/guide.md
--- a/docs/guide.md
+++ b/docs/guide.md
@@ -1 +1,2 @@
 # Guide
+import { fake } from "./nope.ts";
diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..8888888
Binary files /dev/null and b/assets/logo.png differ
diff --git a/src/dropped.ts b/src/dropped.ts
deleted file mode 100644
--- a/src/dropped.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-import { keep } from "./keep.ts";
-export const dropped = keep;
diff --git a/src/keep.ts b/src/keep.ts
--- a/src/keep.ts
+++ b/src/keep.ts
@@ -1 +1,2 @@
 export const keep = 1;
+export const other = 2;
`;

describe("unsupported inputs and deletions", () => {
  const snapshot = buildStructureSnapshot(input(REMOVAL_DIFF));

  it("marks binary and non-TypeScript files as unanalyzed with an explicit reason", () => {
    const markdown = snapshot.files.find((file) => file.path === "docs/guide.md")!;
    const binary = snapshot.files.find((file) => file.path === "assets/logo.png")!;
    expect(markdown.analyzed).toBe(false);
    expect(markdown.reason).toBe("unsupported file type '.md': no import data");
    expect(binary.analyzed).toBe(false);
    expect(binary.reason).toBe("binary content: no import data");
    expect(snapshot.edges.some((found) => found.from === "docs/guide.md")).toBe(false);
  });

  it("reports the imports of a deleted file as removed connections", () => {
    const found = edge(snapshot, "src/dropped.ts", "src/keep.ts")!;
    expect(found.status).toBe("removed");
    expect(found.evidence).toEqual([
      { path: "src/dropped.ts", line: 1, text: "import { keep } from \"./keep.ts\";" },
    ]);
    expect(snapshot.files.find((file) => file.path === "src/dropped.ts")!.status).toBe("removed");
  });
});

describe("source fidelity", () => {
  it("refuses to analyze pasted code", () => {
    const snapshot = buildStructureSnapshot(input("import a from \"./b.ts\";", "paste"));
    expect(snapshot.files).toEqual([]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.comparison.partial).toBe(true);
    expect(snapshot.comparison.reasons[0]).toContain("structure analysis is unavailable");
  });

  it("labels a pull-request snapshot as patch-only partial", () => {
    const snapshot = buildStructureSnapshot({ ...input(RENAME_DIFF, "pr"), headSha: "abc123" });
    expect(snapshot.comparison.partial).toBe(true);
    expect(snapshot.comparison.reasons[0]).toBe("patch-only: base and head objects are not read locally");
    expect(snapshot.edges.length).toBeGreaterThan(0);
  });

  it("states the compared endpoints for every source kind", () => {
    const endpoints = (snapshot: StructureSnapshot): string =>
      `${snapshot.comparison.from} -> ${snapshot.comparison.to}`;
    expect(endpoints(buildStructureSnapshot(input(RENAME_DIFF, "worktree")))).toBe("index -> working tree");
    expect(endpoints(buildStructureSnapshot(input(RENAME_DIFF, "staged")))).toBe("HEAD -> index");
    expect(endpoints(buildStructureSnapshot({ ...input(RENAME_DIFF, "commit"), label: "Commit 9fceb02" })))
      .toBe("first parent -> commit 9fceb02");
    expect(endpoints(buildStructureSnapshot({ ...input(RENAME_DIFF, "range"), label: "main...feature" })))
      .toBe("merge-base -> feature");
    expect(endpoints(buildStructureSnapshot({ ...input(RENAME_DIFF, "pr"), headSha: "abc123" })))
      .toBe("base -> head abc123");
    expect(endpoints(buildStructureSnapshot(input("code", "paste")))).toBe("unavailable -> unavailable");
  });
});

function generatedDiff(sources: number, targets: number, perSource: number): string {
  const parts: string[] = [];
  for (let index = 0; index < targets; index += 1) {
    parts.push(`diff --git a/src/t${index}.ts b/src/t${index}.ts\n--- a/src/t${index}.ts\n+++ b/src/t${index}.ts\n@@ -1 +1,2 @@\n export const t${index} = ${index};\n+export const extra${index} = ${index};\n`);
  }
  for (let index = 0; index < sources; index += 1) {
    const imports = Array.from({ length: perSource }, (_unused, offset) =>
      `+import { t${(index + offset) % targets} } from "./t${(index + offset) % targets}.ts";`).join("\n");
    parts.push(`diff --git a/src/s${index}.ts b/src/s${index}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/s${index}.ts\n@@ -0,0 +1,${perSource} @@\n${imports}\n`);
  }
  return parts.join("");
}

describe("resource limits and determinism", () => {
  it("returns a valid truncated snapshot when the file cap is exceeded", () => {
    const snapshot = buildStructureSnapshot(input(generatedDiff(150, 100, 2)));
    expect(snapshot.files).toHaveLength(200);
    expect(snapshot.limits.truncated).toBe(true);
    expect(snapshot.limits.omitted.some((omission) => omission.reason.includes("file cap reached"))).toBe(true);
    expect(snapshot.comparison.partial).toBe(true);
    expect(snapshot.files.map((file) => file.path)).toEqual([...snapshot.files.map((file) => file.path)].sort());
  });

  it("returns a valid truncated snapshot when the connection cap is exceeded", () => {
    const snapshot = buildStructureSnapshot(input(generatedDiff(100, 100, 21)));
    expect(snapshot.files).toHaveLength(200);
    expect(snapshot.edges).toHaveLength(2000);
    expect(snapshot.limits.truncated).toBe(true);
    expect(snapshot.limits.omitted.some((omission) => omission.reason.includes("connection cap reached"))).toBe(true);
  });

  it("bounds evidence per edge and merges duplicate statements", () => {
    const duplicates = `diff --git a/src/t.ts b/src/t.ts
--- a/src/t.ts
+++ b/src/t.ts
@@ -1 +1,2 @@
 export const t = 1;
+export const u = 2;
diff --git a/src/many.ts b/src/many.ts
new file mode 100644
--- /dev/null
+++ b/src/many.ts
@@ -0,0 +1,6 @@
+import { a } from "./t.ts";
+import { b } from "./t.ts";
+import { c } from "./t.ts";
+import { d } from "./t.ts";
+import { e } from "./t.ts";
+import { f } from "./t.ts";
`;
    const snapshot = buildStructureSnapshot(input(duplicates));
    const merged = edgesFrom(snapshot, "src/many.ts");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.evidence).toHaveLength(4);
    expect(merged[0]!.evidence.map((item) => item.line)).toEqual([1, 2, 3, 4]);
  });

  it("produces byte-identical JSON across runs", () => {
    const source = input(`${RENAME_DIFF}${KINDS_DIFF}${REMOVAL_DIFF}`);
    expect(JSON.stringify(buildStructureSnapshot(source))).toBe(JSON.stringify(buildStructureSnapshot(source)));
  });

  it("returns a valid snapshot for a diff whose hunk header is unusable", () => {
    const snapshot = structureSnapshotFor(input("diff --git a/a.ts b/a.ts\n@@ bad header @@\n+import x from \"./y\";\n"));
    expect(snapshot.protocol).toBe("rt/1");
    expect(snapshot.inputId).toBe("input-1");
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.comparison.reasons).toContain("malformed hunk header at diff line 2: no import data for that file");
    expect(snapshot.comparison.partial).toBe(true);
    expect(snapshot.files[0]!.reason).toBe("no diff content for this file: no import data");
  });

  it("degrades to a partial snapshot when the analyzer itself throws", () => {
    const hostile = {
      ...input(""),
      get content(): string { throw new Error("input content unavailable"); },
    } as InputSnapshot;
    const snapshot = structureSnapshotFor(hostile);
    expect(snapshot.protocol).toBe("rt/1");
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.comparison.partial).toBe(true);
    expect(snapshot.comparison.reasons[0]).toContain("structure analysis failed: expected a parsable unified diff");
    expect(snapshot.comparison.reasons[0]).toContain("input content unavailable");
  });
});

function changedFile(path: string, lines: string[], header = ""): string {
  const body = lines.map((line) => (line.startsWith("+") || line.startsWith("-") ? line : ` ${line}`)).join("\n");
  return `diff --git a/${path} b/${path}\n${header}--- a/${path}\n+++ b/${path}\n@@ -1,${lines.length} +1,${lines.length} @@\n${body}\n`;
}

describe("statements the lexer must not misread", () => {
  it("does not bind semicolon-free code to a later module string", () => {
    const diff = changedFile("src/plain.ts", ["export const value = 1"])
      + changedFile("src/free.ts", ["export const count = 1", "import { value } from \"./plain.ts\""]);
    const snapshot = buildStructureSnapshot(input(diff));
    const found = edgesFrom(snapshot, "src/free.ts");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "import", to: "src/plain.ts", specifier: "./plain.ts" });
    expect(found[0]!.evidence[0]!.line).toBe(2);
  });

  it("accepts every import clause shape", () => {
    const diff = changedFile("src/plain.ts", ["export const value = 1;"])
      + changedFile("src/shapes.ts", [
        "import plain from \"./plain.ts\";",
        "import * as everything from \"./plain.ts\";",
        "import defaultAndNamed, { value } from \"./plain.ts\";",
        "import {",
        "  value as renamed,",
        "} from \"./plain.ts\";",
      ]);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "src/shapes.ts")).toHaveLength(1);
    expect(edgesFrom(snapshot, "src/shapes.ts")[0]!.evidence).toHaveLength(4);
  });

  it("keeps long import clauses and reports the ones past the work bound", () => {
    const clause = (count: number): string =>
      `import { ${Array.from({ length: count }, (_unused, index) => `value as v${index}`).join(", ")} } from "./plain.ts";`;
    const short = clause(110);
    const long = clause(160);
    expect(short.length).toBeGreaterThan(1500);
    expect(short.length).toBeLessThan(2000);
    expect(long.length).toBeGreaterThan(2000);
    expect(long.length).toBeLessThan(4000);

    const kept = buildStructureSnapshot(input(
      changedFile("src/plain.ts", ["export const value = 1;"]) + changedFile("src/wide-clause.ts", [`+${short}`])));
    expect(edgesFrom(kept, "src/wide-clause.ts")).toHaveLength(1);
    expect(kept.limits.omitted).toEqual([]);

    const dropped = buildStructureSnapshot(input(
      changedFile("src/plain.ts", ["export const value = 1;"]) + changedFile("src/huge-clause.ts", [`+${long}`])));
    expect(edgesFrom(dropped, "src/huge-clause.ts")).toEqual([]);
    expect(dropped.limits.omitted).toContainEqual({
      path: "src/huge-clause.ts",
      reason: "import clause longer than 2000 characters at line 1: no import data for that statement",
    });
    expect(dropped.comparison.partial).toBe(true);
    expect(dropped.limits.truncated).toBe(true);
  });

  it("masks regex literals in expression positions but not division", () => {
    const diff = changedFile("src/plain.ts", ["export const value = 1;"])
      + changedFile("src/expressions.ts", [
        "function first() { return /import { fake } from \"\\.\\/plain.ts\"/; }",
        "const second = () => /import other from \"\\.\\/plain.ts\"/;",
        "const ratio = a / b / c;",
        "const half = y / 2; import { value } from \"./plain.ts\";",
      ]);
    const snapshot = buildStructureSnapshot(input(diff));
    const found = edgesFrom(snapshot, "src/expressions.ts");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ to: "src/plain.ts", specifier: "./plain.ts" });
    expect(found[0]!.evidence[0]!.line).toBe(4);
  });

  it("treats a keyword-named member before a slash as division", () => {
    const diff = changedFile("src/plain.ts", ["export const value = 1;"])
      + changedFile("src/members.ts", [
        "const scaled = obj.return / 2; import { value } from \"./plain.ts\";",
      ]);
    const found = edgesFrom(buildStructureSnapshot(input(diff)), "src/members.ts");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ to: "src/plain.ts", specifier: "./plain.ts" });
    expect(found[0]!.evidence[0]!.line).toBe(1);
  });

  it("rejects member calls separated by whitespace or newlines", () => {
    const diff = changedFile("src/t.ts", ["export const t = 1;"])
      + changedFile("src/spaced.ts", [
        "const loaded = shim . require(\"./t.ts\");",
        "const lazy = shim ?. import(\"./t.ts\");",
        "const wrapped = shim .",
        "  import(\"./t.ts\");",
      ]);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "src/spaced.ts")).toEqual([]);
    expect(snapshot.limits.omitted.filter((omission) => omission.path === "src/spaced.ts")).toEqual([]);
  });

  it("ignores imports inside regex literals and member calls", () => {
    const diff = changedFile("src/plain.ts", ["export const value = 1;"])
      + changedFile("src/tricky.ts", [
        "const pattern = /import { fake } from \"\\.\\/plain.ts\"/;",
        "const loaded = shim.require(\"./plain.ts\");",
        "const lazy = shim.import(\"./plain.ts\");",
        "const ratio = total / count / 2;",
      ]);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "src/tricky.ts")).toEqual([]);
    expect(snapshot.limits.omitted.filter((omission) => omission.path === "src/tricky.ts")).toEqual([]);
  });

  it("keeps offsets correct when the diff contains non-BMP characters", () => {
    const source = "// 🚀 launch\nimport { value } from \"./plain.ts\";";
    expect(maskLiterals(source)).toHaveLength(source.length);
    const diff = changedFile("src/plain.ts", ["export const value = 1;"])
      + changedFile("src/emoji.ts", ["// 🚀 launch note", "import { value } from \"./plain.ts\";"]);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "src/emoji.ts")[0]!.evidence).toEqual([
      { path: "src/emoji.ts", line: 2, text: "import { value } from \"./plain.ts\";" },
    ]);
  });

  it("anchors status on the specifier line of a multi-line statement", () => {
    const diff = changedFile("src/old-target.ts", ["export const value = 1;"])
      + changedFile("src/new-target.ts", ["export const value = 1;"])
      + `diff --git a/src/multi.ts b/src/multi.ts\n--- a/src/multi.ts\n+++ b/src/multi.ts\n@@ -1,4 +1,4 @@\n import {\n   value\n-} from "./old-target.ts";\n+} from "./new-target.ts";\n export const multi = value;\n`;
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edge(snapshot, "src/multi.ts", "src/new-target.ts")).toMatchObject({ status: "added" });
    expect(edge(snapshot, "src/multi.ts", "src/new-target.ts")!.evidence.map((item) => item.line)).toEqual([1, 3]);
    expect(edge(snapshot, "src/multi.ts", "src/old-target.ts")).toMatchObject({ status: "removed" });
    expect(edge(snapshot, "src/multi.ts", "src/old-target.ts")!.evidence.map((item) => item.line)).toEqual([1, 3]);
  });

  it("reads statements from every hunk without gluing them together", () => {
    const diff = changedFile("src/plain.ts", ["export const value = 1;"])
      + `diff --git a/src/hunks.ts b/src/hunks.ts\n--- a/src/hunks.ts\n+++ b/src/hunks.ts\n@@ -1,2 +1,2 @@\n export const first = 1\n export const second = 2\n@@ -40,2 +40,3 @@\n export const third = 3\n+import { value } from "./plain.ts";\n`;
    const snapshot = buildStructureSnapshot(input(diff));
    const found = edgesFrom(snapshot, "src/hunks.ts");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: "added" });
    expect(found[0]!.evidence[0]!.line).toBe(41);
  });
});

describe("changed-state fidelity", () => {
  it("reports a binding-only change as one modified connection", () => {
    const diff = changedFile("src/b.ts", ["export const b = 1;", "export const c = 2;"])
      + `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-import { b } from "./b.ts";\n+import { b, c } from "./b.ts";\n export const a = 1;\n`;
    const snapshot = buildStructureSnapshot(input(diff));
    const found = edgesFrom(snapshot, "src/a.ts");
    expect(found).toHaveLength(1);
    expect(found[0]!.status).toBe("modified");
    expect(found[0]!.specifier).toBe("./b.ts");
    expect(found[0]!.evidence.map((item) => item.text)).toEqual([
      "import { b } from \"./b.ts\";",
      "import { b, c } from \"./b.ts\";",
    ]);
  });

  it("marks a file with no diff content as unanalyzed", () => {
    const diff = "diff --git a/src/moved.ts b/src/elsewhere.ts\nsimilarity index 100%\nrename from src/moved.ts\nrename to src/elsewhere.ts\n";
    const snapshot = buildStructureSnapshot(input(diff));
    expect(snapshot.files[0]).toMatchObject({
      path: "src/elsewhere.ts",
      status: "renamed",
      renamedFrom: "src/moved.ts",
      analyzed: false,
      reason: "no diff content for this file: no import data",
    });
  });

  it("refuses to analyze a combined merge diff", () => {
    const diff = "diff --cc src/merged.ts\nindex 1111111,2222222..3333333\n--- a/src/merged.ts\n+++ b/src/merged.ts\n@@@ -1,2 -1,2 +1,3 @@@\n++import { x } from \"./x.ts\";\n";
    const snapshot = buildStructureSnapshot(input(diff));
    expect(snapshot.files).toEqual([]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.comparison.reasons).toContain(
      "merge commit: combined diffs are not analyzed; pick one parent range (e.g. <sha>^1...<sha>) and retry");
  });
});

describe("specifier resolution", () => {
  it("resolves an old-side specifier relative to the pre-rename path", () => {
    const diff = changedFile("src/old/sib.ts", ["export const sib = 1;"])
      + `diff --git a/src/old/mod.ts b/src/new/mod.ts\nsimilarity index 80%\nrename from src/old/mod.ts\nrename to src/new/mod.ts\n--- a/src/old/mod.ts\n+++ b/src/new/mod.ts\n@@ -1,2 +1,1 @@\n-import { sib } from "./sib.ts";\n export const mod = 1;\n`;
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edge(snapshot, "src/new/mod.ts", "src/old/sib.ts")).toMatchObject({ status: "removed" });
  });

  it("refuses to resolve a new-side import of a path that no longer exists", () => {
    const diff = `diff --git a/src/old/mod.ts b/src/new/mod.ts\nsimilarity index 80%\nrename from src/old/mod.ts\nrename to src/new/mod.ts\n--- a/src/old/mod.ts\n+++ b/src/new/mod.ts\n@@ -1,1 +1,2 @@\n export const mod = 1;\n+export const extra = 2;\n`
      + `diff --git a/src/root.ts b/src/root.ts\n--- a/src/root.ts\n+++ b/src/root.ts\n@@ -1,1 +1,2 @@\n export const root = 1;\n+import { mod } from "./old/mod.ts";\n`;
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "src/root.ts")).toEqual([]);
    expect(snapshot.limits.omitted).toContainEqual({
      path: "src/root.ts",
      reason: "specifier './old/mod.ts' at line 2 matches no changed file: no import data outside the changed set",
    });
  });

  it("resolves modern extensions and backslash separators", () => {
    const diff = changedFile("src/util.mts", ["export const util = 1;"])
      + changedFile("src/legacy.cts", ["export const legacy = 1;"])
      + changedFile("src/deep/index.mts", ["export const deep = 1;"])
      + changedFile("src/user.ts", [
        "import { util } from \"./util\";",
        "import { legacy } from \"./legacy\";",
        "import { deep } from \"./deep\";",
        "import { win } from \".\\\\util.mts\";",
      ]);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "src/user.ts").map((found) => found.to)).toEqual([
      "src/deep/index.mts", "src/legacy.cts", "src/util.mts",
    ]);
    expect(edge(snapshot, "src/user.ts", "src/util.mts")!.evidence.map((item) => item.line)).toEqual([1, 4]);
  });
});

describe("bounded work", () => {
  it("truncates over-long lines and says so", () => {
    const padding = "x".repeat(4100);
    const diff = changedFile("src/plain.ts", ["export const value = 1;"])
      + changedFile("src/long.ts", [`+const pad = "${padding}"; import { value } from "./plain.ts";`]);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "src/long.ts")).toEqual([]);
    expect(snapshot.limits.truncated).toBe(true);
    expect(snapshot.limits.omitted).toContainEqual({
      reason: "line length cap: 1 lines longer than 4000 characters were truncated; imports past that point are not analyzed",
    });
  });

  it("stops reading after the diff-line cap", () => {
    const snapshot = buildStructureSnapshot(input(`${"\n".repeat(200_001)}${changedFile("src/late.ts", ["+const late = 1;"])}`));
    expect(snapshot.files).toEqual([]);
    expect(snapshot.comparison.partial).toBe(true);
    expect(snapshot.comparison.reasons).toContain(
      "diff parsing stopped after 200000 lines: no import data for the rest of this comparison");
  });

  it("stops after the per-file statement cap", () => {
    const statements = Array.from({ length: 2001 }, (_unused, index) => `+import { value as v${index} } from "./plain.ts";`);
    const diff = changedFile("src/plain.ts", ["export const value = 1;"]) + changedFile("src/huge.ts", statements);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(snapshot.limits.truncated).toBe(true);
    expect(snapshot.limits.omitted).toContainEqual({
      path: "src/huge.ts",
      reason: "statement cap reached: expected at most 2000 import statements in this file, received more; later statements are not analyzed",
    });
    expect(edgesFrom(snapshot, "src/huge.ts")[0]!.evidence).toHaveLength(4);
  });

  it("marks the end of the omission list when the row cap is reached", () => {
    const files = Array.from({ length: 200 }, (_unused, index) => changedFile(`src/f${index}.ts`, [
      `+import { a } from "./missing-${index}-a.ts";`,
      `+import { b } from "./missing-${index}-b.ts";`,
    ])).join("");
    const snapshot = buildStructureSnapshot(input(files));
    expect(snapshot.limits.omitted).toHaveLength(201);
    expect(snapshot.limits.omitted.at(-1)!.reason).toBe("further omissions not listed (200 more)");
    expect(snapshot.limits.omitted.at(-1)!.path).toBeUndefined();
  });

  it("aggregates external modules with a bounded list and a total", () => {
    const externals = Array.from({ length: 10 }, (_unused, index) => `+import p${index} from "pkg-${index}";`);
    const snapshot = buildStructureSnapshot(input(changedFile("src/ext.ts", externals)));
    expect(snapshot.limits.omitted).toContainEqual({
      path: "src/ext.ts",
      reason: "external modules (10): pkg-0, pkg-1, pkg-2, pkg-3, pkg-4, pkg-5, pkg-6, pkg-7, …",
    });
  });

  it("trims evidence deterministically and neutralizes control characters", () => {
    const long = `import { ${"value, ".repeat(40)}} from "./plain.ts";`;
    const diff = changedFile("src/plain.ts", ["export const value = 1;"])
      + changedFile("src/wide.ts", [`+${long}`]);
    const snapshot = buildStructureSnapshot(input(diff));
    const text = edgesFrom(snapshot, "src/wide.ts")[0]!.evidence[0]!.text;
    expect(text).toHaveLength(200);
    expect(text).toBe(long.slice(0, 200));
    const bell = buildStructureSnapshot(input(changedFile("src/plain.ts", ["export const value = 1;"])
      + changedFile("src/ctrl.ts", [`+import { value } from "./plain.ts"; // \u0007alarm`])));
    expect(edgesFrom(bell, "src/ctrl.ts")[0]!.evidence[0]!.text).toBe(
      "import { value } from \"./plain.ts\"; // \uFFFDalarm");
  });
});

const DART_DIFF = changedFile("pubspec.yaml", ["name: demo", "+version: 1.0.1"])
  + changedFile("lib/utils.dart", ["+const utils = 1;"])
  + changedFile("lib/models.dart", ["+const models = 1;"])
  + changedFile("lib/main.g.dart", ["part of 'main.dart';", "+const generated = 1;"])
  + changedFile("lib/service.dart", ["+const service = 1;"])
  + changedFile("lib/stub.dart", ["+const stub = 1;"])
  + changedFile("lib/io_impl.dart", ["+const io = 1;"])
  + changedFile("lib/main.dart", [
    "import 'utils.dart';",
    "export 'models.dart';",
    "part 'main.g.dart';",
    "import 'package:demo/service.dart';",
    "import 'package:http/http.dart' as http;",
    "import 'dart:io';",
    "import 'stub.dart' if (dart.library.io) 'io_impl.dart';",
    "+const version = 2;",
  ]);

describe("Dart language table", () => {
  const snapshot = buildStructureSnapshot(input(DART_DIFF));

  it("reads import, export, part, and part-of directives", () => {
    expect(edgesFrom(snapshot, "lib/main.dart").map((found) => `${found.kind}:${found.to}`)).toEqual([
      "part:lib/main.g.dart",
      "reexport:lib/models.dart",
      "import:lib/service.dart",
      "import:lib/stub.dart",
      "import:lib/utils.dart",
    ]);
    expect(edge(snapshot, "lib/main.g.dart", "lib/main.dart")).toMatchObject({
      kind: "part-of", specifier: "main.dart", typeOnly: false, status: "unchanged",
    });
  });

  it("maps a package: URI of the changed package through its pubspec", () => {
    expect(edge(snapshot, "lib/main.dart", "lib/service.dart")!.specifier).toBe("package:demo/service.dart");
  });

  it("aggregates package: URIs of other packages and dart: URIs as external", () => {
    expect(snapshot.limits.omitted).toContainEqual({
      path: "lib/main.dart",
      reason: "external modules (2): dart:io, package:http/http.dart",
    });
  });

  it("takes only the default specifier of a conditional import", () => {
    expect(edge(snapshot, "lib/main.dart", "lib/io_impl.dart")).toBeUndefined();
    expect(edge(snapshot, "lib/main.dart", "lib/stub.dart")!.specifier).toBe("stub.dart");
  });

  it("never reads a directive out of a comment, a triple-quoted string, or a raw string", () => {
    const diff = changedFile("lib/real.dart", ["+const real = 1;"])
      + changedFile("lib/commented.dart", ["+const commented = 1;"])
      + changedFile("lib/blocked.dart", ["+const blocked = 1;"])
      + changedFile("lib/triple.dart", ["+const triple = 1;"])
      + changedFile("lib/raw.dart", ["+const raw = 1;"])
      + changedFile("lib/masked.dart", [
        "// import 'commented.dart';",
        "/* import 'blocked.dart'; */",
        "const a = '''",
        "import 'triple.dart';",
        "''';",
        "const b = r'import \"raw.dart\"';",
        "import 'real.dart';",
      ]);
    const masked = buildStructureSnapshot(input(diff));
    expect(edgesFrom(masked, "lib/masked.dart").map((found) => found.to)).toEqual(["lib/real.dart"]);
    expect(edgesFrom(masked, "lib/masked.dart")[0]!.evidence[0]!.line).toBe(7);
  });

  it("reports a library-name part-of directive as unresolvable", () => {
    const snapshot = buildStructureSnapshot(input(
      changedFile("lib/named.dart", ["part of my_library;", "+const named = 1;"])));
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.limits.omitted).toContainEqual({
      path: "lib/named.dart",
      reason: "part-of library name 'my_library': no import data without a library file path",
    });
  });
});

const RUST_DIFF = changedFile("src/util/mod.rs", ["+pub struct Helper;"])
  + changedFile("src/parser/ast.rs", [
    "use super::lexer::Token;",
    "use self::node::Node;",
    "+pub struct Ast;",
  ])
  + changedFile("src/parser/lexer.rs", ["+pub struct Token;"])
  + changedFile("src/parser/ast/node.rs", ["+pub struct Node;"])
  + changedFile("src/custom/other.rs", ["+pub struct Other;"])
  + changedFile("src/generated.rs", ["+pub const GENERATED: u8 = 1;"])
  + changedFile("src/parser.rs", [
    "mod ast;",
    "include!(\"generated.rs\");",
    "+pub struct Parser;",
  ])
  + changedFile("src/lib.rs", [
    "mod parser;",
    "pub mod util;",
    "#[path = \"custom/other.rs\"]",
    "mod other;",
    "use crate::parser::ast::Node;",
    "pub use crate::util::Helper;",
    "use std::fs;",
    "use serde::Serialize;",
    "extern crate serde;",
    "+pub const VERSION: u8 = 2;",
  ]);

describe("Rust language table", () => {
  const snapshot = buildStructureSnapshot(input(RUST_DIFF));

  it("resolves mod declarations from a crate root and from a nested file", () => {
    expect(edge(snapshot, "src/lib.rs", "src/parser.rs")).toMatchObject({ kind: "mod", specifier: "parser" });
    expect(edge(snapshot, "src/lib.rs", "src/util/mod.rs")).toMatchObject({ kind: "mod", specifier: "util" });
    expect(edge(snapshot, "src/parser.rs", "src/parser/ast.rs")).toMatchObject({ kind: "mod", specifier: "ast" });
  });

  it("honours a #[path] attribute on the preceding line", () => {
    expect(edge(snapshot, "src/lib.rs", "src/custom/other.rs")).toMatchObject({
      kind: "mod", specifier: "custom/other.rs",
    });
  });

  it("resolves a use path by its longest resolvable prefix", () => {
    expect(edge(snapshot, "src/lib.rs", "src/parser/ast.rs")).toMatchObject({
      kind: "use", specifier: "crate::parser::ast::Node", typeOnly: false,
    });
  });

  it("reports a pub use as a re-export", () => {
    expect(edgesFrom(snapshot, "src/lib.rs").some((found) =>
      found.kind === "reexport" && found.to === "src/util/mod.rs")).toBe(true);
  });

  it("walks super and self module paths", () => {
    expect(edge(snapshot, "src/parser/ast.rs", "src/parser/lexer.rs")).toMatchObject({
      kind: "use", specifier: "super::lexer::Token",
    });
    expect(edge(snapshot, "src/parser/ast.rs", "src/parser/ast/node.rs")).toMatchObject({
      kind: "use", specifier: "self::node::Node",
    });
  });

  it("aggregates external crates instead of inventing edges", () => {
    expect(snapshot.limits.omitted).toContainEqual({
      path: "src/lib.rs",
      reason: "external modules (2): serde, std",
    });
  });

  it("resolves an include! macro relative to the including file", () => {
    expect(edge(snapshot, "src/parser.rs", "src/generated.rs")).toMatchObject({
      kind: "include", specifier: "generated.rs",
    });
  });

  it("ignores declarations inside nested block comments, raw strings, and char literals", () => {
    const diff = changedFile("src/helper.rs", ["+pub struct Helper;"])
      + changedFile("src/hidden.rs", ["+pub struct Hidden;"])
      + changedFile("src/fake.rs", ["+pub struct Fake;"])
      + changedFile("src/tricky.rs", [
        "/* outer /* inner */ mod hidden; */",
        "const RAW: &str = r#\"mod fake; use crate::fake;\"#;",
        "const QUOTE: char = '\\'';",
        "const PLAIN: char = 'x';",
        "fn borrow<'a>(value: &'a str) -> &'a str { value }",
        "use crate::helper::Helper;",
      ]);
    const tricky = buildStructureSnapshot(input(diff));
    expect(edgesFrom(tricky, "src/tricky.rs").map((found) => found.to)).toEqual(["src/helper.rs"]);
    expect(edgesFrom(tricky, "src/tricky.rs")[0]!.evidence[0]!.line).toBe(6);
  });

  it("prefers the file's own crate root over the repository src directory", () => {
    const diff = changedFile("src/parser.rs", ["+pub struct Outer;"])
      + changedFile("pkg/app/src/parser.rs", ["+pub struct Inner;"])
      + changedFile("pkg/app/src/lib.rs", ["use crate::parser::Inner;", "+pub const VERSION: u8 = 1;"]);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "pkg/app/src/lib.rs").map((found) => found.to)).toEqual(["pkg/app/src/parser.rs"]);
  });

  it("ignores a commented-out #[path] attribute", () => {
    const diff = changedFile("src/other.rs", ["+pub struct Other;"])
      + changedFile("src/custom/other.rs", ["+pub struct Custom;"])
      + changedFile("src/lib.rs", ["// #[path = \"custom/other.rs\"]", "mod other;", "+pub const VERSION: u8 = 1;"]);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "src/lib.rs").map((found) => found.to)).toEqual(["src/other.rs"]);
  });

  it("resolves a #[path] module exactly, without a mod.rs fallback", () => {
    const diff = changedFile("src/gen/mod.rs", ["+pub struct Gen;"])
      + changedFile("src/lib.rs", ["#[path = \"gen.rs\"]", "mod gen;", "+pub const VERSION: u8 = 1;"]);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "src/lib.rs")).toEqual([]);
    expect(snapshot.limits.omitted).toContainEqual({
      path: "src/lib.rs",
      reason: "specifier 'gen.rs' at line 2 matches no changed file: no import data outside the changed set",
    });
  });

  it("expands brace groups in a use path", () => {
    const diff = changedFile("src/alpha.rs", ["+pub struct Alpha;"])
      + changedFile("src/beta.rs", ["+pub struct Beta;"])
      + changedFile("src/inner.rs", ["+pub struct Inner;"])
      + changedFile("src/inner/gamma.rs", ["+pub struct Gamma;"])
      + changedFile("src/lib.rs", [
        "use crate::{alpha, beta};",
        "use crate::inner::{self, gamma};",
        "+pub const VERSION: u8 = 1;",
      ]);
    const snapshot = buildStructureSnapshot(input(diff));
    expect(edgesFrom(snapshot, "src/lib.rs").map((found) => `${found.to}|${found.specifier}`)).toEqual([
      "src/alpha.rs|crate::alpha",
      "src/beta.rs|crate::beta",
      "src/inner.rs|crate::inner",
      "src/inner/gamma.rs|crate::inner::gamma",
    ]);
  });
});

type GitCall = string[];

function fakeGit(blobs: Record<string, string>, calls: GitCall[]): ExecFile {
  return async (file, args) => {
    calls.push([file, ...args]);
    if (file !== "git") throw new Error(`unexpected command '${file}'`);
    const spec = args.at(-1)!;
    const content = blobs[spec];
    if (content === undefined) throw new Error(`fatal: path does not exist: ${spec}`);
    if (args[1] === "-s") return { stdout: `${Buffer.byteLength(content)}\n`, stderr: "" };
    return { stdout: content, stderr: "" };
  };
}

const NEIGHBOUR_DIFF = changedFile("src/entry.ts", [
  "+import { n } from \"./neighbour.ts\";",
  "+export const entry = 1;",
]);

const NEIGHBOUR_BLOB = "import { entry } from \"./entry.ts\";\nimport { far } from \"./far.ts\";\nexport const n = 1;\n";

async function withNeighbours(
  source: InputSnapshot, blobs: Record<string, string>, calls: GitCall[], now?: () => number,
): Promise<StructureSnapshot> {
  return structureSnapshotWithNeighbours(source, {
    neighbours: true, cwd: "/repo", execFile: fakeGit(blobs, calls), ...(now ? { now } : {}),
  });
}

describe("one-hop neighbours", () => {
  it("reads a worktree neighbour from the index and says so", async () => {
    const calls: GitCall[] = [];
    const snapshot = await withNeighbours(
      input(NEIGHBOUR_DIFF, "worktree"), { ":src/neighbour.ts": NEIGHBOUR_BLOB }, calls);
    expect(calls).toEqual([
      ["git", "cat-file", "-s", ":src/neighbour.ts"],
      ["git", "cat-file", "blob", ":src/neighbour.ts"],
    ]);
    expect(snapshot.neighbours).toEqual({ state: "on", count: 1 });
    expect(snapshot.comparison.reasons).toContain("neighbour content read from the index");
  });

  it("gives a neighbour the context status and keeps its own edges to the changed set", async () => {
    const calls: GitCall[] = [];
    const snapshot = await withNeighbours(
      input(NEIGHBOUR_DIFF, "worktree"), { ":src/neighbour.ts": NEIGHBOUR_BLOB }, calls);
    expect(snapshot.files.find((file) => file.path === "src/neighbour.ts")).toEqual({
      path: "src/neighbour.ts", status: "context", additions: 0, deletions: 0, analyzed: true,
    });
    expect(edge(snapshot, "src/entry.ts", "src/neighbour.ts")).toMatchObject({ status: "added" });
    expect(edge(snapshot, "src/neighbour.ts", "src/entry.ts")).toMatchObject({ status: "unchanged" });
    expect(snapshot.limits.omitted.some((omission) => omission.reason.includes("./neighbour.ts"))).toBe(false);
  });

  it("stops at one hop", async () => {
    const calls: GitCall[] = [];
    const snapshot = await withNeighbours(input(NEIGHBOUR_DIFF, "worktree"), {
      ":src/neighbour.ts": NEIGHBOUR_BLOB, ":src/far.ts": "export const far = 1;\n",
    }, calls);
    expect(snapshot.files.map((file) => file.path)).toEqual(["src/entry.ts", "src/neighbour.ts"]);
    expect(edge(snapshot, "src/neighbour.ts", "src/far.ts")).toBeUndefined();
    expect(calls.map((call) => call.at(-1))).not.toContain(":src/far.ts");
  });

  it("reads staged, commit, and range neighbours from the matching Git object", async () => {
    const specs: string[] = [];
    for (const [source, spec] of [
      [input(NEIGHBOUR_DIFF, "staged"), ":src/neighbour.ts"],
      [{ ...input(NEIGHBOUR_DIFF, "commit"), label: "Commit 9fceb02", revision: "9fceb02" }, "9fceb02:src/neighbour.ts"],
      [{ ...input(NEIGHBOUR_DIFF, "range"), label: "main...feature", rangeTo: "feature" }, "feature:src/neighbour.ts"],
    ] as const) {
      const calls: GitCall[] = [];
      const snapshot = await withNeighbours(source, { [spec]: NEIGHBOUR_BLOB }, calls);
      expect(snapshot.neighbours.count).toBe(1);
      specs.push(calls[0]!.at(-1)!);
    }
    expect(specs).toEqual([":src/neighbour.ts", "9fceb02:src/neighbour.ts", "feature:src/neighbour.ts"]);
  });

  it("reports neighbours as unavailable for pull-request and pasted sources", async () => {
    const calls: GitCall[] = [];
    const pr = await withNeighbours({ ...input(NEIGHBOUR_DIFF, "pr"), headSha: "abc123" }, {}, calls);
    expect(pr.neighbours.state).toBe("unavailable");
    expect(pr.neighbours.reason).toContain("pull-request");
    const paste = await withNeighbours(input("code", "paste"), {}, calls);
    expect(paste.neighbours.state).toBe("unavailable");
    expect(paste.neighbours.reason).toContain("Git provenance");
    expect(calls).toEqual([]);
  });

  it("rejects a path that escapes the repository before running Git", async () => {
    const calls: GitCall[] = [];
    const diff = changedFile("src/escape.ts", ["+import { x } from \"../../outside.ts\";"]);
    const snapshot = await withNeighbours(input(diff, "worktree"), {}, calls);
    expect(calls).toEqual([]);
    expect(snapshot.limits.omitted).toContainEqual({
      path: "../outside.ts",
      reason: "neighbour path rejected: expected a repo-relative path without '..' or ':', received '../outside.ts'; no import data for that neighbour",
    });
  });

  it("rejects a neighbour path carrying Git object syntax", async () => {
    const calls: GitCall[] = [];
    const diff = changedFile("src/entry.ts", ["+import { x } from \"./2:secret.ts\";"]);
    const snapshot = await withNeighbours(input(diff, "worktree"), {}, calls);
    expect(calls).toEqual([]);
    expect(snapshot.limits.omitted).toContainEqual({
      path: "src/2:secret.ts",
      reason: "neighbour path rejected: expected a repo-relative path without '..' or ':', received 'src/2:secret.ts'; no import data for that neighbour",
    });
  });

  it("keeps probing after a missing candidate and never calls it a read failure", async () => {
    const calls: GitCall[] = [];
    const diff = changedFile("src/entry.ts", [
      "+import { x } from \"./x0\";",
      "+import { u } from \"./util.js\";",
    ]);
    const snapshot = await withNeighbours(input(diff, "worktree"), {
      ":src/x0.ts": "export const x0 = 1;\n",
      ":src/util.ts": "export const util = 1;\n",
    }, calls);
    expect(snapshot.neighbours.count).toBe(2);
    expect(snapshot.files.map((file) => file.path)).toEqual(["src/entry.ts", "src/util.ts", "src/x0.ts"]);
    expect(calls[0]).toEqual(["git", "cat-file", "-s", ":src/x0"]);
    expect(calls[1]).toEqual(["git", "cat-file", "-s", ":src/x0.ts"]);
    expect(snapshot.limits.omitted.some((omission) => omission.reason.includes("read failed"))).toBe(false);
  });

  it("resolves a Rust module through its second candidate", async () => {
    const calls: GitCall[] = [];
    const snapshot = await withNeighbours(
      input(changedFile("src/lib.rs", ["+mod util;"]), "worktree"),
      { ":src/util/mod.rs": "pub struct Helper;\n" }, calls);
    expect(snapshot.neighbours.count).toBe(1);
    expect(calls.map((call) => call.at(-1))).toEqual([
      ":src/util.rs", ":src/util/mod.rs", ":src/util/mod.rs",
    ]);
  });

  it("caps the number of Git lookups", async () => {
    const calls: GitCall[] = [];
    const diff = changedFile("src/entry.ts", Array.from({ length: 24 }, (_unused, index) =>
      `+import { a } from "./missing${index}";`));
    const snapshot = await withNeighbours(input(diff, "worktree"), {}, calls);
    expect(snapshot.neighbours.count).toBe(0);
    expect(calls).toHaveLength(400);
    expect(snapshot.limits.truncated).toBe(true);
    expect(snapshot.limits.omitted).toContainEqual({
      reason: "neighbour lookup cap reached: expected at most 400 Git lookups, received more; later neighbours are not read",
    });
  });

  it("aborts an in-flight neighbour read at the wall-clock deadline", async () => {
    const diff = changedFile("src/entry.ts", ["+import { a } from \"./a.ts\";"]);
    const snapshot = await structureSnapshotWithNeighbours(input(diff, "worktree"), {
      neighbours: true,
      cwd: "/repo",
      deadline: AbortSignal.timeout(5),
      execFile: async (_file, _args, options) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    expect(snapshot.neighbours.count).toBe(0);
    expect(snapshot.limits.truncated).toBe(true);
    expect(snapshot.limits.omitted).toContainEqual({
      reason: "neighbour time cap reached: expected at most 5000 ms of neighbour reads, received more; later neighbours are not read",
    });
  });

  it("reads nothing when the request is already aborted", async () => {
    const calls: GitCall[] = [];
    const diff = changedFile("src/entry.ts", Array.from({ length: 24 }, (_unused, index) =>
      `+import { a } from "./missing${index}";`));
    const snapshot = await structureSnapshotWithNeighbours(input(diff, "worktree"), {
      neighbours: true, cwd: "/repo", execFile: fakeGit({}, calls), signal: AbortSignal.abort(),
    });
    expect(calls).toEqual([]);
    expect(snapshot.neighbours).toEqual({ state: "on", count: 0 });
    expect(snapshot.limits.omitted.some((omission) => omission.reason.includes("lookup cap"))).toBe(false);
    expect(snapshot.limits.omitted).toContainEqual({ reason: "neighbour reads stopped: request aborted" });
  });

  it("stops probing when the request aborts mid-read", async () => {
    const calls: GitCall[] = [];
    const controller = new AbortController();
    const diff = changedFile("src/entry.ts", [
      "+import { a } from \"./a.ts\";",
      "+import { b } from \"./b.ts\";",
    ]);
    const snapshot = await structureSnapshotWithNeighbours(input(diff, "worktree"), {
      neighbours: true,
      cwd: "/repo",
      signal: controller.signal,
      execFile: async (file, args) => {
        calls.push([file, ...args]);
        controller.abort();
        throw new Error("aborted");
      },
    });
    expect(calls).toHaveLength(1);
    expect(snapshot.neighbours.count).toBe(0);
    expect(snapshot.limits.omitted.some((omission) => omission.reason.includes("lookup cap"))).toBe(false);
    expect(snapshot.limits.omitted).toContainEqual({ reason: "neighbour reads stopped: request aborted" });
  });

  it("aggregates an unknown Dart package as external instead of calling it unresolved", async () => {
    const calls: GitCall[] = [];
    const diff = changedFile("lib/main.dart", [
      "+import 'package:http/http.dart';",
      "+import 'dart:io';",
    ]);
    const on = await withNeighbours(input(diff, "worktree"), {}, calls);
    const off = buildStructureSnapshot(input(diff));
    expect(on.limits.omitted).toContainEqual({
      path: "lib/main.dart",
      reason: "external modules (2): dart:io, package:http/http.dart",
    });
    expect(on.limits.omitted).toEqual(off.limits.omitted);
    expect(on.comparison.reasons).toEqual(off.comparison.reasons);
  });

  it("finds a Dart pubspec by walking up from the importing file", async () => {
    const calls: GitCall[] = [];
    const diff = changedFile("packages/foo/lib/main.dart", ["+import 'package:foo/service.dart';"]);
    const snapshot = await withNeighbours(input(diff, "worktree"), {
      ":packages/foo/pubspec.yaml": "name: foo\nversion: 1.0.0\n",
      ":packages/foo/lib/service.dart": "const service = 1;\n",
    }, calls);
    expect(edge(snapshot, "packages/foo/lib/main.dart", "packages/foo/lib/service.dart")).toMatchObject({
      kind: "import", specifier: "package:foo/service.dart",
    });
    expect(calls[0]!.at(-1)).toBe(":packages/foo/lib/pubspec.yaml");
    expect(calls.map((call) => call.at(-1))).toContain(":packages/foo/pubspec.yaml");
  });

  it("uncounts a suppressed omission when a neighbour resolves it", async () => {
    const calls: GitCall[] = [];
    const fillers = Array.from({ length: 100 }, (_unused, index) => changedFile(`src/f${index}.ts`, [
      `+import { a } from "./gone-${index}-a.ts";`,
      `+import { b } from "./gone-${index}-b.ts";`,
    ])).join("");
    const diff = `${fillers}${changedFile("src/zz.ts", ["+import { n } from \"./found.ts\";"])}`;
    const snapshot = await withNeighbours(input(diff, "worktree"), {
      ":src/found.ts": "export const found = 1;\n",
    }, calls);
    expect(snapshot.limits.omitted).toHaveLength(200);
    expect(snapshot.limits.omitted.some((omission) =>
      omission.reason.startsWith("further omissions not listed"))).toBe(false);
    expect(edge(snapshot, "src/zz.ts", "src/found.ts")).toBeDefined();
  });

  it("caps the neighbour count", async () => {
    const calls: GitCall[] = [];
    const blobs: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) blobs[`:src/n${index}.ts`] = `export const n${index} = 1;\n`;
    const diff = changedFile("src/entry.ts", Array.from({ length: 60 }, (_unused, index) =>
      `+import { n } from "./n${index}.ts";`));
    const snapshot = await withNeighbours(input(diff, "worktree"), blobs, calls);
    expect(snapshot.neighbours.count).toBe(50);
    expect(snapshot.limits.truncated).toBe(true);
    expect(snapshot.limits.omitted).toContainEqual({
      reason: "neighbour cap reached: expected at most 50 neighbour files, received more; later neighbours are not read",
    });
  });

  it("caps a single neighbour file by size", async () => {
    const calls: GitCall[] = [];
    const diff = changedFile("src/entry.ts", [
      "+import { big } from \"./big.ts\";",
      "+import { small } from \"./small.ts\";",
    ]);
    const snapshot = await withNeighbours(input(diff, "worktree"), {
      ":src/big.ts": "x".repeat(300_000), ":src/small.ts": "export const small = 1;\n",
    }, calls);
    expect(snapshot.neighbours.count).toBe(1);
    expect(calls.some((call) => call.at(-1) === ":src/big.ts" && call[1] === "blob")).toBe(false);
    expect(snapshot.limits.omitted).toContainEqual({
      path: "src/big.ts",
      reason: "neighbour file too large: expected at most 262144 bytes, received 300000; no import data for that neighbour",
    });
  });

  it("caps the total neighbour bytes", async () => {
    const calls: GitCall[] = [];
    const blobs: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) blobs[`:src/n${index}.ts`] = "x".repeat(250_000);
    const diff = changedFile("src/entry.ts", Array.from({ length: 10 }, (_unused, index) =>
      `+import { n } from "./n${index}.ts";`));
    const snapshot = await withNeighbours(input(diff, "worktree"), blobs, calls);
    expect(snapshot.neighbours.count).toBe(8);
    expect(snapshot.limits.truncated).toBe(true);
    expect(snapshot.limits.omitted).toContainEqual({
      reason: "neighbour byte cap reached: expected at most 2097152 neighbour bytes, received more; later neighbours are not read",
    });
  });

  it("caps neighbour reads by wall clock", async () => {
    const calls: GitCall[] = [];
    const diff = changedFile("src/entry.ts", [
      "+import { a } from \"./a.ts\";",
      "+import { b } from \"./b.ts\";",
    ]);
    const snapshot = await withNeighbours(input(diff, "worktree"), {
      ":src/a.ts": "export const a = 1;\n", ":src/b.ts": "export const b = 1;\n",
    }, calls, () => calls.length * 3000);
    expect(snapshot.neighbours.count).toBe(1);
    expect(snapshot.limits.truncated).toBe(true);
    expect(snapshot.limits.omitted).toContainEqual({
      reason: "neighbour time cap reached: expected at most 5000 ms of neighbour reads, received more; later neighbours are not read",
    });
  });

  it("produces byte-identical JSON with neighbours on, whatever the discovery order", async () => {
    const alpha = changedFile("src/alpha.ts", ["+import { one } from \"./one.ts\";"]);
    const beta = changedFile("src/beta.ts", ["+import { two } from \"./two.ts\";"]);
    const one = "export const one = 1;\n";
    const two = "export const two = 2;\n";
    const first = await withNeighbours(
      input(`${alpha}${beta}`, "worktree"), { ":src/one.ts": one, ":src/two.ts": two }, []);
    const second = await withNeighbours(
      input(`${beta}${alpha}`, "worktree"), { ":src/two.ts": two, ":src/one.ts": one }, []);
    expect(second.neighbours.count).toBe(2);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("reads a Dart package: URI through a pubspec that is not in the diff", async () => {
    const calls: GitCall[] = [];
    const diff = changedFile("lib/main.dart", ["+import 'package:demo/service.dart';"]);
    const snapshot = await withNeighbours(input(diff, "worktree"), {
      ":pubspec.yaml": "name: demo\nversion: 1.0.0\n",
      ":lib/service.dart": "const service = 1;\n",
    }, calls);
    expect(edge(snapshot, "lib/main.dart", "lib/service.dart")).toMatchObject({
      kind: "import", specifier: "package:demo/service.dart",
    });
    expect(snapshot.neighbours.count).toBe(1);
  });
});

async function startServer(diffs: string[]) {
  const home = await mkdtemp(join(tmpdir(), "review-tutor-structure-"));
  temporaryRoots.push(home);
  let call = 0;
  const server = await startReviewTutorServer({
    cwd: "/repo",
    canonicalRepo: "/repo",
    registry: registry(),
    skillPath,
    home,
    runner: { run: async () => ({ answer: "" }), cancel: () => {}, shutdown: async () => {} },
    execFile: async () => ({ stdout: diffs[Math.min(call++, diffs.length - 1)]!, stderr: "" }),
  });
  return server;
}

describe("structure endpoint", () => {
  it("requires the session bearer token", async () => {
    const server = await startServer([RENAME_DIFF]);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/structure`);
      expect(response.status).toBe(401);
      await response.body?.cancel();
    } finally {
      await server.close();
    }
  });

  it("reports a typed conflict when no input is loaded and recomputes on source switch", async () => {
    const server = await startServer([RENAME_DIFF, REMOVAL_DIFF]);
    const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
    try {
      const empty = await fetch(`http://127.0.0.1:${server.port}/api/structure`, { headers });
      expect(empty.status).toBe(409);
      expect((await empty.json() as { error: string }).error).toContain("expected a loaded input snapshot");

      await fetch(`http://127.0.0.1:${server.port}/api/source`, {
        method: "POST", headers, body: JSON.stringify({ protocol: "rt/1", kind: "worktree" }),
      }).then((response) => response.json());
      const first = await fetch(`http://127.0.0.1:${server.port}/api/structure`, { headers });
      const firstBody = await first.text();
      expect(first.status).toBe(200);
      expect(JSON.parse(firstBody).files.map((file: { path: string }) => file.path)).toContain("src/renamed.ts");
      const cached = await fetch(`http://127.0.0.1:${server.port}/api/structure`, { headers });
      expect(await cached.text()).toBe(firstBody);

      await fetch(`http://127.0.0.1:${server.port}/api/source`, {
        method: "POST", headers, body: JSON.stringify({ protocol: "rt/1", kind: "staged" }),
      }).then((response) => response.json());
      const second = await fetch(`http://127.0.0.1:${server.port}/api/structure`, { headers });
      const secondBody = await second.json() as StructureSnapshot;
      expect(secondBody.files.map((file) => file.path)).toContain("src/dropped.ts");
      expect(secondBody.inputId).not.toBe((JSON.parse(firstBody) as StructureSnapshot).inputId);
    } finally {
      await server.close();
    }
  });

  it("caches per neighbours flag and reads neighbours only when asked", async () => {
    const home = await mkdtemp(join(tmpdir(), "review-tutor-neighbours-"));
    temporaryRoots.push(home);
    const calls: GitCall[] = [];
    const blob = fakeGit({ ":src/neighbour.ts": NEIGHBOUR_BLOB }, calls);
    const server = await startReviewTutorServer({
      cwd: "/repo",
      canonicalRepo: "/repo",
      registry: registry(),
      skillPath,
      home,
      runner: { run: async () => ({ answer: "" }), cancel: () => {}, shutdown: async () => {} },
      execFile: async (file, args, options) =>
        (args[0] === "diff" ? { stdout: NEIGHBOUR_DIFF, stderr: "" } : blob(file, args, options)),
    });
    const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
    const structure = async (query: string): Promise<string> =>
      (await fetch(`http://127.0.0.1:${server.port}/api/structure${query}`, { headers })).text();
    try {
      await fetch(`http://127.0.0.1:${server.port}/api/source`, {
        method: "POST", headers, body: JSON.stringify({ protocol: "rt/1", kind: "worktree" }),
      }).then((response) => response.json());

      const off = await structure("");
      expect(calls).toEqual([]);
      expect((JSON.parse(off) as StructureSnapshot).neighbours).toEqual({ state: "off", count: 0 });

      const on = await structure("?neighbours=1");
      expect(calls).toHaveLength(2);
      expect((JSON.parse(on) as StructureSnapshot).neighbours).toEqual({ state: "on", count: 1 });

      expect(await structure("?neighbours=1")).toBe(on);
      expect(await structure("")).toBe(off);
      expect(calls).toHaveLength(2);

      const bad = await fetch(`http://127.0.0.1:${server.port}/api/structure?neighbours=yes`, { headers });
      expect(bad.status).toBe(400);
      expect((await bad.json() as { error: string }).error)
        .toBe("neighbours query failed: expected 1, 0, or absent; correct it and retry");
    } finally {
      await server.close();
    }
  });
});
