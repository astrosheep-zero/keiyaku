import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FILE_LINE_EXCEPTIONS,
  markdownCharacterCount,
  markdownCharacterFindings,
  markdownCharacterSeverity,
  productionFileLineFindings,
  validateFileLineExceptions,
} from "../scripts/check-maintainability.js";

function writePhysicalLines(root, file, lines) {
  const absolute = join(root, file);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, "line\n".repeat(lines));
}

test("production file line limit passes 499 lines and fails 500 lines", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writePhysicalLines(root, "src/passes.ts", 499);
  writePhysicalLines(root, "src/fails.ts", 500);

  const checks = productionFileLineFindings(root, []);
  assert.deepEqual(checks.exceptionFindings, []);
  assert.deepEqual(checks.fileFindings, [{ file: "src/fails.ts", lines: 500, ceiling: 500 }]);
});

test("production file line exceptions require valid exact entries", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writePhysicalLines(root, "src/large.ts", 500);
  const valid = [{ file: "src/large.ts", ceiling: 500, reason: "Large owns one coherent boundary." }];

  assert.deepEqual(productionFileLineFindings(root, valid).fileFindings, []);
  assert.deepEqual(
    validateFileLineExceptions(
      [
        null,
        { file: "src/*.ts", ceiling: 500, reason: "Wildcard." },
        { file: "src/?.ts", ceiling: 500, reason: "Wildcard." },
        { file: "src/missing.ts", ceiling: 500, reason: "Unknown." },
        ...valid,
        ...valid,
        { file: "src/below.ts", ceiling: 499, reason: "Too low." },
        { file: "src/other.ts", ceiling: 500, reason: " " },
      ],
      [{ file: "src/large.ts" }, { file: "src/below.ts" }, { file: "src/other.ts" }],
    ).map(({ kind }) => kind),
    ["malformed", "wildcard", "wildcard", "unknown", "duplicate", "below-limit", "malformed"],
  );
});

test("production file line exceptions cover the complete current map", () => {
  const checks = productionFileLineFindings();
  assert.equal(FILE_LINE_EXCEPTIONS.length, 9);
  assert.deepEqual(checks.exceptionFindings, []);
  assert.deepEqual(checks.fileFindings, []);
});

test("source-local max-lines disables fail regardless of placement", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "disable.ts"),
    "// eslint-disable-next-line max-lines -- bypass\n/* eslint-disable max-lines -- bypass */\nexport const value = 1;\n",
  );

  assert.deepEqual(productionFileLineFindings(root, []).disableFindings, [
    { file: "src/disable.ts", line: 1 },
    { file: "src/disable.ts", line: 2 },
  ]);
});

test("comment directives exclude source strings, templates, and regular expressions", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "literals.ts"),
    'export const string = "// eslint-disable max-lines";\nexport const template = `/* eslint-disable max-lines */`;\nexport const expression = /\\/\\/ eslint-disable max-lines/;\n',
  );

  assert.deepEqual(productionFileLineFindings(root, []).disableFindings, []);
});

test("source walker includes dot files and ignores symbolic links", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writePhysicalLines(root, "src/.large.ts", 500);
  symlinkSync(join(root, "src", ".large.ts"), join(root, "src", "linked.ts"));

  assert.deepEqual(productionFileLineFindings(root, []).fileFindings, [
    { file: "src/.large.ts", lines: 500, ceiling: 500 },
  ]);
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
