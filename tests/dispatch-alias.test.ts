import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { moveAlias, readAliases } from "../src/alias/index.js";
import { parseAkumaId, type AkumaId } from "../src/akuma/identity.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { contractId } from "../src/core/facts/types.js";
import { observeDispatchAssociations, publishDispatch, readDispatch, readDispatches } from "../src/dispatch/index.js";
import { Akumas, Repo, World } from "../src/index.js";
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
import { makeGitRepository, withGitShim } from "./support/git.js";

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
  assert.equal(
    raw.run(["log", "-1", "--format=%s", "refs/heads/keiyaku-state"]).trim(),
    "keiyaku authority - do not delete or rewrite",
  );
  assert.match(
    raw.run(["log", "-1", "--format=%B", "refs/heads/keiyaku-state"]),
    /\n\ndispatch aku\/worker\/1234abcd\n/u,
  );
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
      throw new Error("seat close failed after publication");
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

test("concurrent distinct Dispatch publications wait for one repository seat", async () => {
  const raw = makeGitRepository();
  const repository = await repositoryAt(raw.path);
  const owner = contractId("kei/dispatch-owner");
  const ids = [
    parseAkumaId("aku/worker/11111111").id,
    parseAkumaId("aku/worker/22222222").id,
    parseAkumaId("aku/reviewer/33333333").id,
  ];
  const held = await acquireSqliteTransactionLock({
    path: privateStatePublicationSeatPath(repository),
    mode: "immediate",
  });
  const arrivals = ids.map(() => deferred<void>());
  const pending = ids.map((akumaId, index) =>
    publishDispatch({
      repository: { ...repository, onPrivateStateSeatContention: arrivals[index]!.resolve },
      akumaId,
      contractId: owner,
    }),
  );
  try {
    await Promise.all(arrivals.map(({ promise }) => promise));
    assert.deepEqual(await readDispatches(repository), []);
  } finally {
    held.close();
  }
  const results = await Promise.all(pending);
  for (const [index, result] of results.entries()) {
    assert.equal(result.kind, "dispatched");
    if (result.kind !== "dispatched") continue;
    assert.deepEqual(await readDispatch(repository, ids[index]!), result.dispatch);
    assert.equal(result.dispatch.contractId, owner);
  }
});

test("Dispatch keeps non-Dispatch CAS failure classifications", async () => {
  const raw = makeGitRepository();
  const repository = await repositoryAt(raw.path);
  const seed = parseAkumaId("aku/worker/77777777").id;
  const owner = contractId("kei/dispatch-cas");
  assert.equal(
    (
      await publishDispatch({
        repository,
        akumaId: seed,
        contractId: owner,
      })
    ).kind,
    "dispatched",
  );

  const failed = await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      "  cat >/dev/null",
      '  printf "forced hard publication failure\\n" >&2',
      "  exit 42",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) =>
      publishDispatch({
        repository: await repositoryAt(raw.path, gitPath),
        akumaId: parseAkumaId("aku/worker/88888888").id,
        contractId: owner,
      }),
  );
  assert.ok(failed.kind === "failed", 'expected failed.kind = "failed"');
  assert.ok(failed.failure.kind === "publication-failed", 'expected failed.failure.kind = "publication-failed"');
  assert.match(failed.failure.diagnostic, /forced hard publication failure/u);

  const raced = await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      '  current=$("$KEIYAKU_REAL_GIT" rev-parse refs/heads/keiyaku-state)',
      '  tree=$("$KEIYAKU_REAL_GIT" rev-parse "$current^{tree}")',
      '  next=$("$KEIYAKU_REAL_GIT" commit-tree "$tree" -p "$current" -m race)',
      '  "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$next" "$current"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) =>
      publishDispatch({
        repository: await repositoryAt(raw.path, gitPath),
        akumaId: parseAkumaId("aku/worker/99999999").id,
        contractId: owner,
      }),
  );
  assert.ok(raced.kind === "failed", 'expected raced.kind = "failed"');
  assert.equal(raced.failure.kind, "publication-failed");
  assert.equal(await readDispatch(repository, parseAkumaId("aku/worker/99999999").id), null);
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
  assert.deepEqual(await readAliases(world), [
    { alias: alpha, akumaId: second },
    { alias: beta, akumaId: second },
  ]);
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

test("Alias world coordinates never fall back to process cwd", async () => {
  await assert.rejects(readAliases("" as WorldRoot), /Alias world must be a nonblank path/u);
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
});

test("an unrelated corrupt Dispatch fact stays out of a selected association read", async () => {
  const repository = await repositoryAt(makeGitRepository().path);
  const [requested, unrelated, other] = ASSOCIATION_IDS;
  const owner = contractId("kei/batch-unrelated");
  for (const akumaId of [requested, other]) {
    assert.equal((await publishDispatch({ repository, akumaId, contractId: owner })).kind, "dispatched");
  }
  await overwriteDispatchFact(repository, unrelated, "not JSON at all\n");

  await assert.rejects(readDispatch(repository, unrelated), AuthorityCorruptionError);
  const associations = await observeDispatchAssociations(repository, [requested, other]);
  assert.deepEqual(
    [...associations],
    [
      [requested, { kind: "associated", contractId: owner }],
      [other, { kind: "associated", contractId: owner }],
    ],
  );
});

