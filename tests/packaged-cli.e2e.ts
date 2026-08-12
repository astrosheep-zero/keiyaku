import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function command(executable: string, args: readonly string[], cwd: string): string {
  return execFileSync(executable, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

test("published package installs one keiyaku CLI and runs against a real repository", () => {
  const packed = mkdtempSync(join(tmpdir(), "keiyaku-packed-"));
  const installed = mkdtempSync(join(tmpdir(), "keiyaku-installed-"));
  const cache = mkdtempSync(join(tmpdir(), "keiyaku-npm-cache-"));
  const repository = mkdtempSync(join(tmpdir(), "keiyaku-e2e-repo-"));

  command("npm", ["pack", "--ignore-scripts", "--pack-destination", packed], root);
  const archives = readdirSync(packed).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, `expected one package archive, got ${archives.join(", ")}`);

  const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Readonly<Record<string, string>>;
  };
  const dependencies = Object.fromEntries(Object.keys(packageManifest.dependencies ?? {}).map((name) => [
    name,
    `file:${join(root, "node_modules", name)}`,
  ]));
  writeFileSync(join(installed, "package.json"), `${JSON.stringify({
    name: "keiyaku-e2e-consumer",
    private: true,
    dependencies,
  }, null, 2)}\n`);
  command("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    "--package-lock=false",
    "--cache",
    cache,
    join(packed, archives[0]!),
  ], installed);

  const installedPackage = JSON.parse(readFileSync(
    join(installed, "node_modules", "@astrosheep", "keiyaku", "package.json"),
    "utf8",
  )) as { name: string; version: string; bin: Record<string, string> };
  assert.equal(installedPackage.name, "@astrosheep/keiyaku");
  assert.equal(installedPackage.version, "4.0.0");
  assert.deepEqual(installedPackage.bin, { keiyaku: "build/src/cli/index.js" });

  const bin = join(installed, "node_modules", ".bin", "keiyaku");
  assert.equal(existsSync(bin), true);
  assert.equal(existsSync(join(installed, "node_modules", ".bin", "keiyaku-v4")), false);
  const target = join(installed, "node_modules", "@astrosheep", "keiyaku", "build", "src", "cli", "index.js");
  assert.equal(readFileSync(target, "utf8").split("\n", 1)[0], "#!/usr/bin/env node");
  assert.notEqual(statSync(target).mode & 0o111, 0, "installed CLI must be executable");
  assert.match(command(bin, ["--help"], installed), /^usage: keiyaku /m);

  command("git", ["init", "--quiet", "--initial-branch=main", repository], repository);
  command("git", ["config", "user.name", "Keiyaku E2E"], repository);
  command("git", ["config", "user.email", "keiyaku-e2e@example.invalid"], repository);
  writeFileSync(join(repository, "README.md"), "initial\n");
  command("git", ["add", "README.md"], repository);
  command("git", ["commit", "--quiet", "-m", "initial"], repository);
  const status = JSON.parse(command(bin, ["-C", repository, "status", "--json"], repository)) as {
    contracts?: { kind?: string };
  };
  assert.equal(status.contracts?.kind, "present");
});
