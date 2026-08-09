import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  allocateAkumaDirectory,
  akuId,
  akuIdFromDirectoryName,
  ensureAkumaRunRoot,
  parseAkuId,
} from "../src/akuma/identity.js";

test("Aku identity has one exact durable spelling", () => {
  assert.equal(akuId({ persona: "claude", suffix: "12ab34cd" }), "aku/claude/12ab34cd");
  assert.deepEqual(parseAkuId("aku/claude/12ab34cd"), {
    id: "aku/claude/12ab34cd",
    persona: "claude",
    suffix: "12ab34cd",
  });
  assert.throws(() => parseAkuId("a/claude/12ab34cd"), /aku\//);
  assert.throws(() => akuId({ persona: "Claude", suffix: "12ab34cd" }), /normalized/);
  assert.deepEqual(akuIdFromDirectoryName("claude-fast-12ab34cd"), {
    id: "aku/claude-fast/12ab34cd",
    persona: "claude-fast",
    suffix: "12ab34cd",
  });
});

test("directory creation is the identity allocation adjudicator", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-identity-"));
  try {
    const runRoot = ensureAkumaRunRoot(root);
    mkdirSync(join(runRoot, "claude-00000000"));
    const draws = ["00000000", "11111111"];
    const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => draws.shift()! });
    assert.equal(allocated.id, "aku/claude/11111111");
    assert.equal(existsSync(allocated.paths.directory), true);
    assert.equal(readFileSync(join(runRoot, ".gitignore"), "utf8"), "*\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
