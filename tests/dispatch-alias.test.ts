import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { moveAlias, readAliases } from "../src/alias/index.js";
import { parseAkumaId, type AkumaId } from "../src/akuma/identity.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { contractId } from "../src/core/facts/types.js";
import { observeDispatchAssociations, publishDispatch, readDispatch, readDispatches } from "../src/dispatch/index.js";
import { Akumas, Repo, World } from "../src/index.js";
import { isolateUserHome } from "./support/user-home.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import {
  GIT_REF,
  readGitPaths,
  repositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeStateCommit,
} from "../src/git/repository.js";
import type { GitRepository } from "../src/git/process.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import type { WorldRoot } from "../src/world.js";
import { makeGitRepository, waitForFile } from "./support/git.js";

isolateUserHome();

test("Dispatch publishes one immutable association and preserves its first timestamp", async () => {
  const raw = makeGitRepository();
  const repository = await repositoryAt(raw.path);
  const akuma = parseAkumaId("aku/worker/1234abcd").id;
  const owner = contractId("kei/dispatch-owner");

  assert.equal(await readDispatch(repository, akuma), null);
  const first = await publishDispatch({ repository, akumaId: akuma, contractId: owner });
  assert.ok(first.kind === "dispatched", 'expected first.kind = "dispatched"');
  assert.deepEqual(await readDispatch(repository, akuma), first.dispatch);
  assert.deepEqual(await readDispatches(repository), [first.dispatch]);

  const repeated = await publishDispatch({ repository, akumaId: akuma, contractId: owner });
  assert.deepEqual(repeated, first);
  const conflict = await publishDispatch({
    repository,
    akumaId: akuma,
    contractId: contractId("kei/other-owner"),
  });
  assert.deepEqual(conflict, {
    kind: "failed",
    failure: { kind: "conflict", current: first.dispatch },
  });
});

