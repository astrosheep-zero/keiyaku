import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ESLint } from "eslint";
import {
  markdownCharacterCount,
  markdownCharacterFindings,
  markdownCharacterSeverity,
  promoteHardLineLimit,
  validateExemptions,
} from "../scripts/check-maintainability.js";

test("maintainability max-lines exemptions require exact live paths", () => {
  assert.deepEqual(validateExemptions([{
    file: "scripts/check-maintainability.js",
    reason: "The maintainability runner is one diagnostics owner.",
    maxEffectiveLines: 501,
  }]), []);

  const invalid = validateExemptions([
    { file: "src/**/*.ts" },
    { file: "src/missing.ts" },
  ]);
  assert.match(invalid[0] ?? "", /exact normalized relative file path/);
  assert.match(invalid[1] ?? "", /targets missing file/);
});

test("maintainability max-lines exemptions require useful effective-line caps", () => {
  const exemption = {
    file: "scripts/check-maintainability.js",
    reason: "The maintainability runner is one diagnostics owner.",
  };
  const invalid = validateExemptions([
    exemption,
    {
      ...exemption,
      file: "scripts/check-architecture.ts",
      maxEffectiveLines: Number.POSITIVE_INFINITY,
    },
    { ...exemption, file: "scripts/model-change-impact.ts", maxEffectiveLines: 500 },
  ]);

  assert.match(invalid[0] ?? "", /useful maxEffectiveLines cap above 500/);
  assert.match(invalid[1] ?? "", /useful maxEffectiveLines cap above 500/);
  assert.match(invalid[2] ?? "", /useful maxEffectiveLines cap above 500/);
});

test("maintainability function exemptions require named owners and useful caps", () => {
  assert.deepEqual(validateExemptions([{
    file: "scripts/check-maintainability.js",
    reason: "The maintainability runner is one diagnostics owner.",
    maxEffectiveLines: 501,
    functions: [{ name: "run", reason: "The runner keeps one diagnostics lifecycle.", maxEffectiveLines: 81 }],
  }]), []);
  const invalid = validateExemptions([{
    file: "scripts/check-architecture.ts",
    reason: "The architecture checker is one diagnostics owner.",
    maxEffectiveLines: 501,
    functions: [{ name: "", reason: "", maxEffectiveLines: 80 }],
  }]);
  assert.match(invalid[0] ?? "", /function 1 needs a name/);
});

test("maintainability function exemptions apply only to the named function", async () => {
  const body = Array.from({ length: 84 }, (_, index) => `  const value${index} = ${index};`).join("\n");
  const source = `async function drivePi() {\n${body}\n}\nfunction unrelated() {\n${body}\n}\n`;
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(source, { filePath: join(process.cwd(), "src/akuma/providers/pi/index.ts") });
  const findings = result.messages.filter(({ ruleId }) => ruleId === "maintainability/exact-function-lines");
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? "", /unrelated/);
  assert.match(findings[0]?.message ?? "", /Maximum allowed is 80/);
});

test("maintainability hard line limit promotes only above 500 effective lines", () => {
  const [result] = promoteHardLineLimit([{
    messages: [
      { ruleId: "max-lines", messageId: "exceed", message: "File has too many lines (500).", severity: 1 },
      { ruleId: "max-lines", messageId: "exceed", message: "File has too many lines (501).", severity: 1 },
    ],
    errorCount: 0,
    warningCount: 2,
  }]);

  assert.deepEqual(result.messages.map(({ severity }) => severity), [1, 2]);
  assert.equal(result.errorCount, 1);
  assert.equal(result.warningCount, 1);
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
