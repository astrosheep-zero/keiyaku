import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveAlias, readAliases, resolveAlias } from "../src/alias/index.js";
import { parseAkuId } from "../src/akuma/identity.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { contractId } from "../src/core/facts/types.js";
import { publishDispatch, readDispatch, readDispatches } from "../src/dispatch/index.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { repositoryAt } from "../src/git/repository.js";
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
  const akuma = parseAkuId("aku/worker/1234abcd").id;
  const owner = contractId("kei/dispatch-owner");

  assert.equal(await readDispatch(repository, akuma), null);
  const first = await publishDispatch({ repository, akuId: akuma, contractId: owner });
  assert.equal(first.kind, "dispatched");
  if (first.kind !== "dispatched") return;
  assert.equal(raw.run(["log", "-1", "--format=%s", "refs/heads/keiyaku-state"]).trim(), "keiyaku authority - do not delete or rewrite");
  assert.match(raw.run(["log", "-1", "--format=%B", "refs/heads/keiyaku-state"]), /\n\ndispatch aku\/worker\/1234abcd\n/u);
  assert.deepEqual(await readDispatch(repository, akuma), first.dispatch);
  assert.deepEqual(await readDispatches(repository), [first.dispatch]);

  const repeated = await publishDispatch({ repository, akuId: akuma, contractId: owner });
  assert.deepEqual(repeated, first);
  const conflict = await publishDispatch({
    repository,
    akuId: akuma,
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
  const akuma = parseAkuId("aku/worker/1234abcd").id;
  const owner = contractId("kei/dispatch-owner");
  const published = await publishDispatch({ repository, akuId: akuma, contractId: owner });
  assert.equal(published.kind, "dispatched");
  if (published.kind !== "dispatched") return;
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
    parseAkuId("aku/worker/11111111").id,
    parseAkuId("aku/worker/22222222").id,
    parseAkuId("aku/reviewer/33333333").id,
  ];
  const held = await acquireSqliteTransactionLock({ path: privateStatePublicationSeatPath(repository), mode: "immediate" });
  const arrivals = ids.map(() => deferred<void>());
  const pending = ids.map((akuId, index) =>
    publishDispatch({
      repository: { ...repository, onPrivateStateSeatContention: arrivals[index]!.resolve },
      akuId,
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

test("Dispatch publication seats are exact to one Git common directory", async () => {
  const firstRaw = makeGitRepository();
  firstRaw.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const linked = mkdtempSync(join(tmpdir(), "keiyaku-dispatch-linked-"));
  try {
    firstRaw.run(["worktree", "add", "--quiet", "--detach", linked]);
    const primary = await repositoryAt(firstRaw.path);
    const worktree = await repositoryAt(linked);
    const other = await repositoryAt(makeGitRepository().path);
    const owner = contractId("kei/dispatch-scope");
    assert.equal(privateStatePublicationSeatPath(primary), privateStatePublicationSeatPath(worktree));
    assert.notEqual(privateStatePublicationSeatPath(primary), privateStatePublicationSeatPath(other));

    const held = await acquireSqliteTransactionLock({
      path: privateStatePublicationSeatPath(primary),
      mode: "immediate",
    });
    const arrival = deferred<void>();
    const blocked = publishDispatch({
      repository: { ...worktree, onPrivateStateSeatContention: arrival.resolve },
      akuId: parseAkuId("aku/worker/44444444").id,
      contractId: owner,
    });
    try {
      await arrival.promise;
      const foreign = await publishDispatch({
        repository: other,
        akuId: parseAkuId("aku/worker/55555555").id,
        contractId: owner,
      });
      assert.equal(foreign.kind, "dispatched");
      assert.equal(await readDispatch(worktree, parseAkuId("aku/worker/44444444").id), null);
    } finally {
      held.close();
    }
    const released = await blocked;
    assert.equal(released.kind, "dispatched");
  } finally {
    try {
      firstRaw.run(["worktree", "remove", "--force", linked]);
    } catch {}
    rmSync(linked, { recursive: true, force: true });
  }
});

test("Dispatch classifies unknown CAS by authoritative read-back", async () => {
  const raw = makeGitRepository();
  const repository = await repositoryAt(raw.path);
  const akuId = parseAkuId("aku/worker/66666666").id;
  const owner = contractId("kei/dispatch-readback");
  const published = await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
      "  kill -TERM $$",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    () => publishDispatch({ repository, akuId, contractId: owner }),
  );
  assert.equal(published.kind, "dispatched");
  if (published.kind !== "dispatched") return;
  assert.deepEqual(await readDispatch(repository, akuId), published.dispatch);
});

test("Dispatch keeps non-Dispatch CAS failure classifications", async () => {
  const raw = makeGitRepository();
  const repository = await repositoryAt(raw.path);
  const seed = parseAkuId("aku/worker/77777777").id;
  const owner = contractId("kei/dispatch-cas");
  assert.equal(
    (
      await publishDispatch({
        repository,
        akuId: seed,
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
        akuId: parseAkuId("aku/worker/88888888").id,
        contractId: owner,
      }),
  );
  assert.equal(failed.kind, "failed");
  if (failed.kind !== "failed") return;
  assert.equal(failed.failure.kind, "publication-failed");
  if (failed.failure.kind !== "publication-failed") return;
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
        akuId: parseAkuId("aku/worker/99999999").id,
        contractId: owner,
      }),
  );
  assert.equal(raced.kind, "failed");
  if (raced.kind !== "failed") return;
  assert.equal(raced.failure.kind, "publication-failed");
  assert.equal(await readDispatch(repository, parseAkuId("aku/worker/99999999").id), null);
});

test("Alias moves are serialized, canonical, and expose the previous target", async () => {
  const world = mkdtempSync(join(tmpdir(), "keiyaku-alias-")) as WorldRoot;
  const alpha = parseAkumaAlias("@alpha");
  const beta = parseAkumaAlias("@beta");
  const first = parseAkuId("aku/worker/11111111").id;
  const second = parseAkuId("aku/reviewer/22222222").id;
  try {
    await Promise.all([
      moveAlias({ world, alias: beta, akuId: second }),
      moveAlias({ world, alias: alpha, akuId: first }),
    ]);
    assert.deepEqual(await readAliases(world), [
      { alias: alpha, akuId: first },
      { alias: beta, akuId: second },
    ]);
    assert.equal(
      readFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "utf8"),
      '{"version":1,"aliases":{"@alpha":"aku/worker/11111111","@beta":"aku/reviewer/22222222"}}\n',
    );

    assert.deepEqual(await moveAlias({ world, alias: alpha, akuId: second }), {
      alias: { alias: alpha, akuId: second },
      previous: first,
    });
    assert.equal(await resolveAlias(world, alpha), second);
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

test("Alias corruption is visible instead of becoming an empty authority", async () => {
  const world = mkdtempSync(join(tmpdir(), "keiyaku-alias-corrupt-")) as WorldRoot;
  const directory = join(world, ".keiyaku", "akuma");
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "alias.json"), '{"version":1,"aliases":{"@bad":"not-an-aku"}}\n');
    await assert.rejects(readAliases(world), AuthorityCorruptionError);
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

test("Alias world coordinates never fall back to process cwd", async () => {
  await assert.rejects(readAliases("" as WorldRoot), /Alias world must be a nonblank path/u);
});