test("selected association failures await Git channel retirement", async (t) => {
  const raw = makeGitRepository();
  const repository = await repositoryAt(raw.path);
  const [first, second] = ASSOCIATION_IDS;
  await publishDispatch({ repository, akumaId: first, contractId: contractId("kei/batch-retirement") });
  const log = join(temporaryDirectory(t, "keiyaku-dispatch-retirement-"), "closed");
  await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@"',
      '  printf closed > "$KEIYAKU_CLOSE_LOG"',
      "  exit 73",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_CLOSE_LOG: log },
    async (gitPath) => {
      const associations = await observeDispatchAssociations(await repositoryAt(raw.path, gitPath), [first, second]);
      assert.equal(readFileSync(log, "utf8"), "closed");
      for (const association of associations.values()) {
        assert.equal(association.kind, "failed");
        if (association.kind === "failed") assert.match(association.diagnostic, /did not close cleanly/u);
      }
    },
  );
  await withGitShim(
    'if [ "$1" = "rev-parse" ] && [ "$4" = "refs/heads/keiyaku-state" ]; then exit 73; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    {},
    async (gitPath) => {
      const associations = await observeDispatchAssociations(await repositoryAt(raw.path, gitPath), [first, second]);
      assert.ok([...associations.values()].every((association) => association.kind === "failed"));
    },
  );
});

function recordedSpawns(log: string): readonly string[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

async function countingSpawns<T>(
  log: string,
  action: () => Promise<T>,
): Promise<Readonly<{ result: T; spawns: readonly string[]; elapsedMs: number }>> {
  writeFileSync(log, "");
  const started = performance.now();
  const result = await action();
  return { result, spawns: recordedSpawns(log), elapsedMs: performance.now() - started };
}

const SPAWN_LOGGING_SHIM = [
  'printf "%s %s\\n" "$1" "$2" >> "$KEIYAKU_SPAWN_LOG"',
  'exec "$KEIYAKU_REAL_GIT" "$@"',
].join("\n");

test("a selected association read spends a constant number of Git processes", async (t) => {
  const log = join(temporaryDirectory(t, "keiyaku-dispatch-spawns-"), "spawns.log");
  const raw = makeGitRepository();
  const repository = await repositoryAt(raw.path);
  const owner = contractId("kei/batch-scale");
  const ten = Array.from(
    { length: 10 },
    (_, index) => parseAkumaId(`aku/worker/${(index + 1).toString(16).padStart(8, "0")}`).id,
  );
  for (const akumaId of ten) {
    assert.equal((await publishDispatch({ repository, akumaId, contractId: owner })).kind, "dispatched");
  }

  await withGitShim(SPAWN_LOGGING_SHIM, { KEIYAKU_SPAWN_LOG: log }, async (gitPath) => {
    const shimmed = await repositoryAt(raw.path, gitPath);
    const single = await countingSpawns(log, () => observeDispatchAssociations(shimmed, [ten[0]!]));
    const plural = await countingSpawns(log, () => observeDispatchAssociations(shimmed, ten));
    const none = await countingSpawns(log, () =>
      observeDispatchAssociations(shimmed, [parseAkumaId("aku/worker/deadbeef").id]),
    );
    const absentRepo = await countingSpawns(log, () => observeDispatchAssociations(undefined, ten));
    const empty = await countingSpawns(log, () => observeDispatchAssociations(shimmed, []));
    const before = async (ids: readonly AkumaId[]) =>
      new Map(
        await Promise.all(
          ids.map(async (id) => {
            const dispatch = await readDispatch(shimmed, id);
            return [
              id,
              dispatch === null ? { kind: "none" } : { kind: "associated", contractId: dispatch.contractId },
            ] as const;
          }),
        ),
      );
    const retiredSingle = await countingSpawns(log, () => before([ten[0]!]));
    const retired = await countingSpawns(log, () => before(ten));

    assert.deepEqual(single.result, retiredSingle.result);
    assert.deepEqual(plural.result, retired.result);
    assert.equal(absentRepo.spawns.length, 0);
    assert.equal(empty.spawns.length, 0);

    assert.deepEqual([...plural.result.keys()], ten);
    assert.equal(
      plural.spawns.length,
      single.spawns.length,
      `one and ten selected identities observe the same associations in the same process count (${plural.spawns.length})`,
    );
    assert.equal(plural.spawns.length, 2, "one targeted observation is one ref read and one batched object read");
    assert.deepEqual(
      plural.spawns.map((line) => line.split(" ")[0]),
      ["rev-parse", "cat-file"],
    );
    assert.equal(none.spawns.length, 2, "an absent Dispatch fact still validates the existing authority snapshot");
    assert.equal(retiredSingle.spawns.length, 5);
    assert.equal(retired.spawns.length, 50, "the retired per-identity chain spent five processes per identity");
    assert.ok(plural.spawns.length < retired.spawns.length);
    for (const [size, oldRead, newRead] of [
      [1, retiredSingle, single],
      [10, retired, plural],
    ] as const) {
      t.diagnostic(
        `${size} IDs: before ${oldRead.spawns.length} Git spawns / ${oldRead.elapsedMs.toFixed(2)}ms; after ${newRead.spawns.length} Git spawns / ${newRead.elapsedMs.toFixed(2)}ms`,
      );
    }
  });
});
