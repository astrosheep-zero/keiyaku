import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveAlias, readAliases, resolveAlias } from "../src/alias/index.js";
import { parseAkuId } from "../src/akuma/identity.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { contractId } from "../src/core/facts/types.js";
import { publishDispatch, readDispatch, readDispatches } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { makeGitRepository } from "./support/git.js";

test("Dispatch publishes one immutable association and preserves its first timestamp", async () => {
  const raw = makeGitRepository();
  const repository = repositoryAt(raw.path);
  const akuma = parseAkuId("aku/worker/1234abcd").id;
  const owner = contractId("kei/dispatch-owner");

  assert.equal(readDispatch(repository, akuma), null);
  const first = publishDispatch({ repository, akuId: akuma, contractId: owner });
  assert.equal(first.kind, "dispatched");
  if (first.kind !== "dispatched") return;
  assert.deepEqual(readDispatch(repository, akuma), first.dispatch);
  assert.deepEqual(await readDispatches(repository), [first.dispatch]);

  const repeated = publishDispatch({ repository, akuId: akuma, contractId: owner });
  assert.deepEqual(repeated, first);
  const conflict = publishDispatch({
    repository,
    akuId: akuma,
    contractId: contractId("kei/other-owner"),
  });
  assert.deepEqual(conflict, {
    kind: "failed",
    failure: { kind: "conflict", current: first.dispatch },
  });
});

test("Alias moves are serialized, canonical, and expose the previous target", async () => {
  const world = mkdtempSync(join(tmpdir(), "keiyaku-alias-"));
  const alpha = parseAkumaAlias("@alpha");
  const beta = parseAkumaAlias("@beta");
  const first = parseAkuId("aku/worker/11111111").id;
  const second = parseAkuId("aku/reviewer/22222222").id;
  try {
    await Promise.all([
      moveAlias({ world, alias: beta, akuId: second }),
      moveAlias({ world, alias: alpha, akuId: first }),
    ]);
    assert.deepEqual(readAliases(world), [
      { alias: alpha, akuId: first },
      { alias: beta, akuId: second },
    ]);
    assert.equal(readFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "utf8"),
      '{"version":1,"aliases":{"@alpha":"aku/worker/11111111","@beta":"aku/reviewer/22222222"}}\n');

    assert.deepEqual(await moveAlias({ world, alias: alpha, akuId: second }), {
      alias: { alias: alpha, akuId: second },
      previous: first,
    });
    assert.equal(resolveAlias(world, alpha), second);
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

test("Alias corruption is visible instead of becoming an empty authority", () => {
  const world = mkdtempSync(join(tmpdir(), "keiyaku-alias-corrupt-"));
  const directory = join(world, ".keiyaku", "akuma");
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "alias.json"), '{"version":1,"aliases":{"@bad":"not-an-aku"}}\n');
    assert.throws(() => readAliases(world), AuthorityCorruptionError);
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

test("Alias world coordinates never fall back to process cwd", () => {
  assert.throws(() => readAliases(""), /Alias world must be a nonblank path/u);
});
