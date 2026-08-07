import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveContextRoot } from "../src/context-root.js";
import { Tasks } from "../src/task/index.js";

function temporary(): string { return mkdtempSync(join(tmpdir(), "keiyaku-task-root-")); }

test("context root selects the nearest marker and Tasks.at pins it once", () => {
  const outer = temporary(), nested = join(outer, "a"), leaf = join(nested, "b", "c");
  mkdirSync(join(outer, ".keiyaku"));
  mkdirSync(join(nested, ".keiyaku"), { recursive: true });
  mkdirSync(leaf, { recursive: true });
  const tasks = Tasks.at({ path: leaf });
  assert.equal(tasks.root, realpathSync(resolve(nested)));
  mkdirSync(join(leaf, ".keiyaku"));
  assert.equal(tasks.root, realpathSync(resolve(nested)));
  assert.equal(Tasks.at({ path: leaf }).root, realpathSync(resolve(leaf)));
});

test("context root falls back to the starting directory without a marker", () => {
  const root = temporary(), leaf = join(root, "a", "b");
  mkdirSync(leaf, { recursive: true });
  assert.equal(resolveContextRoot({ from: leaf, marker: ".keiyaku" }), realpathSync(resolve(leaf)));
});

test("context root refuses a non-directory marker", () => {
  const root = temporary();
  writeFileSync(join(root, ".keiyaku"), "not a directory");
  assert.throws(() => Tasks.at({ path: root }), /context marker is not a directory/u);
});
