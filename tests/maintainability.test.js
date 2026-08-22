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
    file: "src/akuma/provider.ts",
    reason: "The provider adapter is one diagnostics owner.",
    maxEffectiveLines: 501,
  }]), []);

  const invalid = validateExemptions([
    { file: "src/**/*.ts" },
    { file: "src/missing.ts" },
  ]);
  assert.match(invalid[0] ?? "", /exact normalized relative file path/);
  assert.match(invalid[1] ?? "", /targets missing file/);
});

test("maintainability exemptions reject existing directories", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src", "directory"), { recursive: true });

  const errors = validateExemptions([{
    file: "src/directory",
    reason: "Fixture exemption.",
    maxEffectiveLines: 501,
  }], root);

  assert.match(errors[0] ?? "", /targets non-file path src\/directory/);
});

test("maintainability max-lines exemptions require useful effective-line caps", () => {
  const exemption = {
    file: "src/akuma/providers/pi/index.ts",
    reason: "The provider adapter is one diagnostics owner.",
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
    file: "src/akuma/providers/pi/index.ts",
    reason: "The provider adapter is one diagnostics owner.",
    functions: [{ name: "drivePi", reason: "The provider keeps one session lifecycle.", maxEffectiveLines: 99 }],
  }]), []);
  const invalid = validateExemptions([{
    file: "scripts/check-architecture.ts",
    reason: "The architecture checker is one diagnostics owner.",
    maxEffectiveLines: 501,
    functions: [{ name: "", reason: "", maxEffectiveLines: 80 }],
  }]);
  assert.match(invalid[0] ?? "", /function 1 needs a name/);
});

test("maintainability file exemptions reject measured stale effective-line counts", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "stale.ts"), "const value = 1;\n// ignored\n");

  const errors = validateExemptions([{
    file: "src/stale.ts",
    reason: "Fixture exemption.",
    maxEffectiveLines: 501,
  }], root);

  assert.match(errors[0] ?? "", /file src\/stale\.ts is stale at 1 effective lines/);
});

test("maintainability named-function exemptions reject measured stale effective-line counts", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "stale.ts"), "function staleOwner() {\n  return 1;\n}\n");

  const errors = validateExemptions([{
    file: "src/stale.ts",
    reason: "Fixture exemption.",
    functions: [{ name: "staleOwner", reason: "Fixture function exemption.", maxEffectiveLines: 81 }],
  }], root);

  assert.match(errors[0] ?? "", /function staleOwner in src\/stale\.ts is stale at 3 effective lines/);
});

test("maintainability named arrow-function exemptions use AST names", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "arrow.ts"), "const arrowOwner = () => {\n  return 1;\n};\n");

  const errors = validateExemptions([{
    file: "src/arrow.ts",
    reason: "Fixture exemption.",
    functions: [{ name: "arrowOwner", reason: "Fixture function exemption.", maxEffectiveLines: 81 }],
  }], root);

  assert.match(errors[0] ?? "", /function arrowOwner in src\/arrow\.ts is stale at 3 effective lines/);
});

test("maintainability exemptions remain valid above their stale boundaries", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "retained.ts"), Array.from({ length: 401 }, (_, index) => `const value${index} = ${index};`).join("\n"));
  writeFileSync(join(root, "src", "retained-function.ts"), `function retainedOwner() {\n${Array.from({ length: 79 }, (_, index) => `  const value${index} = ${index};`).join("\n")}\n}`);

  assert.deepEqual(validateExemptions([{
    file: "src/retained.ts",
    reason: "Fixture exemption.",
    maxEffectiveLines: 501,
  }], root), []);
  assert.deepEqual(validateExemptions([{
    file: "src/retained-function.ts",
    reason: "Fixture exemption.",
    functions: [{ name: "retainedOwner", reason: "Fixture function exemption.", maxEffectiveLines: 81 }],
  }], root), []);
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
