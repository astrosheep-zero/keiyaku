import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  markdownCharacterCount,
  markdownCharacterFindings,
  markdownCharacterSeverity,
} from "../scripts/check-maintainability.js";

const scriptSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../scripts/check-maintainability.js"), "utf8");

test("production file-total line gate and exception table are gone", async () => {
  const maintainability = await import("../scripts/check-maintainability.js");
  assert.equal("FILE_LINE_EXCEPTIONS" in maintainability, false);
  assert.equal("productionFileLineFindings" in maintainability, false);
  assert.equal("validateFileLineExceptions" in maintainability, false);
  assert.equal("physicalLineCount" in maintainability, false);
  assert.match(scriptSource, /eslint\.lintFiles\(\["src", "scripts"\]\)/u);
  assert.doesNotMatch(scriptSource, /LINE_LIMIT/u);
  assert.doesNotMatch(scriptSource, /FILE_LINE_EXCEPTIONS/u);
  assert.doesNotMatch(scriptSource, /production file line/u);
  assert.doesNotMatch(scriptSource, /source-local max-lines disables/u);
});

test("Markdown character limits warn above 20000 and fail above 30000", () => {
  assert.equal(markdownCharacterSeverity(20_000), null);
  assert.equal(markdownCharacterSeverity(20_001), "warning");
  assert.equal(markdownCharacterSeverity(30_000), "warning");
  assert.equal(markdownCharacterSeverity(30_001), "error");
});

test("Markdown character counts normalize line endings and count Unicode code points", () => {
  assert.equal(markdownCharacterCount("a\r\n你😀\r"), 5);
});

test("Markdown character checks exclude runtime and reference trees", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, ".keiyaku"));
  mkdirSync(join(root, "reference"));
  writeFileSync(join(root, "docs", "warning.md"), "a".repeat(20_001));
  writeFileSync(join(root, "error.md"), "b".repeat(30_001));
  writeFileSync(join(root, ".keiyaku", "ignored.md"), "c".repeat(30_001));
  writeFileSync(join(root, "reference", "ignored.md"), "d".repeat(30_001));

  assert.deepEqual(markdownCharacterFindings(root), [
    { file: "docs/warning.md", characters: 20_001, severity: "warning" },
    { file: "error.md", characters: 30_001, severity: "error" },
  ]);
});
