import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  allocateAkumaDirectory,
  akuId,
  akuIdFromDirectoryName,
  ensureAkumaRunRoot,
  parseAkuId,
  archetypeName,
} from "../src/akuma/identity.js";
import { parseAkumaAlias } from "../src/identity/selector.js";

test("Aku identity has one exact durable spelling", async () => {
  assert.equal(akuId({ archetype: "claude", suffix: "12ab34cd" }), "aku/claude/12ab34cd");
  assert.deepEqual(parseAkuId("aku/claude/12ab34cd"), {
    id: "aku/claude/12ab34cd",
    archetype: "claude",
    suffix: "12ab34cd",
  });
  assert.throws(() => parseAkuId("a/claude/12ab34cd"), /aku\//);
  assert.throws(() => akuId({ archetype: "Claude", suffix: "12ab34cd" }), /normalized/);
  assert.deepEqual(akuIdFromDirectoryName("claude-fast-12ab34cd"), {
    id: "aku/claude-fast/12ab34cd",
    archetype: "claude-fast",
    suffix: "12ab34cd",
  });
});

test("Akuma archetypes and aliases share bounded canonical name admission", () => {
  for (const name of ["pi-reset-api-review", "审查-二号", "🦈", "9workers", "a".repeat(64), "鱼".repeat(21)]) {
    assert.equal(archetypeName(name), name);
    assert.equal(parseAkumaAlias(`@${name}`), `@${name}`);
  }
  for (const name of ["", "Reviewer", "a--b", "a-", "a/b", "a".repeat(65), "鱼".repeat(22), "🦈".repeat(17)]) {
    assert.throws(() => archetypeName(name), /Akuma name/u);
    assert.throws(() => parseAkumaAlias(`@${name}`), /Akuma alias name/u);
  }
  assert.throws(() => parseAkumaAlias("reviewer"), /start with @/u);
  const historic = `aku/${"a".repeat(65)}/1234abcd`;
  assert.equal(parseAkuId(historic).id, historic);
  assert.throws(() => akuId({ archetype: "a".repeat(65), suffix: "1234abcd" }), /64 UTF-8 bytes/u);
});

test("directory creation is the identity allocation adjudicator", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-identity-");
  const runRoot = await ensureAkumaRunRoot(root);
  mkdirSync(join(runRoot, "claude-00000000"));
  const draws = ["00000000", "11111111"];
  const allocated = await allocateAkumaDirectory({
    worldRoot: root,
    archetype: "claude",
    draw: () => draws.shift()!,
  });
  assert.equal(allocated.id, "aku/claude/11111111");
  assert.equal(existsSync(allocated.paths.directory), true);
  assert.equal(readFileSync(join(runRoot, ".gitignore"), "utf8"), "*\n");
});
