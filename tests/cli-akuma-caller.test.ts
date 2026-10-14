import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { akumaCallerFromEnvironment } from "../src/cli/akuma-caller.js";
import { temporaryDirectory } from "./support/process.js";

test("CLI caller canonicalizes the actor World, prioritizes the complete pair and splits external identity once", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-cli-caller-");
  const target = join(root, "world");
  mkdirSync(target);
  symlinkSync(target, join(root, "alias"), "dir");
  assert.deepEqual(await akumaCallerFromEnvironment({
    KEIYAKU_ACTOR_ID: "aku/parent/1234abcd", KEIYAKU_ACTOR_WORLD: join(root, "alias"),
    KEIYAKU_EXTERNAL_CALLER: "malformed",
  }), { kind: "akuma", world: realpathSync(target), akuId: "aku/parent/1234abcd" });
  assert.equal(existsSync(join(target, ".keiyaku")), false, "attribution must not establish the caller's World");
  assert.deepEqual(await akumaCallerFromEnvironment({ KEIYAKU_EXTERNAL_CALLER: "slack:channel:thread" }), {
    kind: "external", integration: "slack", id: "channel:thread",
  });
  assert.equal(await akumaCallerFromEnvironment({}), undefined);
  for (const environment of [
    { KEIYAKU_ACTOR_ID: "aku/parent/1234abcd", KEIYAKU_EXTERNAL_CALLER: "slack:external" },
    { KEIYAKU_ACTOR_WORLD: target },
  ]) await assert.rejects(akumaCallerFromEnvironment(environment), /both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD/u);
  await assert.rejects(akumaCallerFromEnvironment({ KEIYAKU_EXTERNAL_CALLER: "missing-colon" }), /<integration>:<id>/u);
});
