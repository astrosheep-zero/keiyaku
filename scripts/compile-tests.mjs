import { copyFileSync, globSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";

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
  // Semantic checking stays in test:typecheck. Native transform also handles enums
  // and parameter properties; its inline map points back to the original test.
  writeFileSync(output, stripTypeScriptTypes(readFileSync(file, "utf8"), {
    mode: "transform",
    sourceMap: true,
    sourceUrl: pathToFileURL(resolve(file)).href,
  }));
}
// Execute the actual release modules and plugin, not a second source compilation.
for (const directory of ["src", "plugins"]) {
  symlinkSync(resolve(directory === "src" ? "build/src" : "plugins"), `.test-build/${directory}`, "junction");
}
