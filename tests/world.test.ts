import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { World, WorldError } from "../src/world.js";

function temporary(): string { return mkdtempSync(join(tmpdir(), "keiyaku-world-")); }

test("World.locate selects the nearest marker without creating one", () => {
  const outer = temporary(), nested = join(outer, "a"), leaf = join(nested, "b", "c");
  mkdirSync(join(outer, ".keiyaku"));
  mkdirSync(join(nested, ".keiyaku"), { recursive: true });
  mkdirSync(leaf, { recursive: true });
  assert.equal(World.locate(leaf), realpathSync(nested));
  const bare = join(temporary(), "leaf"); mkdirSync(bare);
  assert.equal(World.locate(bare), null);
  assert.equal(existsSync(join(bare, ".keiyaku")), false);
});

test("World.at establishes only the exact directory", () => {
  const root = temporary(), leaf = join(root, "a", "b"); mkdirSync(leaf, { recursive: true });
  assert.equal(World.at(leaf), realpathSync(leaf));
  assert.equal(existsSync(join(leaf, ".keiyaku")), true);
  assert.equal(existsSync(join(root, ".keiyaku")), false);
});

test("World excludes the user home from locate and exact construction", () => {
  assert.equal(World.locate(homedir()), null);
  assert.throws(() => World.at(homedir()), (error) => error instanceof WorldError && error.kind === "home-world");
});

test("World refuses a non-directory marker", () => {
  const root = temporary(); writeFileSync(join(root, ".keiyaku"), "not a directory");
  assert.throws(() => World.locate(root), /world marker is not a directory/u);
  assert.throws(() => World.at(root), /world marker is not a directory/u);
});
