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
    process.platform === "win32"
      ? `@echo off\r\nif "%1"=="version" (echo ${version} & exit /b 0)\r\necho mock Zig compiler invoked 1>&2\r\nexit /b 7\r\n`
      : `#!/bin/sh\nif [ "$1" = "version" ]; then\n  printf '%s\\n' '${version}'\n  exit 0\nfi\nprintf '%s\\n' 'mock Zig compiler invoked' >&2\nexit 7\n`,
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

test("a Zig version below 0.14.1 is unusable and skips on non-Windows hosts", () => {
  const result = runLauncher(executableReporting("0.14.0"));

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Zig 0\.14\.1 or later/);
  assert.match(result.stderr, /reported version 0\.14\.0; require at least 0\.14\.1/);
  assert.match(result.stderr, /Skipping Windows launcher on non-Windows host\./);
  assert.doesNotMatch(result.stderr, /mock Zig compiler invoked/);
});

test("a Zig version below 0.14.1 is a hard failure on Windows", () => {
  const result = runLauncher(executableReporting("0.14.0"), "win32");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Zig 0\.14\.1 or later/);
  assert.match(result.stderr, /reported version 0\.14\.0; require at least 0\.14\.1/);
  assert.doesNotMatch(result.stderr, /mock Zig compiler invoked/);
});

for (const version of ["0.14.1", "0.16.0"]) {
  test(`Zig ${version} reaches the Windows launcher compiler`, () => {
    const result = runLauncher(executableReporting(version));

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mock Zig compiler invoked/);
    assert.doesNotMatch(result.stderr, /require at least/);
  });
}
