import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function command(executable: string, args: readonly string[], cwd: string, shell = false): string {
  return execFileSync(executable, args, {
    cwd,
    encoding: "utf8",
    shell,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

function npmCommand(args: readonly string[], cwd: string): string {
  return command(process.platform === "win32" ? "npm.cmd" : "npm", args, cwd, process.platform === "win32");
}

function installedCommand(args: readonly string[], cwd: string): string {
  return command(
    process.execPath,
    [join(cwd, "node_modules", "@astrosheep", "keiyaku", "build", "src", "cli", "index.js"), ...args],
    cwd,
  );
}

test("published package installs one keiyaku CLI and runs against a real repository", () => {
  const packed = mkdtempSync(join(tmpdir(), "keiyaku-packed-"));
  const installed = mkdtempSync(join(tmpdir(), "keiyaku-installed-"));
  const cache = mkdtempSync(join(tmpdir(), "keiyaku-npm-cache-"));
  const repository = mkdtempSync(join(tmpdir(), "keiyaku-e2e-repo-"));

  npmCommand(["pack", "--ignore-scripts", "--pack-destination", packed, "--cache", cache], root);
  const archives = readdirSync(packed).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, `expected one package archive, got ${archives.join(", ")}`);
  const packageArchive = join(packed, archives[0]!);
  const listing = command("tar", ["-tzf", packageArchive], root);
  assert.ok(listing.split(/\r?\n/u).includes("package/build/src/runtime/proc/windows-launch.exe"));
  const claudePackage = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  npmCommand(["pack", "--ignore-scripts", "--pack-destination", packed, "--cache", cache], claudePackage);
  const claudeArchives = readdirSync(packed).filter(
    (name) => name.startsWith("anthropic-ai-claude-agent-sdk-") && name.endsWith(".tgz"),
  );
  assert.equal(claudeArchives.length, 1, `expected one Claude package archive, got ${claudeArchives.join(", ")}`);

  const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Readonly<Record<string, string>>;
    version: string;
  };
  const dependencies = Object.fromEntries(
    Object.keys(packageManifest.dependencies ?? {}).map((name) => [
      name,
      name === "@anthropic-ai/claude-agent-sdk"
        ? `file:${join(packed, claudeArchives[0]!)}`
        : `file:${join(root, "node_modules", name)}`,
    ]),
  );
  writeFileSync(
    join(installed, "package.json"),
    `${JSON.stringify(
      {
        name: "keiyaku-e2e-consumer",
        private: true,
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  npmCommand(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--legacy-peer-deps",
      "--no-bin-links",
      "--package-lock=false",
      packageArchive,
    ],
    installed,
  );

  const installedPackage = JSON.parse(
    readFileSync(join(installed, "node_modules", "@astrosheep", "keiyaku", "package.json"), "utf8"),
  ) as { name: string; version: string; bin: Record<string, string> };
  assert.equal(installedPackage.name, "@astrosheep/keiyaku");
  assert.equal(installedPackage.version, packageManifest.version);
  assert.deepEqual(installedPackage.bin, { keiyaku: "build/src/cli/index.js" });

  const target = join(installed, "node_modules", "@astrosheep", "keiyaku", "build", "src", "cli", "index.js");
  assert.equal(readFileSync(target, "utf8").split("\n", 1)[0], "#!/usr/bin/env node");
  if (process.platform !== "win32") {
    assert.notEqual(statSync(target).mode & 0o111, 0, "installed CLI must be executable");
  }
  const claudeSdk = join(installed, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  renameSync(claudeSdk, `${claudeSdk}.hidden`);
  assert.match(installedCommand(["--help"], installed), /^usage: keiyaku /m);

  command("git", ["init", "--quiet", "--initial-branch=main", repository], repository);
  command("git", ["config", "user.name", "Keiyaku E2E"], repository);
  command("git", ["config", "user.email", "keiyaku-e2e@example.invalid"], repository);
  writeFileSync(join(repository, "README.md"), "initial\n");
  command("git", ["add", "README.md"], repository);
  command("git", ["commit", "--quiet", "-m", "initial"], repository);
  const status = JSON.parse(installedCommand(["-C", repository, "status", "--json"], installed)) as {
    contracts?: { kind?: string };
  };
  assert.equal(status.contracts?.kind, "present");

  const providerRegistry = join(
    installed,
    "node_modules",
    "@astrosheep",
    "keiyaku",
    "build",
    "src",
    "akuma",
    "providers",
    "index.js",
  );
  const inspect = (source: readonly string[]): string =>
    command(
      "node",
      ["--input-type=module", "--eval", source.join("\n"), pathToFileURL(providerRegistry).href],
      installed,
    );
  assert.deepEqual(
    JSON.parse(
      inspect([
        "const { decodeProviderExecution } = await import(process.argv.at(-1));",
        'process.stdout.write(JSON.stringify(decodeProviderExecution({ name: "claude", kind: "claude-agent-sdk" })));',
      ]),
    ),
    { name: "claude", kind: "claude-agent-sdk" },
  );
  assert.deepEqual(
    JSON.parse(
      inspect([
        "const { resolveProviderExecution } = await import(process.argv.at(-1));",
        'const selected = await resolveProviderExecution({ name: "pi", kind: "pi" });',
        "process.stdout.write(JSON.stringify({",
        "  name: selected.execution.name,",
        "  kind: selected.execution.kind,",
        "  hasStart: typeof selected.adapter.start === 'function',",
        "}));",
      ]),
    ),
    { name: "pi", kind: "pi", hasStart: true },
  );
  assert.deepEqual(
    JSON.parse(
      inspect([
        "const { resolveProviderExecution } = await import(process.argv.at(-1));",
        'const selected = await resolveProviderExecution({ name: "claude", kind: "claude-agent-sdk" });',
        "process.stdout.write(JSON.stringify({",
        "  name: selected.execution.name,",
        "  kind: selected.execution.kind,",
        "  hasStart: typeof selected.adapter.start === 'function',",
        "}));",
      ]),
    ),
    { name: "claude", kind: "claude-agent-sdk", hasStart: true },
  );
  assert.throws(
    () =>
      inspect([
        "const { resolveProviderExecution } = await import(process.argv.at(-1));",
        'const selected = await resolveProviderExecution({ name: "claude", kind: "claude-agent-sdk" });',
        'await selected.adapter.start({ body: "start", launchTells: [], cwd: process.cwd(), options: {}, session: { kind: "fresh" } }).result;',
      ]),
    /Cannot find package/u,
  );
});

test("Windows packaging refuses a missing or corrupt launcher artifact", (t) => {
  if (process.platform !== "win32") {
    t.skip("the native release guard runs on Windows");
    return;
  }
  const artifact = join(root, "build", "src", "runtime", "proc", "windows-launch.exe");
  const backup = join(mkdtempSync(join(tmpdir(), "keiyaku-launcher-backup-")), "windows-launch.exe");
  const packed = mkdtempSync(join(tmpdir(), "keiyaku-launcher-refusal-"));
  copyFileSync(artifact, backup);
  try {
    writeFileSync(artifact, "corrupt");
    assert.throws(() => npmCommand(["pack", "--pack-destination", packed], root), /not a PE image/u);
    assert.equal(readdirSync(packed).filter((name) => name.endsWith(".tgz")).length, 0);
    unlinkSync(artifact);
    assert.throws(() => npmCommand(["pack", "--pack-destination", packed], root), /artifact is missing/u);
    assert.equal(readdirSync(packed).filter((name) => name.endsWith(".tgz")).length, 0);
  } finally {
    copyFileSync(backup, artifact);
  }
});
