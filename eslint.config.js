import parser from "@typescript-eslint/parser";
import { builtinRules } from "eslint/use-at-your-own-risk";
import { FILE_LINE_EXEMPTIONS, FILE_LINES } from "./scripts/maintainability/config.js";
import { functionName, functionVisitor } from "./scripts/maintainability/functions.js";

const codeLineLimit = (severity, max) => [severity, { max, skipBlankLines: true, skipComments: true }];
const maxLinesPerFunction = builtinRules.get("max-lines-per-function");

function contextWithOptions(context, options) {
  const scoped = Object.create(context);
  Object.defineProperty(scoped, "options", { value: [options] });
  return scoped;
}

function exactFunctionLineRule(functions) {
  return {
    meta: maxLinesPerFunction.meta,
    create(context) {
      const defaultRule = maxLinesPerFunction.create(contextWithOptions(context, {
        max: 80,
        skipBlankLines: true,
        skipComments: true,
        IIFEs: true,
      }));
      const namedRules = new Map(functions.map((entry) => [
        entry.name,
        maxLinesPerFunction.create(contextWithOptions(context, {
          max: entry.maxEffectiveLines,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        })),
      ]));
      const visit = (visitorName, node) => {
        const visitor = namedRules.get(functionName(node)) ?? defaultRule;
        visitor[visitorName]?.(node);
      };
      return functionVisitor((node) => visit(node.type, node));
    },
  };
}

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
  ...FILE_LINE_EXEMPTIONS.map((exemption) => ({
    files: [exemption.file],
    rules: {
      ...(exemption.maxEffectiveLines === undefined ? {} : { "max-lines": codeLineLimit("warn", exemption.maxEffectiveLines) }),
      ...(exemption.functions === undefined
        ? {}
        : {
            "max-lines-per-function": "off",
            "maintainability/exact-function-lines": "error",
          }),
    },
    ...(exemption.functions === undefined
      ? {}
      : { plugins: { maintainability: { rules: { "exact-function-lines": exactFunctionLineRule(exemption.functions) } } } }),
  })),
];
