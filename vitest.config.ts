import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["packages/**/dist/**", "packages/**/test/**", "**/*.test.ts"],
      include: ["packages/*/src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        branches: 66,
        functions: 84,
        lines: 72,
        statements: 73,
      },
    },
    include: ["packages/**/*.test.ts"],
  },
});
