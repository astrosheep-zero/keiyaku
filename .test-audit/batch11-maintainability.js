import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

test("maintainability CLI distinguishes warning-only fixtures from actual lint and Markdown errors", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-maintainability-cli-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "src"));
  copyFileSync(maintainabilityCommand, join(directory, "scripts", "check-maintainability.js"));
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "junction");
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(directory, "eslint.config.js"),
    'export default [{ files: ["src/**/*.js"], rules: { "no-constant-condition": "error" } }];',
  );
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const errors of [false, true]) {
    writeFileSync(join(directory, "limit.md"), "a".repeat(errors ? 30_001 : 20_001));
    writeFileSync(join(directory, "src", "probe.js"), errors ? 'if (true) console.log("bad");' : 'console.log("ok");');
    const result = spawnSync(process.execPath, [join(directory, "scripts", "check-maintainability.js")], {
      cwd: directory,
      encoding: "utf8",
      env,
    });
    const output = `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;]*m/gu, "");
    assert.equal(result.status, errors ? 1 : 0, output);
    assert.match(output, /markdown character limits:/u);
    assert.ok(
      output.includes(`${errors ? "error" : "warning"}: limit.md has ${errors ? 30_001 : 20_001} characters`),
      output,
    );
    if (errors) assert.match(output, /no-constant-condition/u);
    else assert.doesNotMatch(output, /no-constant-condition/u);
  }
});
