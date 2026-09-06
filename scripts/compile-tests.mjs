import { copyFileSync, globSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

rmSync(".test-build", { recursive: true, force: true });
// The typecheck command owns semantic checking. Like tsx's focused mode, this
// pass only transpiles, once per invocation rather than in every isolated worker.
for (const file of globSync([
  "tests/**/*.ts",
  "tests/**/*.js",
  "tests/**/*.mjs",
  "scripts/**/*.ts",
  "scripts/**/*.js",
  "scripts/**/*.mjs",
])) {
  if (file.replaceAll("\\", "/").startsWith("tests/fixtures/consumers/")) continue;
  const output = ".test-build/" + file.replace(/\.ts$/u, ".js");
  mkdirSync(dirname(output), { recursive: true });
  if (!file.endsWith(".ts")) {
    copyFileSync(file, output);
    continue;
  }
  const result = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
      sourceRoot: dirname(resolve(file)),
    },
  });
  const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length > 0)
    throw new Error(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  writeFileSync(output, result.outputText);
  if (result.sourceMapText !== undefined) writeFileSync(output + ".map", result.sourceMapText);
}
// Execute the actual release modules and plugin, not a second source compilation.
for (const directory of ["src", "plugins"]) {
  symlinkSync(resolve(directory === "src" ? "build/src" : "plugins"), `.test-build/${directory}`, "junction");
}
