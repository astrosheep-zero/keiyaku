import parser from "@typescript-eslint/parser";
import { DEFAULT_FILE_LINES, FILE_LINE_EXEMPTIONS } from "./scripts/maintainability/config.js";

const codeLineLimit = (max) => ["error", { max, skipBlankLines: true, skipComments: true }];

export default [
  {
    ignores: ["build/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      complexity: ["error", { max: 20, variant: "modified" }],
      "max-depth": ["error", 4],
      "max-lines": codeLineLimit(DEFAULT_FILE_LINES),
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }],
      "max-params": ["error", 5],
    },
  },
  ...FILE_LINE_EXEMPTIONS.map((exemption) => ({
    files: [exemption.file],
    rules: {
      "max-lines": "off",
    },
  })),
];
