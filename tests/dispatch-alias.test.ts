import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { moveAlias, readAliases } from "../src/alias/index.js";
import { parseAkumaId, type AkumaId } from "../src/akuma/identity.js";
import type { BodyLauncher } from "../src/akuma/body-launch.js";
import { acquireSqliteTransactionLock, SqliteTransactionLockError } from "../src/coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { contractId } from "../src/core/facts/types.js";
import { observeDispatchAssociations, publishDispatch, readDispatch, readDispatches } from "../src/dispatch/index.js";
import { Akumas, Keis, KeiyakuError, Repo, World } from "../src/index.js";
import { scopeForRepo } from "../src/library/repo.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { pathsForAkumaId } from "../src/akuma/identity.js";
import { readSoul, readTell } from "../src/akuma/heart/index.js";
import { answering, fixtureLauncher, settleFixtureBodies } from "./support/akuma-tell.js";
import { accepted, document, repositoryWithMain } from "./support/library-verbs.js";
import { isolateUserHome } from "./support/user-home.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
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
import { makeGitRepository, waitForFile, withGitShim } from "./support/git.js";

isolateUserHome();

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value as T | PromiseLike<T>);
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

test("confirmed private-state seat close failure remains lag on a dispatched association", async () => {
  const raw = makeGitRepository();
  const repository = {
    ...(await repositoryAt(raw.path)),
    onPrivateStateSeatClose: () => {
      throw new SqliteTransactionLockError("seat close failed after publication", "release-failed");
    },
  };
  const akuma = parseAkumaId("aku/worker/1234abcd").id;
  const owner = contractId("kei/dispatch-owner");
  const published = await publishDispatch({ repository, akumaId: akuma, contractId: owner });
  assert.ok(published.kind === "dispatched", 'expected published.kind = "dispatched"');
  assert.deepEqual(await readDispatch(repository, akuma), published.dispatch);
  assert.deepEqual(published.seatClose, [
    {
      kind: "private-state-seat-close-failed",
      diagnostic: "seat close failed after publication",
    },
  ]);
});

test("born Spawn waits past Bind's real Git seat cap without duplicating birth or association", { timeout: 55_000 }, async (t) => {
  const world = await World.at(repositoryWithMain().path);
  const repo = await Repo.at({ path: world });
  const repository = scopeForRepo(repo);
  const library = Keis.of(repo);
  const bind = (title: string) => library.bind({ terms: document().replace("Library verbs", title), target: "main", gates: [] });
  const existing = accepted(await bind("Spawn target"));
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const bodies: Promise<unknown>[] = [];
  t.after(() => settleFixtureBodies(bodies));
  const api = akumasWithLauncher(world, (launch) => fixtureLauncher(bodies, new Map([
    [launch.paths.directory, { adapter: answering("exact answer"), now: new Date().toISOString() }],
  ]))(launch));
  const arrivals = [deferred<void>(), deferred<void>()];
  let waiters = 0;
  Object.assign(repository, { onPrivateStateSeatContention: () => arrivals[waiters++]?.resolve() });
  const held = await acquireSqliteTransactionLock({ path: privateStatePublicationSeatPath(repository), mode: "immediate" });
  const input = { akumaName: "worker", contract: existing.kei };
  const signal = new AbortController();
  const stop = new Error("caller stopped while the shared seat was held");
  let stopped: { id: AkumaId; tellId: string } | undefined;
  let spawnFinished = false;
  const waiting = api.spawn({ ...input, alias: "waited" }).finally(() => { spawnFinished = true; });
  void waiting.catch(() => undefined);
  try {
    await Promise.race([arrivals[0]!.promise, waiting.then(() => assert.fail("Spawn did not wait"))]);
    const canceled = api.spawn({ ...input, body: "retain this Tell", alias: "aborted", signal: signal.signal });
    void canceled.catch(() => undefined);
    await Promise.race([arrivals[1]!.promise, canceled.then(() => assert.fail("canceled Spawn did not wait"))]);
    signal.abort(stop);
    await assert.rejects(canceled, (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.cause, stop);
      const result = error.spawn;
      assert.ok(result?.kind === "failed" && result.tellId);
      stopped = { id: result.akumaId, tellId: result.tellId };
      assert.deepEqual(result.failures.map(({ stage }) => stage), ["dispatch"]);
      assert.equal(result.requestedContractId, existing.contractId);
      assert.equal(result.requestedAlias, "@aborted");
      assert.equal(result.contractId, undefined);
      return true;
    });
    const started = performance.now();
    assert.equal((await bind("Still capped Bind")).kind, "retry");
    const waited = performance.now() - started;
    t.diagnostic(`actual Bind kept cap, shared seat held at least ${Math.round(waited)}ms after Spawn entered it`);
    assert.ok(waited >= 15_000);
    assert.equal(spawnFinished, false);
    assert.deepEqual(await readDispatches(repository), []);
    assert.deepEqual(await readAliases(world), []);
    assert.ok(stopped);
    const paths = pathsForAkumaId(world, stopped.id);
    assert.equal((await readSoul(paths))?.id, stopped.id);
    assert.equal((await readTell(paths, stopped.tellId))?.body, "retain this Tell");
  } finally {
    held.close();
  }
  const child = await waiting;
  assert.equal(child.kind, "spawned");
  assert.equal((await readSoul(pathsForAkumaId(world, child.akumaId)))?.id, child.akumaId);
  assert.equal((await readDispatch(repository, child.akumaId))?.contractId, existing.contractId);
  assert.deepEqual(await readAliases(world), [{ alias: "@waited", akumaId: child.akumaId }]);

  const indexes = [0, 1];
  const [binds, spawns] = await Promise.all([
    Promise.all(indexes.map((index) => bind(`Concurrent Bind ${index}`))),
    Promise.all(indexes.map((index) => api.spawn({ ...input, alias: `overlap-${index}` }))),
  ]);
  assert.equal(new Set(binds.map((result) => accepted(result).contractId)).size, indexes.length);
  assert.ok(spawns.every(({ kind }) => kind === "spawned"));
  const children = spawns.map(({ akumaId }) => akumaId);
  assert.equal(new Set(children).size, indexes.length);
  const dispatches = await readDispatches(repository);
  assert.deepEqual(new Set(dispatches.map(({ akumaId }) => akumaId)), new Set([child.akumaId, ...children]));
  assert.ok(dispatches.every(({ contractId }) => contractId === existing.contractId));
  const roster = await api.list({ selection: "all" });
  assert.deepEqual(new Set(roster.rows?.map(({ id }) => id)), new Set([stopped?.id, child.akumaId, ...children]));
  assert.deepEqual((await readAliases(world)).map(({ akumaId }) => akumaId), [...children, child.akumaId]);
});

