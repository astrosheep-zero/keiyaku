import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, World } from "../src/index.js";

async function worldFixture(): Promise<string> {
  return await World.at(mkdtempSync(join(tmpdir(), "keiyaku-v4-library-nuke-")));
}

test("confirmed nuke retains the coordination lock marker", async () => {
  const world = await worldFixture();
  try {
    assert.equal(existsSync(join(world, ".keiyaku")), true);
    assert.deepEqual(await Keiyaku.nuke({ world, confirm: world }), { kind: "success", world });
    assert.equal(existsSync(join(world, ".keiyaku")), true);
    assert.equal(existsSync(join(world, ".keiyaku", "locks", "task-allocation.sqlite")), true);
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

test("confirmed nuke retains a nonempty World marker", async () => {
  const world = await worldFixture();
  try {
    const residue = join(world, ".keiyaku", "unknown.bin");
    writeFileSync(residue, "retain\n");
    assert.deepEqual(await Keiyaku.nuke({ world, confirm: world }), { kind: "success", world });
    assert.equal(existsSync(join(world, ".keiyaku")), true);
    assert.equal(existsSync(residue), true);
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});
