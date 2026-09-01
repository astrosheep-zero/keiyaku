import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import { repositoryAt } from "../src/git/repository.js";
import { resolveCliCoordinates } from "../src/cli/coordinates.js";
import { parseArgv } from "../src/cli/parse.js";
import { World, WorldError } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "keiyaku-world-"));
}

test("CLI coordinates retain explicit versus ambient cwd statedness", async () => {
  const root = temporary();
  const explicit = join(root, "explicit");
  mkdirSync(explicit);
  const command = parseArgv(["call", "worker", "body"]).command;

  const ambient = await resolveCliCoordinates({ processCwd: root, command });
  assert.equal(ambient.cwdSource, "process");
  assert.equal(ambient.cwd, await realpath(root));

  const stated = await resolveCliCoordinates({ processCwd: root, cwd: "explicit", command });
  assert.equal(stated.cwdSource, "input");
  assert.equal(stated.cwd, await realpath(explicit));
});

test("World.locate selects the nearest marker without creating one", async () => {
  const outer = temporary(),
    nested = join(outer, "a"),
    leaf = join(nested, "b", "c");
  mkdirSync(join(outer, ".keiyaku"));
  mkdirSync(join(nested, ".keiyaku"), { recursive: true });
  mkdirSync(leaf, { recursive: true });
  assert.equal(await World.locate(leaf), await realpath(nested));
  const bare = join(temporary(), "leaf");
  mkdirSync(bare);
  assert.equal(await World.locate(bare), null);
  const bareResolution = await World.resolve(bare);
  assert.equal(bareResolution.root, null);
  assert.equal(bareResolution.candidate, await realpath(bare));
  assert.equal(existsSync(join(bare, ".keiyaku")), false);
});

test("World resolution reuses a non-Git ancestor marker while World.at remains exact", async () => {
  const marked = temporary(),
    nested = join(marked, "a", "b");
  mkdirSync(join(marked, ".keiyaku"));
  mkdirSync(nested, { recursive: true });
  const resolution = await World.resolve(nested);
  assert.equal(resolution.root, await realpath(marked));
  assert.equal(resolution.candidate, await realpath(marked));
  assert.equal(await resolution.establish(), await realpath(marked));

  const root = temporary(),
    leaf = join(root, "a", "b");
  mkdirSync(leaf, { recursive: true });
  assert.equal(await World.at(leaf), await realpath(leaf));
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

  const primary = await repositoryAt(repository.path);
  const secondary = await repositoryAt(linked);
  assert.equal(
    await World.locate({ cwd: repository.path, repositoryRoot: primary.primaryWorktree }),
    await realpath(repository.path),
  );
  assert.equal(
    await World.locate({ cwd: nested, repositoryRoot: primary.primaryWorktree }),
    await realpath(repository.path),
  );
  assert.equal(
    await World.locate({ cwd: linked, repositoryRoot: secondary.primaryWorktree }),
    await realpath(repository.path),
  );
});

test("Git reads do not create a marker and Git creation establishes only the primary WorldRoot", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Keiyaku Test"]);
  repository.run(["config", "user.email", "keiyaku@example.invalid"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const linked = temporary();
  repository.run(["worktree", "add", "--quiet", "--detach", linked]);
  const scope = await repositoryAt(linked);

  const world = await World.resolve({ cwd: linked, repositoryRoot: scope.primaryWorktree });
  assert.equal(world.root, await realpath(repository.path));
  assert.equal(world.candidate, await realpath(repository.path));
  assert.equal(existsSync(join(repository.path, ".keiyaku")), false);
  assert.equal(existsSync(join(linked, ".keiyaku")), false);

  assert.equal(await world.establish(), await realpath(repository.path));
  assert.equal(existsSync(join(repository.path, ".keiyaku")), true);
  assert.equal(existsSync(join(linked, ".keiyaku")), false);
});

test("World excludes the user home from locate and exact construction", async () => {
  assert.equal(await World.locate(homedir()), null);
  const resolution = await World.resolve(homedir());
  assert.equal(resolution.candidate, null);
  await assert.rejects(resolution.establish(), (error) => error instanceof WorldError && error.kind === "home-world");
  await assert.rejects(World.at(homedir()), (error) => error instanceof WorldError && error.kind === "home-world");
});

test("World excludes the filesystem root from locate and exact construction", async () => {
  const root = parse(process.cwd()).root;
  assert.equal(await World.locate(root), null);
  const resolution = await World.resolve(root);
  assert.equal(resolution.candidate, null);
  await assert.rejects(resolution.establish(), (error) => error instanceof WorldError && error.kind === "root-world");
  await assert.rejects(World.at(root), (error) => error instanceof WorldError && error.kind === "root-world");
});

test("World.prove mints only an exact canonical directory without writing", async () => {
  const root = temporary();
  const nested = join(root, "nested");
  const nestedMarker = join(nested, ".keiyaku");
  const missing = join(root, "missing");
  const file = join(root, "file");
  const markerFile = join(root, ".keiyaku-file");
  mkdirSync(nested);
  mkdirSync(join(root, ".keiyaku"));
  writeFileSync(file, "not a directory");
  writeFileSync(markerFile, "not a marker directory");
  const canonicalRoot = await realpath(root);
  const canonicalNested = await realpath(nested);
  const link = join(canonicalRoot, "world-link");
  symlinkSync(canonicalRoot, link);
  const before = [canonicalRoot, canonicalNested].map((path) => [path, readdirSync(path).sort()]);

  assert.equal(await World.prove(canonicalRoot), canonicalRoot);
  assert.equal(await World.prove(canonicalNested), canonicalNested);
  await assert.rejects(World.prove(`${canonicalRoot}/.`), (error) => error instanceof WorldError && error.kind === "invalid-world");
  await assert.rejects(World.prove("."), (error) => error instanceof WorldError && error.kind === "invalid-world");
  await assert.rejects(World.prove(link), (error) => error instanceof WorldError && error.kind === "invalid-world");
  await assert.rejects(World.prove(missing), (error) => error instanceof WorldError && error.kind === "invalid-world");
  await assert.rejects(World.prove(file), (error) => error instanceof WorldError && error.kind === "invalid-world");
  await assert.rejects(World.prove(markerFile), (error) => error instanceof WorldError && error.kind === "invalid-world");
  await assert.rejects(World.prove(homedir()), (error) => error instanceof WorldError && error.kind === "home-world");
  await assert.rejects(World.prove(parse(process.cwd()).root), (error) => error instanceof WorldError && error.kind === "root-world");
  assert.equal(existsSync(nestedMarker), false);
  assert.deepEqual(
    [canonicalRoot, canonicalNested].map((path) => [path, readdirSync(path).sort()]),
    before,
  );
});

test("World refuses a non-directory marker", async () => {
  const root = temporary();
  writeFileSync(join(root, ".keiyaku"), "not a directory");
  await assert.rejects(World.locate(root), /world marker is not a directory/u);
  await assert.rejects(World.at(root), /world marker is not a directory/u);
});

test("World refuses a symlink marker instead of following it", async () => {
  const root = temporary();
  const outside = temporary();
  mkdirSync(join(outside, "tasks"));
  symlinkSync(outside, join(root, ".keiyaku"));
  await assert.rejects(World.locate(root), /world marker is not a directory/u);
  await assert.rejects(World.at(root), /world marker is not a directory/u);
});
