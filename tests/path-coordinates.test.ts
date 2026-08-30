import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { resolveCliCoordinates } from "../src/cli/coordinates.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { Keiyaku, Repo } from "../src/index.js";
import { World } from "../src/world.js";
import { registeredWorktrees, repositoryAt } from "../src/git/repository.js";
import { withGitShim } from "./support/git.js";

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

test("Repo, CLI, and World share the canonical coordinate when Git reports an alias", async () => {
  const path = repositoryWithSpaces();
  const canonical = realpathSync(path);
  const alias = join(mkdtempSync(join(tmpdir(), "keiyaku Git alias-")), "repository");
  symlinkSync(canonical, alias, "junction");

  await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
      '  printf "worktree %s\\0HEAD %s\\0branch refs/heads/main\\0\\0" "$KEIYAKU_GIT_ALIAS" "$("$KEIYAKU_REAL_GIT" rev-parse HEAD)"',
      "  exit 0",
      "fi",
      'if [ "$1" = "rev-parse" ] && [ "$3" = "--show-toplevel" ]; then',
      '  printf "%s\\n" "$KEIYAKU_GIT_ALIAS"',
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_GIT_ALIAS: alias },
    async (gitPath) => {
      const repo = await Repo.at({ path, gitPath });
      const command = parseArgv(["-C", path, "--repo", ".", "bind", "-"]).command;
      const coordinates = await resolveCliCoordinates({ processCwd: path, cwd: ".", repo: ".", gitPath, command });

      assert.equal(repo.root, canonical);
      assert.equal(repo.cwd, canonical);
      assert.equal(coordinates.cwd, canonical);
      assert.equal(coordinates.repo?.root, canonical);
      assert.equal(coordinates.world, canonical);
    },
  );
});

test("registered worktrees retain a prunable record below a regular-file parent", async () => {
  const path = repositoryWithSpaces();
  const parent = join(mkdtempSync(join(tmpdir(), "keiyaku missing worktree-")), "not-a-directory");
  writeFileSync(parent, "not a directory");
  const missing = join(parent, "missing");

  await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
      '  printf "worktree %s\\0HEAD %s\\0branch refs/heads/main\\0\\0worktree %s\\0HEAD deadbeef\\0prunable stale\\0\\0" "$KEIYAKU_REPOSITORY" "$("$KEIYAKU_REAL_GIT" rev-parse HEAD)" "$KEIYAKU_MISSING_WORKTREE"',
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_REPOSITORY: path, KEIYAKU_MISSING_WORKTREE: missing },
    async (gitPath) => {
      const worktrees = await registeredWorktrees(await repositoryAt(path, gitPath));
      assert.equal(worktrees.some((worktree) => worktree.path === missing), true);
    },
  );
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
