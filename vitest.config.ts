import { defaultExclude } from "vitest/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["packages/**/dist/**", "packages/**/test/**", "**/*.test.ts"],
      include: ["packages/*/src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        branches: 64,
        functions: 83,
        lines: 72,
        statements: 72,
      },
    },
    include: ["packages/**/*.test.ts"],
    // Runs under `bun test` (needs `bun:sql`/`bun:test`) against a local
    // Supabase Postgres via `bun run test:supabase`; excluded here so plain
    // `vitest run` stays green without Postgres.
    exclude: [...defaultExclude, "packages/**/*.contract.test.ts"],
  },
});
