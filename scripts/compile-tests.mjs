import { copyFileSync, globSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

rmSync(".test-build", { recursive: true, force: true });
// Semantic checking belongs to test:typecheck. Native stripping preserves source
// positions without running the TypeScript emitter on every erasable test module.
// Keep the existing emitter for parameter properties and other non-erasable syntax.
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
  const source = readFileSync(file, "utf8");
  try {
    writeFileSync(output, stripTypeScriptTypes(source, { sourceUrl: pathToFileURL(resolve(file)).href }));
    continue;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
      throw new Error(`Cannot compile ${file}`, { cause: error });
    }
  }
  const typescript = (await import("typescript")).default;
  const result = typescript.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: typescript.ScriptTarget.ES2023,
      module: typescript.ModuleKind.ESNext,
      sourceMap: true,
      sourceRoot: dirname(resolve(file)),
    },
  });
  const errors =
    result.diagnostics?.filter((diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error) ?? [];
  if (errors.length > 0)
    throw new Error(errors.map((error) => typescript.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  writeFileSync(output, result.outputText);
  if (result.sourceMapText !== undefined) writeFileSync(output + ".map", result.sourceMapText);
}
// Execute the actual release modules and plugin, not a second source compilation.
for (const directory of ["src", "plugins"]) {
  symlinkSync(resolve(directory === "src" ? "build/src" : "plugins"), `.test-build/${directory}`, "junction");
}