test("Dispatch retains a hard publication failure through seat close failure", async (t) => {
  const raw = repositoryWithMain();
  const world = await World.at(raw.path);
  const repo = await Repo.at({ path: world });
  const repository = scopeForRepo(repo);
  const { contractId: owner } = accepted(await Keis.of(repo).bind({ terms: document(), target: "main", gates: [] }));
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const bodies: Promise<unknown>[] = [];
  t.after(() => settleFixtureBodies(bodies));
  const launchBody: BodyLauncher = (launch) => fixtureLauncher(bodies, new Map([
    [launch.paths.directory, { adapter: answering("unused"), now: new Date().toISOString() }],
  ]))(launch);
  const api = akumasWithLauncher(world, launchBody);
  const failClose = () => { throw new SqliteTransactionLockError("forced Dispatch seat close failure", "release-failed"); };

  const rejected = join(raw.path, "rejected-dispatch");
  const failed = await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      "  cat >/dev/null",
      '  printf "%s\\n" "$1" >> "$KEIYAKU_TEST_DISPATCH_REJECTED"',
      '  printf "forced hard publication failure\\n" >&2',
      "  exit 42",
      "fi",
      'if [ -f "$KEIYAKU_TEST_DISPATCH_REJECTED" ]; then : > "$KEIYAKU_TEST_DISPATCH_REJECTED.read-back"; fi',
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_TEST_DISPATCH_REJECTED: rejected },
    async (gitPath) => {
      const shimRepo = await Repo.at({ path: world, gitPath });
      Object.assign(scopeForRepo(shimRepo), { onPrivateStateSeatClose: failClose });
      const contract = Keis.of(shimRepo).kei({ id: owner });
      return await api.spawn({ akumaName: "worker", contract, alias: "rejected" });
    },
  );
  assert.ok(failed.kind === "failed");
  assert.equal(failed.failures.length, 1);
  const [stopped] = failed.failures;
  assert.ok(stopped.stage === "dispatch" && stopped.failure.kind === "publication-failed");
  assert.match(stopped.failure.diagnostic, /forced hard publication failure/u);
  assert.match(stopped.failure.diagnostic, /Publication seat close also failed: forced Dispatch seat close failure/u);
  assert.equal(failed.requestedContractId, owner);
  assert.equal(failed.requestedAlias, "@rejected");
  assert.equal(failed.dispatchWarning, undefined);
  assert.equal((await readSoul(pathsForAkumaId(world, failed.akumaId)))?.id, failed.akumaId);
  assert.equal(await readDispatch(repository, failed.akumaId), null);
  assert.deepEqual(await readAliases(world), []);
  assert.equal(readFileSync(rejected, "utf8"), "update-ref\n");
  assert.equal(existsSync(`${rejected}.read-back`), false);
});

test("an interrupted real Git CAS proves only the originally published Dispatch", { timeout: 20_000 }, async () => {
  for (const moveRef of [false, true]) {
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
    let successor: string | undefined;
    try {
      await Promise.race([waitForFile(marker, 10_000), offer.then(() => assert.fail("CAS settled before the committed hook"))]);
      if (moveRef) {
        const original = raw.run(["rev-parse", GIT_REF]).trim();
        const tree = raw.run(["rev-parse", `${original}^{tree}`]).trim();
        successor = raw.run(["commit-tree", tree, "-p", original, "-m", "external successor, same tree"]).trim();
        raw.run(["-c", "core.hooksPath=.git/no-fixture-hooks", "update-ref", GIT_REF, successor, original]);
      }
    } finally {
      signal.abort(new Error("caller stopped after the ref transaction committed"));
    }
    const published = await offer;
    const retained = await readDispatch(repository, akumaId);
    assert.equal(retained?.contractId, owner);
    if (successor === undefined) {
      assert.ok(published.kind === "dispatched");
      assert.deepEqual(retained, published.dispatch);
    } else {
      assert.deepEqual(published, {
        kind: "failed",
        failure: { kind: "publication-failed", diagnostic: "Dispatch publication outcome is unknown" },
      });
      assert.equal(raw.run(["rev-parse", GIT_REF]).trim(), successor);
    }
    assert.deepEqual(await readDispatches(repository), [retained]);
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
