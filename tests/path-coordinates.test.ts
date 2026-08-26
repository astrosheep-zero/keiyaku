import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { resolveCliCoordinates } from "../src/cli/coordinates.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { Keiyaku, Repo } from "../src/index.js";
import { World } from "../src/world.js";

function repositoryWithSpaces(): string {
  const parent = mkdtempSync(join(tmpdir(), "keiyaku coordinates with spaces-"));
  const path = join(parent, "repository with spaces");
  mkdirSync(path);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path]);
  execFileSync("git", ["-C", path, "config", "user.name", "Keiyaku Test"]);
  execFileSync("git", ["-C", path, "config", "user.email", "keiyaku-test@example.invalid"]);
  execFileSync("git", ["-C", path, "commit", "--quiet", "--allow-empty", "-m", "initial"]);
  return path;
}

test("CLI and Repo canonicalize a relative repository coordinate with spaces", async () => {
  const path = repositoryWithSpaces();
  const alias = relative(process.cwd(), path);
  const canonical = realpathSync(path);

  const fromAlias = await Repo.at({ path: alias });
  const fromCanonical = await Repo.at({ path });
  assert.equal(fromAlias.root, canonical);
  assert.equal(fromAlias.cwd, canonical);
  assert.equal(fromCanonical.root, canonical);
  assert.equal(await fromAlias.currentBranch(), "refs/heads/main");

  const command = parseArgv(["-C", alias, "--repo", ".", "bind", "-"]).command;
  const coordinates = await resolveCliCoordinates({
    processCwd: process.cwd(),
    cwd: alias,
    repo: ".",
    command,
  });
  assert.equal(coordinates.cwd, canonical);
  assert.equal(coordinates.repo?.root, canonical);
  assert.equal(coordinates.world, canonical);
  assert.equal((await World.resolve({ cwd: alias, repositoryRoot: fromAlias.root })).root, canonical);
});

function contractDocument(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Path input reaches the native CLI boundary.",
    "",
    "## Objective",
    "Create one managed worktree.",
    "",
    "## Design",
    "Keep filesystem coordinates native.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Coordinate accepted",
    "The contract binds through the CLI.",
    "",
  ].join("\n");
}

test("CLI accepts native repository coordinate spellings through managed worktree creation", async () => {
  const path = repositoryWithSpaces();
  const coordinates = process.platform === "win32" ? [path, path.replaceAll("\\", "/")] : [path];

  for (const [index, coordinate] of coordinates.entries()) {
    const result = await invoke(parseArgv(["-C", coordinate, "--repo", ".", "bind", "-"]), {
      cwd: process.cwd(),
      environment: {},
      readStdin: () => contractDocument(`Native coordinate ${index}`),
    });
    assert.equal(result.kind, "accepted");
    if (result.kind !== "accepted") continue;
    const row = (await Keiyaku.list({ repo: await Repo.at({ path }) })).rows.find(
      (candidate) => candidate.id === result.contract,
    );
    assert.notEqual(row?.worktreePath, null);
    if (row?.worktreePath !== null && row?.worktreePath !== undefined) assert.equal(existsSync(row.worktreePath), true);
  }
});
