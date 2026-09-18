import { copyFileSync, globSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * @typedef {(source: string, sourceUrl: string, fileName: string) => string} TransformTypeScript
 */

// The transformation boundary owns runtime portability. Later Releases dropped the
// native `transform` mode that erases enums and parameter properties, so this pass
// keeps the runtime's own transform where it exists and falls back to the project's
// TypeScript otherwise. Either path rewrites types, emits an inline original-source
// map, and refuses code it cannot parse.
/** @type {TransformTypeScript} */
const transformTypeScript = await (async () => {
  try {
    stripTypeScriptTypes("let supported: number = 0;", { mode: "transform" });
  } catch (error) {
    // Only the runtime's own "that mode does not exist" refusal earns the fallback;
    // any other failure is a real compiler fault and must stay visible.
    if (!(error instanceof TypeError) || !("code" in error) || error.code !== "ERR_INVALID_ARG_VALUE") throw error;
    const { DiagnosticCategory, ModuleKind, ScriptTarget, flattenDiagnosticMessageText, transpileModule } =
      await import("typescript");
    /** @type {TransformTypeScript} */
    const throughProjectCompiler = (source, sourceUrl, fileName) => {
      const transformed = transpileModule(source, {
        fileName,
        compilerOptions: {
          target: ScriptTarget.ESNext,
          module: ModuleKind.ESNext,
          sourceMap: true,
          inlineSources: true,
          verbatimModuleSyntax: true,
        },
        reportDiagnostics: true,
      });
      const failure = (transformed.diagnostics ?? []).find(
        (diagnostic) => diagnostic.category === DiagnosticCategory.Error,
      );
      if (failure !== undefined) {
        const detail = flattenDiagnosticMessageText(failure.messageText, " ");
        throw new Error(`${fileName} is not valid TypeScript: ${detail}`);
      }
      const emitted = transformed.sourceMapText;
      if (emitted === undefined) throw new Error(`${fileName} produced no source map`);
      const map = JSON.parse(emitted);
      map.sources = [sourceUrl];
      const body = transformed.outputText.replace(/\/\/# sourceMappingURL=.*$/mu, "");
      const encoded = Buffer.from(JSON.stringify(map), "utf8").toString("base64");
      return `${body}//# sourceMappingURL=data:application/json;base64,${encoded}\n`;
    };
    return throughProjectCompiler;
  }
  return (source, sourceUrl) => stripTypeScriptTypes(source, { mode: "transform", sourceMap: true, sourceUrl });
})();

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
  // Semantic checking stays in test:typecheck. Transformation also handles enums
  // and parameter properties; its inline map points back to the original test.
  writeFileSync(output, transformTypeScript(readFileSync(file, "utf8"), pathToFileURL(resolve(file)).href, file));
}
// Execute the actual release modules and plugin, not a second source compilation.
for (const directory of ["src", "plugins"]) {
  symlinkSync(resolve(directory === "src" ? "build/src" : "plugins"), `.test-build/${directory}`, "junction");
}
