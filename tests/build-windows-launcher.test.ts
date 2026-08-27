import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts/build-windows-launcher.js");

function missingExecutable(): string {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-missing-zig-"));
  const executable = join(directory, "missing-zig");
  rmSync(directory, { recursive: true, force: true });
  return executable;
}

function executableReporting(version: string): string {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-zig-version-"));
  const executable = join(directory, process.platform === "win32" ? "zig.cmd" : "zig");
  writeFileSync(
    executable,
    process.platform === "win32" ? `@echo off\r\nif "%1"=="version" echo ${version}\r\n` : `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

function runLauncher(zig: string, platform = "darwin"): { status: number | null; stdout: string; stderr: string } {
  const environment = { ...process.env, KEIYAKU_ZIG: zig };
  const args = [
    "--input-type=module",
    "--eval",
    `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} }); await import(${JSON.stringify(
      pathToFileURL(script).href,
    )});`,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("missing Zig skips only the Windows launcher on non-Windows hosts", () => {
  const result = runLauncher(missingExecutable());

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Zig 0\.14\.1/);
  assert.match(result.stderr, /PATH/);
  assert.match(result.stderr, /KEIYAKU_ZIG/);
  assert.match(result.stderr, /Skipping Windows launcher on non-Windows host\./);
  assert.match(result.stderr, /ENOENT/);
});

test("missing Zig fails with an actionable diagnostic on Windows", () => {
  const result = runLauncher(missingExecutable(), "win32");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Zig 0\.14\.1/);
  assert.match(result.stderr, /PATH/);
  assert.match(result.stderr, /KEIYAKU_ZIG/);
  assert.match(result.stderr, /ENOENT/);
});

test("a Zig version other than 0.14.1 is unusable and skips on non-Windows hosts", () => {
  const result = runLauncher(executableReporting("0.16.0"));

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Zig 0\.14\.1/);
  assert.match(result.stderr, /reported version 0\.16\.0; expected 0\.14\.1/);
  assert.match(result.stderr, /Skipping Windows launcher on non-Windows host\./);
});

test("a Zig version other than 0.14.1 is a hard failure on Windows", () => {
  const result = runLauncher(executableReporting("0.16.0"), "win32");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Zig 0\.14\.1/);
  assert.match(result.stderr, /reported version 0\.16\.0; expected 0\.14\.1/);
});
