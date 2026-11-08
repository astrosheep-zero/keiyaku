import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  allocateAkumaDirectory,
  akumaId,
  akumaIdFromDirectoryName,
  ensureAkumaRunRoot,
  parseAkumaId,
} from "../src/akuma/identity.js";
import { validateAkumaName } from "../src/identity/normalize.js";
import { matchesAkumaGlob, parseAkumaAlias, parseAkumaGlob } from "../src/identity/selector.js";

test("Aku identity has one exact durable spelling", async () => {
  assert.equal(akumaId({ akumaName: "claude", suffix: "12ab34cd" }), "aku/claude/12ab34cd");
  assert.deepEqual(parseAkumaId("aku/claude/12ab34cd"), {
    id: "aku/claude/12ab34cd",
    akumaName: "claude",
    suffix: "12ab34cd",
  });
  assert.throws(() => parseAkumaId("a/claude/12ab34cd"), /aku\//);
  assert.throws(() => akumaId({ akumaName: "Claude", suffix: "12ab34cd" }), /normalized/);
  assert.deepEqual(akumaIdFromDirectoryName("claude-fast-12ab34cd"), {
    id: "aku/claude-fast/12ab34cd",
    akumaName: "claude-fast",
    suffix: "12ab34cd",
  });
});

test("Akuma archetypes and aliases share bounded canonical name admission", () => {
  for (const name of ["pi-reset-api-review", "审查-二号", "🦈", "9workers", "review.v2", "a.b.c", "a".repeat(64), "鱼".repeat(21)]) {
    assert.equal(validateAkumaName(name), name);
    assert.equal(parseAkumaAlias(`@${name}`), `@${name}`);
  }
  for (const name of ["", "Reviewer", "a--b", "a-", "a/b", ".foo", "foo.", "foo..bar", "foo.-bar", "..", "a".repeat(65), "鱼".repeat(22), "🦈".repeat(17)]) {
    assert.throws(() => validateAkumaName(name), /Akuma name/u);
    assert.throws(() => parseAkumaAlias(`@${name}`), /Akuma alias name/u);
  }
  assert.throws(() => parseAkumaAlias("reviewer"), /start with @/u);
  const historic = `aku/${"a".repeat(65)}/1234abcd`;
  assert.equal(parseAkumaId(historic).id, historic);
  assert.throws(() => akumaId({ akumaName: "a".repeat(65), suffix: "1234abcd" }), /64 UTF-8 bytes/u);
});

test("Akuma globs treat dots as literal name characters", () => {
  const glob = parseAkumaGlob("aku/review.v2/*");
  assert.ok(matchesAkumaGlob(glob, "aku/review.v2/12ab34cd"));
  assert.ok(!matchesAkumaGlob(glob, "aku/reviewxv2/12ab34cd"));
  assert.throws(() => parseAkumaGlob("aku/review..v2/*"), /Akuma glob/u);
});

test("directory creation is the identity allocation adjudicator", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-identity-");
  const runRoot = await ensureAkumaRunRoot(root);
  mkdirSync(join(runRoot, "claude-00000000"));
  const draws = ["00000000", "11111111"];
  const allocated = await allocateAkumaDirectory({
    worldRoot: root,
    akumaName: "claude",
    draw: () => draws.shift()!,
  });
  assert.equal(allocated.id, "aku/claude/11111111");
  assert.equal(existsSync(allocated.paths.directory), true);
  assert.equal(readFileSync(join(runRoot, ".gitignore"), "utf8"), "*\n");
});
