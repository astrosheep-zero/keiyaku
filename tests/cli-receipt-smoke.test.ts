import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const packagedCli = join(root, "build", "src", "cli", "index.js");

type RunResult = Readonly<{ code: number; stdout: string; stderr: string }>;

function runCli(args: readonly string[], cwd: string, stdin = ""): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [packagedCli, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runNarrowCli(args: readonly string[], cwd: string, stdin: string): Promise<RunResult> {
  const invocation = [process.execPath, packagedCli, ...args].map(shellQuote).join(" ");
  const command = `stty columns 36 rows 100; printf %s ${shellQuote(stdin)} | ${invocation}`;
  const scriptArgs = process.platform === "darwin"
    ? ["-q", "/dev/null", "sh", "-c", command]
    : ["-q", "-c", command, "/dev/null"];
  return new Promise((resolveRun, reject) => {
    const child = spawn("script", scriptArgs, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({
      code: code ?? 1,
      stdout: stdout.replaceAll("\r", "").replace(/\^D/gu, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ""),
      stderr,
    }));
  });
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).toString();
}

function document(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Exercise the packaged mutation receipt.",
    "",
    "## Objective",
    "Render the accepted mutation as a decision receipt.",
    "",
    "## Design",
    "The receipt remains typed and lossless.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Receipt",
    "The built CLI writes the receipt.",
    "",
  ].join("\n");
}

function repository(settings: Readonly<Record<string, unknown>>): string {
  const path = mkdtempSync(join(tmpdir(), "keiyaku-cli-receipt-smoke-"));
  git(path, ["init", "--quiet", "--initial-branch=main"]);
  git(path, ["config", "user.name", "Keiyaku smoke"]);
  git(path, ["config", "user.email", "keiyaku-smoke@example.invalid"]);
  writeFileSync(join(path, "README.md"), "initial\n");
  mkdirSync(join(path, ".keiyaku"), { recursive: true });
  writeFileSync(join(path, ".keiyaku", "settings.json"), `${JSON.stringify(settings)}\n`);
  git(path, ["add", "README.md", ".keiyaku/settings.json"]);
  git(path, ["commit", "--quiet", "-m", "initial"]);
  return path;
}

test("built CLI renders bind, trailing-gate, complete, and narrow receipts", async () => {
  const gatedRepo = repository({ gates: { default: ["reviewed"], empty: [] } });
  const bound = await runCli(["-C", gatedRepo, "bind", "--here", "--gates", "default", "-"], gatedRepo, document("Gated receipt smoke"));
  assert.equal(bound.code, 0, bound.stderr);
  assert.match(bound.stdout, /^✓ bind accepted — kei\//u);
  const contract = bound.stdout.match(/kei\/[a-z0-9-]+/u)?.[0];
  assert.ok(contract, bound.stdout);

  const trailing = await runCli(["-C", gatedRepo, "deliver", contract], gatedRepo);
  assert.equal(trailing.code, 0, trailing.stderr);
  assert.match(trailing.stdout, /^✓ deliver accepted — /u);
  assert.match(trailing.stdout, /! gate placement/u);

  const reviewed = await runCli(["-C", gatedRepo, "review", contract, "--satisfied", "--summary", "packaged smoke"], gatedRepo);
  assert.equal(reviewed.code, 0, reviewed.stderr);
  assert.match(reviewed.stdout, /^✓ review accepted — /u);
  assert.match(reviewed.stdout, /claimed|placement/u);

  const completeRepo = repository({ gates: { empty: [] } });
  const completeBind = await runCli(["-C", completeRepo, "bind", "--here", "--gates", "empty", "-"], completeRepo, document("Complete receipt smoke"));
  assert.equal(completeBind.code, 0, completeBind.stderr);
  const completeContract = completeBind.stdout.match(/kei\/[a-z0-9-]+/u)?.[0];
  assert.ok(completeContract, completeBind.stdout);
  const complete = await runCli(["-C", completeRepo, "deliver", completeContract], completeRepo);
  assert.equal(complete.code, 0, complete.stderr);
  assert.match(complete.stdout, /^✓ deliver accepted — /u);
  assert.doesNotMatch(complete.stdout, /! gate/u);

  const narrowRepo = repository({ gates: { empty: [] } });
  const narrow = await runNarrowCli(["-C", narrowRepo, "bind", "--here", "--gates", "empty", "-"], narrowRepo, document("Narrow receipt smoke with a deliberately long title"));
  assert.equal(narrow.code, 0, narrow.stderr);
  assert.match(narrow.stdout, /^✓ bind accepted —\n  kei\//u);
});
