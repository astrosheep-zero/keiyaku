import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import { resolveCliCoordinates } from "../src/cli/coordinates.js";
import { parseArgv as parseInvocation, type ParsedExecution } from "../src/cli/parse.js";
import { World, WorldError } from "../src/world.js";

function parseArgv(argv: readonly string[]): ParsedExecution {
  const parsed = parseInvocation(argv);
  if (!("command" in parsed)) throw new Error("expected executable command");
  return parsed;
}

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
  await assert.rejects(
    World.prove(`${canonicalRoot}/.`),
    (error) => error instanceof WorldError && error.kind === "invalid-world",
  );
  await assert.rejects(World.prove("."), (error) => error instanceof WorldError && error.kind === "invalid-world");
  await assert.rejects(World.prove(link), (error) => error instanceof WorldError && error.kind === "invalid-world");
  await assert.rejects(World.prove(missing), (error) => error instanceof WorldError && error.kind === "invalid-world");
  await assert.rejects(World.prove(file), (error) => error instanceof WorldError && error.kind === "invalid-world");
  await assert.rejects(
    World.prove(markerFile),
    (error) => error instanceof WorldError && error.kind === "invalid-world",
  );
  assert.equal(await World.prove(homedir()), await realpath(homedir()));
  assert.equal(await World.prove(parse(process.cwd()).root), parse(process.cwd()).root);
  assert.equal(existsSync(nestedMarker), false);
  assert.deepEqual(
    [canonicalRoot, canonicalNested].map((path) => [path, readdirSync(path).sort()]),
    before,
  );
});

test("World refuses a symlink marker instead of following it", async () => {
  const root = temporary();
  const outside = temporary();
  mkdirSync(join(outside, "tasks"));
  symlinkSync(outside, join(root, ".keiyaku"));
  await assert.rejects(World.locate(root), /world marker is not a directory/u);
  await assert.rejects(World.at(root), /world marker is not a directory/u);
});
