import parser from "@typescript-eslint/parser";
import { FILE_LINES } from "./scripts/maintainability/config.js";

const codeLineLimit = (severity, max) => [severity, { max, skipBlankLines: true, skipComments: true }];
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
      "max-lines": codeLineLimit("warn", FILE_LINES.warning),
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }],
      "max-params": ["error", 5],
    },
  },
];
