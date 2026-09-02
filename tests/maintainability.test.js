import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  markdownCharacterCount,
  markdownCharacterFindings,
  markdownCharacterSeverity,
} from "../scripts/check-maintainability.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const maintainabilityCommand = join(root, "scripts", "check-maintainability.js");

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

test("maintainability command prints diagnostics and fails only when errors remain", () => {
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  const result = spawnSync(process.execPath, [maintainabilityCommand], { cwd: root, encoding: "utf8", env });
  const output = `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;]*m/gu, "");
  const findings = markdownCharacterFindings(root);
  const markdownErrors = findings.filter((finding) => finding.severity === "error");
  const stylishErrors = output.match(/^\s+\d+:\d+\s+error\b/gmu) ?? [];
  if (findings.length > 0) {
    assert.match(output, /markdown character limits:/u);
    for (const finding of findings) {
      assert.equal(
        output.includes(`${finding.severity}: ${finding.file} has ${finding.characters} characters`),
        true,
      );
    }
  }
  if (stylishErrors.length > 0) {
    assert.match(output, /[✖x]\s+\d+\s+problem/u);
  }
  assert.equal(result.status, markdownErrors.length > 0 || stylishErrors.length > 0 ? 1 : 0);
  assert.notEqual(result.status, null);
});
