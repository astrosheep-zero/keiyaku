import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import { repositoryAt } from "../src/git/repository.js";
import { World, WorldError } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";

function temporary(): string { return mkdtempSync(join(tmpdir(), "keiyaku-world-")); }

test("World.locate selects the nearest marker without creating one", async () => {
  const outer = temporary(), nested = join(outer, "a"), leaf = join(nested, "b", "c");
  mkdirSync(join(outer, ".keiyaku"));
  mkdirSync(join(nested, ".keiyaku"), { recursive: true });
  mkdirSync(leaf, { recursive: true });
  assert.equal(await World.locate(leaf), realpathSync(nested));
  const bare = join(temporary(), "leaf"); mkdirSync(bare);
  assert.equal(await World.locate(bare), null);
  assert.equal(existsSync(join(bare, ".keiyaku")), false);
});

test("World resolution reuses a non-Git ancestor marker while World.at remains exact", async () => {
  const marked = temporary(), nested = join(marked, "a", "b");
  mkdirSync(join(marked, ".keiyaku"));
  mkdirSync(nested, { recursive: true });
  const resolution = await World.resolve(nested);
  assert.equal(resolution.root, realpathSync(marked));
  assert.equal(await resolution.establish(), realpathSync(marked));

  const root = temporary(), leaf = join(root, "a", "b"); mkdirSync(leaf, { recursive: true });
  assert.equal(await World.at(leaf), realpathSync(leaf));
  assert.equal(existsSync(join(leaf, ".keiyaku")), true);
  assert.equal(existsSync(join(root, ".keiyaku")), false);
});

test("one Git repository resolves one WorldRoot from primary, subdirectory, and linked worktree", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Keiyaku Test"]);
  repository.run(["config", "user.email", "keiyaku@example.invalid"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const nested = join(repository.path, "a", "b");
  const linked = temporary();
  mkdirSync(nested, { recursive: true });
  repository.run(["worktree", "add", "--quiet", "--detach", linked]);
  mkdirSync(join(linked, ".keiyaku"));

  const primary = repositoryAt(repository.path);
  const secondary = repositoryAt(linked);
  assert.equal(await World.locate({ cwd: repository.path, repositoryRoot: primary.primaryWorktree }), realpathSync(repository.path));
  assert.equal(await World.locate({ cwd: nested, repositoryRoot: primary.primaryWorktree }), realpathSync(repository.path));
  assert.equal(await World.locate({ cwd: linked, repositoryRoot: secondary.primaryWorktree }), realpathSync(repository.path));
});

test("Git reads do not create a marker and Git creation establishes only the primary WorldRoot", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Keiyaku Test"]);
  repository.run(["config", "user.email", "keiyaku@example.invalid"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const linked = temporary();
  repository.run(["worktree", "add", "--quiet", "--detach", linked]);
  const scope = repositoryAt(linked);

  const world = await World.resolve({ cwd: linked, repositoryRoot: scope.primaryWorktree });
  assert.equal(world.root, realpathSync(repository.path));
  assert.equal(existsSync(join(repository.path, ".keiyaku")), false);
  assert.equal(existsSync(join(linked, ".keiyaku")), false);

  assert.equal(await world.establish(), realpathSync(repository.path));
  assert.equal(existsSync(join(repository.path, ".keiyaku")), true);
  assert.equal(existsSync(join(linked, ".keiyaku")), false);
});

test("World excludes the user home from locate and exact construction", async () => {
  assert.equal(await World.locate(homedir()), null);
  await assert.rejects(World.at(homedir()), (error) => error instanceof WorldError && error.kind === "home-world");
});

test("World excludes the filesystem root from locate and exact construction", async () => {
  const root = parse(process.cwd()).root;
  assert.equal(await World.locate(root), null);
  await assert.rejects(World.at(root), (error) => error instanceof WorldError && error.kind === "root-world");
});

test("World refuses a non-directory marker", async () => {
  const root = temporary(); writeFileSync(join(root, ".keiyaku"), "not a directory");
  await assert.rejects(World.locate(root), /world marker is not a directory/u);
  await assert.rejects(World.at(root), /world marker is not a directory/u);
});
