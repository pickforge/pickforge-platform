import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["coverage/**", "packages/**/dist/**"],
  },
  {
    files: ["packages/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      complexity: ["error", 15],
      "max-depth": ["error", 4],
      "max-lines-per-function": [
        "error",
        { max: 100, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["packages/**/*.test.ts"],
    rules: {
      "max-lines-per-function": "off",
    },
  },
);