test("an interrupted real Git CAS confirms the originally published Dispatch", { timeout: 20_000 }, async () => {
  const raw = makeGitRepository();
  const repository = await repositoryAt(raw.path);
  const marker = join(raw.path, "ref-committed");
  const hook = join(repository.commonDirectory, "hooks", "reference-transaction");
  mkdirSync(join(repository.commonDirectory, "hooks"), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\nif [ "$1" = committed ]; then\n  : > ${JSON.stringify(marker.replaceAll("\\", "/"))}\n  sleep 30\nfi\n`, { mode: 0o755 });
  const signal = new AbortController();
  const akumaId = parseAkumaId("aku/worker/1212abcd").id;
  const owner = contractId("kei/cas-read-back");
  const offer = publishDispatch({ repository: { ...repository, signal: signal.signal }, akumaId, contractId: owner, callerWait: true });
  void offer.catch(() => undefined);
  try {
    await Promise.race([waitForFile(marker, 10_000), offer.then(() => assert.fail("CAS settled before the committed hook"))]);
    signal.abort(new Error("caller stopped after the ref transaction committed"));
    // The operation's own read-back confirms its exact original offer; an independent read sees the same durable fact.
    const published = await offer;
    assert.ok(published.kind === "dispatched", 'expected published.kind = "dispatched"');
    const retained = await readDispatch(repository, akumaId);
    assert.deepEqual(retained, published.dispatch);
    assert.equal(retained?.contractId, owner);
    assert.deepEqual(await readDispatches(repository), [retained]);
  } finally {
    if (!signal.signal.aborted) signal.abort(new Error("caller stopped after the ref transaction committed"));
  }
});

test("Alias moves are serialized, canonical, and expose the previous target", async (context) => {
  const world = temporaryDirectory(context, "keiyaku-alias-") as WorldRoot;
  const alpha = parseAkumaAlias("@alpha");
  const beta = parseAkumaAlias("@beta");
  const first = parseAkumaId("aku/worker/11111111").id;
  const second = parseAkumaId("aku/reviewer/22222222").id;
  await Promise.all([
    moveAlias({ world, alias: beta, akumaId: second }),
    moveAlias({ world, alias: alpha, akumaId: first }),
  ]);
  assert.deepEqual(await readAliases(world), [
    { alias: alpha, akumaId: first },
    { alias: beta, akumaId: second },
  ]);
  assert.equal(
    readFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "utf8"),
    '{"version":1,"aliases":{"@alpha":"aku/worker/11111111","@beta":"aku/reviewer/22222222"}}\n',
  );

  assert.deepEqual(await moveAlias({ world, alias: alpha, akumaId: second }), {
    alias: { alias: alpha, akumaId: second },
    previous: first,
  });
  const held = await acquireSqliteTransactionLock({ path: join(world, ".keiyaku", "locks", "akuma-alias.sqlite"), mode: "immediate" });
  try {
    const signal = AbortSignal.timeout(50);
    await assert.rejects(moveAlias({ world, alias: alpha, akumaId: first, signal }), (error: unknown) => error === signal.reason);
    assert.deepEqual(await readAliases(world), [
      { alias: alpha, akumaId: second },
      { alias: beta, akumaId: second },
    ]);
  } finally {
    held.close();
  }
});

test("existing noncanonical alias spelling stays readable but cannot be newly assigned", async (context) => {
  const world = temporaryDirectory(context, "keiyaku-legacy-alias-") as WorldRoot;
  const directory = join(world, ".keiyaku", "akuma");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "alias.json"), '{"version":1,"aliases":{"@old--":"aku/worker/11111111"}}\n');
  assert.deepEqual(await readAliases(world), [{ alias: "@old--", akumaId: parseAkumaId("aku/worker/11111111").id }]);
  await assert.rejects(
    moveAlias({
      world,
      alias: "@old--" as ReturnType<typeof parseAkumaAlias>,
      akumaId: parseAkumaId("aku/worker/22222222").id,
    }),
    /normalized Akuma name/u,
  );
});

test("Alias corruption is visible instead of becoming an empty authority", async (context) => {
  const world = temporaryDirectory(context, "keiyaku-alias-corrupt-") as WorldRoot;
  const directory = join(world, ".keiyaku", "akuma");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "alias.json"), '{"version":1,"aliases":{"@bad":"not-an-aku"}}\n');
  await assert.rejects(readAliases(world), AuthorityCorruptionError);
});

function dispatchPathFor(akumaId: AkumaId): string {
  return `dispatch/${createHash("sha256").update(akumaId).digest("hex")}.json`;
}

/** Overwrite one durable Dispatch fact with the given bytes, keeping the rest of the state tree. */
async function overwriteDispatchFact(repository: GitRepository, akumaId: AkumaId, bytes: string): Promise<void> {
  const snapshot = await readGitPaths(repository, []);
  const blob = await writeBlob(repository, Buffer.from(bytes));
  const tree = await updateGitTree(repository, snapshot.tree, new Map([[dispatchPathFor(akumaId), { oid: blob }]]));
  const commit = await writeStateCommit({
    repository,
    tree,
    parent: snapshot.commit,
    message: `overwrite ${akumaId}`,
    at: new Date().toISOString(),
  });
  assert.deepEqual(
    await updateRefsAtomically(repository, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }]),
    { kind: "published" },
  );
}

const ASSOCIATION_IDS = [
  parseAkumaId("aku/worker/00000001").id,
  parseAkumaId("aku/reviewer/00000002").id,
  parseAkumaId("aku/worker/00000003").id,
] as const;

test("Contract member selection and complete Dispatch reads reject an unrelated obsolete fact before mutation", async (t) => {
  const raw = makeGitRepository();
  const repository = await repositoryAt(raw.path);
  const world = await World.at(temporaryDirectory(t, "dispatch-members-"));
  const born = await bornDirectAkuma({
    root: world,
    akumaName: "worker",
    draw: "00000001",
    createdAt: "2026-08-09T00:00:00.000Z",
  });
  t.after(() => born.leash.release());
  const owner = contractId("kei/strict-members");
  assert.equal((await publishDispatch({ repository, akumaId: born.id, contractId: owner })).kind, "dispatched");
  const unrelated = ASSOCIATION_IDS[1];
  await overwriteDispatchFact(
    repository,
    unrelated,
    `${JSON.stringify({ akuId: unrelated, contractId: "kei/unrelated", dispatchedAt: "2026-08-09T00:00:00.000Z" })}\n`,
  );
  await assert.rejects(readDispatches(repository), AuthorityCorruptionError);
  const before = await Akumas.of(world).status({ akuma: born.id });
  assert.ok(before.kind === "akuma");
  await assert.rejects(
    Akumas.of(world).kill({ akuma: owner, repo: await Repo.at({ path: raw.path }) }),
    AuthorityCorruptionError,
  );
  const after = await Akumas.of(world).status({ akuma: born.id });
  assert.ok(after.kind === "akuma");
  assert.equal(after.life, before.life);
});

test("a selected association read answers every requested identity from one targeted observation", async () => {
  const repository = await repositoryAt(makeGitRepository().path);
  const [first, second, third] = ASSOCIATION_IDS;
  const owner = contractId("kei/batch-owner");
  assert.equal((await publishDispatch({ repository, akumaId: second, contractId: owner })).kind, "dispatched");

  const associations = await observeDispatchAssociations(repository, [third, first, second, third]);
  assert.deepEqual(
    [...associations.keys()],
    [third, first, second],
    "the projection keeps the caller's deduplicated identity order",
  );
  assert.deepEqual(associations.get(first), { kind: "none" });
  assert.deepEqual(associations.get(second), { kind: "associated", contractId: owner });
  assert.deepEqual(associations.get(third), { kind: "none" });
  assert.deepEqual(
    [...(await observeDispatchAssociations(undefined, [first, second]))],
    [
      [first, { kind: "none" }],
      [second, { kind: "none" }],
    ],
  );
});

test("one malformed requested Dispatch fact fails only its own association", async () => {
  const repository = await repositoryAt(makeGitRepository().path);
  const [first, second, third] = ASSOCIATION_IDS;
  const owner = contractId("kei/batch-malformed");
  for (const akumaId of [first, second, third]) {
    assert.equal((await publishDispatch({ repository, akumaId, contractId: owner })).kind, "dispatched");
  }
  await overwriteDispatchFact(repository, second, '{"akumaId":"aku/worker/00000002","contractId":"kei/x"}\n');

  await assert.rejects(readDispatches(repository), AuthorityCorruptionError);
  const associations = await observeDispatchAssociations(repository, [first, second, third]);
  assert.deepEqual(associations.get(first), { kind: "associated", contractId: owner });
  assert.deepEqual(associations.get(third), { kind: "associated", contractId: owner });
  const failed = associations.get(second);
  assert.ok(failed?.kind === "failed", "the malformed fact is the only failed association");
  assert.match(failed.diagnostic, /Dispatch has invalid fields/u);
  assert.deepEqual(
    [...(await observeDispatchAssociations(repository, [first, third]))],
    [
      [first, { kind: "associated", contractId: owner }],
      [third, { kind: "associated", contractId: owner }],
    ],
  );
});
