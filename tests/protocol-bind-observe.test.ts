import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import test, { describe } from "node:test";
import { AuthorityCorruptionError, KeiyakuError, Keis, Repo } from "../src/index.js";
import { SqliteTransactionLockError } from "../src/coordination/sqlite-transaction-lock.js";
import { admit } from "../src/git/admission.js";
import {
  GIT_REF,
  readBlob,
  readGitPaths,
  repositoryAt as productionRepositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import {
  contractJournal,
  observeContractsAt,
} from "../src/git/observe.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { contractJournalPath } from "../src/git/identity.js";
import { bindOperation as rawBindOperation } from "../src/protocol/bind.js";
import {
  contractIdFromSegment,
  documentKey,
  entryUlid,
  type ContractId,
} from "../src/core/facts/types.js";
import { decideArc } from "../src/core/verbs/arc.js";
import {
  cachedRepoAt,
  cachedRepositoryAt,
  makeGitRepository,
  observeContract,
  protocolContractId,
  snapshotGitRepository,
  type TestGitRepository,
  withGitShim,
  withSqliteCloseFailure,
} from "./support/git.js";

const repositoryAt = cachedRepositoryAt;

import { prepareVerificationDeclaration } from "../src/verification/declaration.js";

let untitledBind = 0;

function bindOperation(
  input: Omit<Parameters<typeof rawBindOperation>[0], "channel" | "verification" | "contractId" | "targetSelection"> &
    Readonly<{
      title?: string;
      contractId?: ContractId;
      targetSelection?: Parameters<typeof rawBindOperation>[0]["targetSelection"];
    }>,
) {
  const { title, contractId: id, targetSelection = { kind: "targetless" }, ...rest } = input;
  return withGitDecodeChannel(input.scope, (channel) =>
    rawBindOperation({
      ...rest,
      targetSelection,
      channel,
      contractId:
        id ??
        (title === undefined ? contractIdFromSegment(`protocol-bind-${untitledBind++}`) : protocolContractId(title)),
      verification: prepareVerificationDeclaration(null),
    }),
  );
}

let repositoryWithHeadTemplate: TestGitRepository | undefined;

function repositoryWithHead(): TestGitRepository {
  if (repositoryWithHeadTemplate === undefined) {
    repositoryWithHeadTemplate = makeGitRepository();
    repositoryWithHeadTemplate.run(["config", "user.name", "Test User"]);
    repositoryWithHeadTemplate.run(["config", "user.email", "test@example.com"]);
    repositoryWithHeadTemplate.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  }
  return snapshotGitRepository(repositoryWithHeadTemplate);
}

function contractBody(): string {
  return contractMarkdown("Targeted observation", {
    Context: "Test one-contract observation.",
    Objective: "Avoid decoding unrelated journals.",
    Design: "Use the requested contract primitive.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: "### C1\nThe local operation ignores unrelated malformed journals.",
  });
}

function terms(after: readonly ContractId[]) {
  return {
    document: { bytes: "# Targeted\n", key: documentKey("targeted") },
    segments: [],
    gates: [],
    requirements: {},
    after,
  } as const;
}

async function boundObservedContract(repository: TestGitRepository) {
  const bound = accepted(
    await Keis.of(await cachedRepoAt(repository.path)).bind({
      terms: contractBody(),
    }),
  );
  const id = present(await bound.kei.state()).id;
  const git = await repositoryAt(repository.path);
  return { bound, id, git };
}

test("ordinary protocol bind preserves both admission and SQLite retirement failures", async () => {
  const git = await repositoryAt(repositoryWithHead().path);
  const lock = privateStatePublicationSeatPath(git);
  const primary = new AuthorityCorruptionError("cannot decode bind companion", {
    cause: new SyntaxError("malformed companion bytes"),
  });
  const closeFailure = new Error("independent protocol seat close failure");
  await withSqliteCloseFailure(
    (path) => (path === lock ? closeFailure : undefined),
    () => assert.rejects(
      bindOperation({
        scope: git,
        terms: terms([]),
        decorateOffer() { throw primary; },
      }),
      (error: unknown) => {
        assert.ok(error instanceof KeiyakuError && error.category === primary.category);
        assert.equal(error.cause, primary);
        assert.ok("retirement" in error && error.retirement instanceof SqliteTransactionLockError);
        assert.equal(error.retirement.cause, closeFailure);
        return true;
      },
    ),
  );
});

// Each concurrent case owns its repository, fault injector and cleanup.
describe("protocol-bind-observe isolated fixtures", { concurrency: 3 }, () => {
  test("target and prerequisite expansion keeps the initial Git epoch after the state ref moves", async () => {
    const repository = repositoryWithHead();
    const contracts = Keis.of(await Repo.at({ path: repository.path }));
    const target = accepted(await contracts.bind({ terms: contractBody(), target: null }));
    const prerequisite = accepted(await contracts.bind({ terms: contractBody(), target: null }));
    const child = accepted(await contracts.bind({
      terms: contractBody(), target: target.contractId, after: [prerequisite.contractId],
    }));
    const git = await repositoryAt(repository.path);
    const ids = [child.contractId, target.contractId, prerequisite.contractId];
    const before = await readGitPaths(git, ids.map((id) => contractJournalPath(id)));
    const childOid = before.paths.get(contractJournalPath(child.contractId))!.oid;
    const { frozen, fresh } = await withGitDecodeChannel(git, async (channel) => {
      let moved = false;
      const racing = {
        ...channel,
        readObjects: async (oids: readonly string[]) => {
          const objects = await channel.readObjects(oids);
          if (!moved && oids.includes(childOid)) {
            moved = true;
            accepted(await target.kei.arc({ body: "# A new target chapter\n" }));
            accepted(await prerequisite.kei.abandon());
          }
          return objects;
        },
      };
      const frozen = await observeContractsAt(git, racing, [child.contractId], { after: true });
      assert.ok(moved);
      const fresh = await observeContractsAt(git, channel, [child.contractId], { after: true });
      return { frozen, fresh };
    });
    assert.equal(frozen.epoch.commit, before.commit);
    assert.notEqual(fresh.epoch.commit, frozen.epoch.commit);
    for (const id of ids) {
      const record = contractJournal(frozen.journals, id);
      assert.ok(record.state !== null);
      assert.equal(record.path, contractJournalPath(id));
      assert.equal(record.oid, before.paths.get(record.path)?.oid);
      assert.deepEqual(record.bytes, await readBlob(git, record.oid));
      assert.equal(frozen.decision.get(id), record.state);
    }
    assert.equal(frozen.decision.get(target.contractId)?.currentArc, undefined);
    assert.equal(fresh.decision.get(target.contractId)?.currentArc?.data.title, "A new target chapter");
    const retired = contractJournal(fresh.journals, prerequisite.contractId);
    assert.ok(retired.state !== null);
    assert.equal(retired.path, contractJournalPath(prerequisite.contractId, "terminal"));
    assert.equal(retired.state.terminal?.kind, "abandoned");
  });

  test("a failed Git CAS publishes neither its journal append nor its companion", async () => {
    const repository = repositoryWithHead();
    const { id, git } = await boundObservedContract(repository);
    const observation = await withGitDecodeChannel(git, (channel) =>
      observeContractsAt(git, channel, [id]),
    );
    const before = contractJournal(observation.journals, id);
    assert.ok(before.state !== null);
    const decision = decideArc({
      input: {
        contractId: id,
        at: "2026-08-06T00:00:00Z",
        data: { title: "Losing companion", body: "Lose one CAS\nLeave no partial fact." },
      },
      attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
      observation: observation.decision,
    });
    assert.ok(decision.kind === "offer", 'expected decision.kind = "offer"');

    const winnerBlob = await writeBlob(git, "winner\n");
    const winnerTree = await updateGitTree(
      git,
      observation.epoch.tree,
      new Map([["test/winner.txt", { oid: winnerBlob }]]),
    );
    const winnerCommit = await writeCommit({
      repository: git,
      tree: winnerTree,
      parent: observation.epoch.commit,
    });
    assert.equal(
      (
        await updateRefsAtomically(git, [
          {
            ref: GIT_REF,
            newOid: winnerCommit,
            expectedOid: observation.epoch.commit,
          },
        ])
      ).kind,
      "published",
    );

    const result = await admit(
      git,
      {
        ...decision.offer,
        companions: [{ path: "test/loser.txt", bytes: Buffer.from("loser\n") }],
      },
      observation,
    );

    assert.equal(result.kind, "publication-failed");
    const after = await readGitPaths(git, ["test/winner.txt", "test/loser.txt", contractJournalPath(id)]);
    assert.equal(after.paths.has("test/winner.txt"), true);
    assert.equal(after.paths.has("test/loser.txt"), false);
    assert.equal(after.paths.get(contractJournalPath(id))?.oid, before.oid);
  });

  test("bind's atomic target assertion spends its preparation and the fresh attempt admits the new target", async () => {
    const repository = repositoryWithHead();
    repository.run(["branch", "release"]);
    const git = await repositoryAt(repository.path);
    const predecessor = repository.run(["rev-parse", "refs/heads/release"]).trim();
    const tree = repository.run(["rev-parse", `${predecessor}^{tree}`]).trim();
    const moved = repository.run(["commit-tree", tree, "-p", predecessor, "-m", "move target"]).trim();
    const marker = join(repository.path, "bind-target-observation.marker");
    const bound = await withGitShim(
      [
        'if [ "$1 $2" = "update-ref --stdin" ] && [ ! -e "$KEIYAKU_BIND_MARKER" ]; then',
        '  : > "$KEIYAKU_BIND_MARKER"',
        '  "$KEIYAKU_REAL_GIT" update-ref refs/heads/release "$KEIYAKU_MOVED_TARGET" "$KEIYAKU_OLD_TARGET" || exit $?',
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      {
        KEIYAKU_BIND_MARKER: marker,
        KEIYAKU_MOVED_TARGET: moved,
        KEIYAKU_OLD_TARGET: predecessor,
      },
      async (gitPath) =>
        bindOperation({
          scope: await productionRepositoryAt(repository.path, gitPath),
          title: "Moving target",
          terms: terms([]),
          targetSelection: { kind: "explicit", target: "refs/heads/release" },
        }),
    );

    const id = protocolContractId("Moving target");
    assert.ok(bound.kind === "accepted", 'expected bound.kind = "accepted"');
    assert.equal(bound.state.id, id);
    assert.equal((await observeContract(git, id)).state?.coordinates.start, moved);
    const repeated = await bindOperation({ scope: git, contractId: id, terms: terms([]),
      targetSelection: { kind: "explicit", target: "refs/heads/release" } });
    assert.deepEqual(repeated, { kind: "refused", refusal: { kind: "contract-exists" } });
  });

  test("public reconcile and admission observation retain canonical journal validation", async () => {
    const repository = repositoryWithHead();
    const repo = await Repo.at({ path: repository.path });
    const { id, git } = await boundObservedContract(repository);
    const snapshot = await readGitPaths(git, [contractJournalPath(id)]);
    const path = contractJournalPath(id);
    const journal = snapshot.paths.get(path);
    if (journal === undefined) throw new Error("bound journal was not observed");
    const noncanonical = await writeBlob(
      git,
      Buffer.concat([(await readBlob(git, journal.oid)).subarray(0, -1), Buffer.from(" \n")]),
    );
    const tree = await updateGitTree(git, snapshot.tree, new Map([[path, { oid: noncanonical }]]));
    const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
    assert.equal(
      (
        await updateRefsAtomically(git, [
          {
            ref: GIT_REF,
            newOid: commit,
            expectedOid: snapshot.commit,
          },
        ])
      ).kind,
      "published",
    );

    await assert.rejects(
      () => withGitDecodeChannel(git, (channel) => observeContractsAt(git, channel, [id])),
      (error: unknown) =>
        error instanceof AuthorityCorruptionError && /journal entry is not canonical/.test(error.message),
    );
    await assert.rejects(
      () => Keis.of(repo).reconcile({ contract: id }),
      (error: unknown) =>
        error instanceof KeiyakuError &&
        error.category === "authority-corruption" &&
        error.cause instanceof AuthorityCorruptionError &&
        /journal entry is not canonical/.test(error.message),
    );
  });

});
