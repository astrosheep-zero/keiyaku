import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import test, { describe } from "node:test";
import { AuthorityCorruptionError, KeiyakuError, Keis, Repo } from "../src/index.js";
import { SqliteTransactionLockError } from "../src/coordination/sqlite-transaction-lock.js";
import { admit } from "../src/git/admission.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  GIT_REF,
  DELIVERY_REF_NAMESPACE,
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
  observeActiveContractWorld,
  observeBindCoordinates,
  observeContractJournals,
  observeContractsAt,
} from "../src/git/observe.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { contractJournalPath } from "../src/git/identity.js";
import { decideAbandon } from "../src/core/verbs/abandon.js";
import { bindOperation as rawBindOperation } from "../src/protocol/bind.js";
import { amendOperation as rawAmendOperation } from "../src/protocol/amend.js";
import {
  contractId,
  contractIdFromSegment,
  documentKey,
  entryUlid,
  type AmendData,
  type ContractId,
  type ContractTerms,
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

type AmendTestInput = Omit<Parameters<typeof rawAmendOperation>[0], "channel" | "deriveAmendment"> &
  Readonly<{
    source?: ContractTerms;
    terms?: AmendData;
  }>;

function amendOperation(input: AmendTestInput) {
  const { source, terms, ...operation } = input;
  return withGitDecodeChannel(input.scope, (channel) =>
    rawAmendOperation({
      ...operation,
      channel,
      ...(source === undefined || terms === undefined
        ? {}
        : { source, deriveAmendment: () => ({ terms, verification: prepareVerificationDeclaration(null) }) }),
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
  test("observes a targetless detached bind snapshot", async () => {
    const repository = repositoryWithHead();
    repository.run(["checkout", "--quiet", "--detach"]);
    const start = repository.run(["rev-parse", "HEAD"]).trim();

    assert.deepEqual(await observeBindCoordinates(await repositoryAt(repository.path), { kind: "targetless" }), {
      start,
      branch: null,
    });
  });

  test("observes a missing explicit bind target without inventing coordinates", async () => {
    const repository = repositoryWithHead();

    assert.equal(
      await observeBindCoordinates(await repositoryAt(repository.path), {
        kind: "explicit",
        target: "refs/heads/missing",
      }),
      null,
    );
  });

  test("confirmed private-state seat close failure remains typed lag on an accepted bind", async () => {
    const repository = repositoryWithHead();
    const git = {
      ...(await repositoryAt(repository.path)),
      onPrivateStateSeatClose: () => {
        throw new SqliteTransactionLockError("seat close failed after publication", "release-failed");
      },
    };
    const bound = await bindOperation({
      scope: git,
      terms: terms([]),
    });
    assert.ok(bound.kind === "accepted", 'expected bound.kind = "accepted"');
    assert.equal(bound.facts.length > 0, true);
    assert.deepEqual(bound.seatClose, [
      {
        kind: "private-state-seat-close-failed",
        diagnostic: "seat close failed after publication",
      },
    ]);
  });

  test("current-branch intent on an unborn HEAD remains unborn-head", async () => {
    const repository = makeGitRepository();
    assert.deepEqual(await observeBindCoordinates(await repositoryAt(repository.path), { kind: "current-branch" }), {
      kind: "unborn-head",
      branch: "refs/heads/main",
    });
    assert.deepEqual(
      await bindOperation({
        scope: await repositoryAt(repository.path),
        terms: terms([]),
        targetSelection: { kind: "current-branch" },
      }),
      { kind: "refused", refusal: { kind: "unborn-head" } },
    );
  });

  test("refuses targets that name Keiyaku-owned refs", async () => {
    const repository = repositoryWithHead();
    const ownedTargets = [
      GIT_REF,
      DELIVERY_REF_NAMESPACE,
      `${DELIVERY_REF_NAMESPACE}/contract`,
      CANDIDATE_PIN_REF_NAMESPACE,
      `${CANDIDATE_PIN_REF_NAMESPACE}/contract`,
    ];

    for (const target of ownedTargets) {
      await assert.rejects(
        observeBindCoordinates(await repositoryAt(repository.path), { kind: "explicit", target }),
        (error: unknown) =>
          error instanceof Error &&
          !(error instanceof TypeError) &&
          error.message === `bind target names a Keiyaku-owned ref: ${target}`,
      );
    }
  });

  test("refuses malformed structured bind observations", async () => {
    const repository = repositoryWithHead();

    await withGitShim(
      "" +
        'if [ "$1" = "for-each-ref" ]; then\n' +
        "  printf 'refs/heads/main\\000not-an-oid\\000\\n'\n" +
        "  exit 0\n" +
        "fi\n" +
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      {},
      async (gitPath) => {
        await assert.rejects(
          observeBindCoordinates(await productionRepositoryAt(repository.path, gitPath), {
            kind: "explicit",
            target: "refs/heads/main",
          }),
          /malformed structured Git output while observing bind coordinates/,
        );
      },
    );
  });

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

  test("admission publishes a journal append and opaque companion in one Git snapshot", async () => {
    const repository = repositoryWithHead();
    const { id, git } = await boundObservedContract(repository);
    const activePath = contractJournalPath(id);
    const original = await readGitPaths(git, [activePath]);
    const originalBytes = await readBlob(git, original.paths.get(activePath)!.oid);
    // The journal codec ignores unrecognized content, but admission must preserve its exact bytes.
    const extended = await writeBlob(git, originalBytes.toString("utf8").replace(/\}\n$/u, ',"zz":true}\n'));
    const tree = await updateGitTree(git, original.tree, new Map([[activePath, { oid: extended }]]));
    const commit = await writeCommit({ repository: git, tree, parent: original.commit });
    repository.run(["update-ref", GIT_REF, commit, original.commit!]);
    const { before, result } = await withGitDecodeChannel(git, async (channel) => {
      const observation = await observeContractsAt(git, channel, [id]);
      const before = contractJournal(observation.journals, id);
      assert.ok(before.state !== null);
      const decision = decideArc({
        input: {
          contractId: id,
          at: "2026-08-06T00:00:00Z",
          data: { title: "Atomic companion", body: "Publish together\nUse one root CAS." },
        },
        attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
        observation: observation.decision,
      });
      assert.ok(decision.kind === "offer", 'expected decision.kind = "offer"');

      const foreignJournal = contractJournalPath(contractId("kei/foreign-companion-target"));
      await assert.rejects(
        () =>
          admit(
            git,
            {
              ...decision.offer,
              companions: [{ path: foreignJournal, bytes: Buffer.from("not a journal\n") }],
            },
            observation,
          ),
        (error: unknown) =>
          error instanceof Error &&
          error.message === `companion path collides with admission-owned path: ${foreignJournal}`,
      );

      return {
        before,
        result: await admit(
          git,
          {
            ...decision.offer,
            companions: [{ path: "test/companion.txt", bytes: Buffer.from("companion\n") }],
          },
          observation,
        ),
      };
    });

    assert.equal(result.kind, "accepted");
    const after = await readGitPaths(git, ["test/companion.txt", contractJournalPath(id)]);
    assert.equal(after.paths.has("test/companion.txt"), true);
    const appended = after.paths.get(contractJournalPath(id));
    assert.ok(appended);
    assert.notEqual(appended.oid, before.oid);
    assert.deepEqual((await readBlob(git, appended.oid)).subarray(0, before.bytes.length), before.bytes);
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

  test("admission rejects broken observations and invalid candidates before publication", async () => {
    const repository = repositoryWithHead();
    const { id, git } = await boundObservedContract(repository);
    const foreign = contractId("kei/foreign-admission-entry");
    const observation = await withGitDecodeChannel(git, (channel) =>
      observeContractsAt(git, channel, [id]),
    );
    const decision = decideAbandon({
      input: { contractId: id, at: "2026-08-06T00:00:00Z" },
      attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
      observation: observation.decision,
    });
    assert.ok(decision.kind === "offer", 'expected decision.kind = "offer"');
    const append = decision.offer.facts[0]!;
    const foreignEntry = { ...append.entries[0]!, contract: foreign };
    const before = await readGitPaths(git, [contractJournalPath(id), contractJournalPath(id, "terminal")]);

    await assert.rejects(
      () => admit(git, { ...decision.offer, facts: [{ ...append, entries: [foreignEntry] }] }, observation),
      (error: unknown) =>
        error instanceof AuthorityCorruptionError &&
        error.message === `candidate journal entry belongs to ${foreign}, not ${id}`,
    );

    const unselected = await withGitDecodeChannel(git, (channel) => observeContractsAt(git, channel, []));
    await assert.rejects(admit(git, decision.offer, unselected), /missing requested Contract observation/u);
    await assert.rejects(admit(git, {
      ...decision.offer,
      facts: [{ ...append, entries: [append.entries[0]!, append.entries[0]!] }],
    }, observation), /duplicate entry/u);

    const after = await readGitPaths(git, [contractJournalPath(id), contractJournalPath(id, "terminal")]);
    assert.equal(after.commit, before.commit);
    assert.equal(after.paths.get(contractJournalPath(id))?.oid, before.paths.get(contractJournalPath(id))?.oid);
    assert.equal(after.paths.has(contractJournalPath(id, "terminal")), false);
  });

  test("targeted and complete collection refuse mislabeled, duplicate and wrong-type journals", async () => {
    const repository = repositoryWithHead();
    const { id, git } = await boundObservedContract(repository);
    const active = contractJournalPath(id);
    const terminal = contractJournalPath(id, "terminal");
    const before = await readGitPaths(git, [active]);
    const blob = { oid: before.paths.get(active)!.oid };
    const misplaced = contractJournalPath(contractId("kei/foreign-journal-path"));
    let expected = before.commit!;
    for (const { changes, error, selected } of [
      { changes: new Map([[active, null], [terminal, blob]]), error: /journal path class/u, selected: id },
      { changes: new Map([[terminal, blob]]), error: /duplicate contract journal identity/u, selected: id },
      { changes: new Map([[misplaced, blob]]), error: /canonical contract identity/u, selected: contractId("kei/foreign-journal-path") },
      { changes: new Map([[active, { oid: repository.run(["rev-parse", "HEAD"]).trim(), mode: "160000" }]]),
        error: /journal path is not a blob/u, selected: id },
    ]) {
      const tree = await updateGitTree(git, before.tree, changes);
      const commit = await writeCommit({ repository: git, tree, parent: before.commit });
      repository.run(["update-ref", GIT_REF, commit, expected]);
      expected = commit;
      await withGitDecodeChannel(git, async (channel) => {
        await assert.rejects(observeContractsAt(git, channel, [selected]), error);
        await assert.rejects(withGitReadObservation(git, channel, observeContractJournals), error);
      });
    }
  });

  test("active world rejects a duplicate terminal path for an already observed prerequisite", async () => {
    const repository = repositoryWithHead();
    const { id, git } = await boundObservedContract(repository);
    const dependent = await bindOperation({ scope: git, terms: terms([id]) });
    assert.ok(dependent.kind === "accepted");
    const active = contractJournalPath(id);
    const terminal = contractJournalPath(id, "terminal");
    const before = await readGitPaths(git, [active]);
    const oid = before.paths.get(active)!.oid;
    const observe = (reads: string[]) =>
      withGitDecodeChannel(git, (channel) =>
        withGitReadObservation(git, channel, (read) =>
          observeActiveContractWorld({
            ...read,
            readBlobs: (oids) => {
              reads.push(...oids);
              return read.readBlobs(oids);
            },
          }),
        ),
      );

    const reads: string[] = [];
    const healthy = await observe(reads);
    assert.equal(healthy.decision.get(id)?.id, id);
    assert.equal(reads.filter((read) => read === oid).length, 1);

    const tree = await updateGitTree(git, before.tree, new Map([[terminal, { oid }]]));
    const commit = await writeCommit({ repository: git, tree, parent: before.commit });
    repository.run(["update-ref", GIT_REF, commit, before.commit!]);
    const corruptReads: string[] = [];
    await assert.rejects(observe(corruptReads), {
      name: "AuthorityCorruptionError",
      message: `duplicate contract journal identity: ${id}`,
    });
    assert.deepEqual(corruptReads, reads, "path validation does not read the duplicate journal blob");
  });

  test("classifies the candidate journal from its folded terminal state", async () => {
    const repository = repositoryWithHead();
    const { id, git } = await boundObservedContract(repository);

    const activeObservation = await withGitDecodeChannel(git, (channel) =>
      observeContractsAt(git, channel, [id]),
    );
    const activeDecision = decideArc({
      input: {
        contractId: id,
        at: "2026-08-06T00:00:00Z",
        data: { title: "Remain active", body: "Classify folded state\nKeep the journal active." },
      },
      attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
      observation: activeObservation.decision,
    });
    assert.ok(activeDecision.kind === "offer", 'expected activeDecision.kind = "offer"');
    assert.equal((await admit(git, activeDecision.offer, activeObservation)).kind, "accepted");
    const afterActive = await readGitPaths(git, [
      contractJournalPath(id, "active"),
      contractJournalPath(id, "terminal"),
    ]);
    assert.equal(afterActive.paths.has(contractJournalPath(id, "active")), true);
    assert.equal(afterActive.paths.has(contractJournalPath(id, "terminal")), false);

    const terminalObservation = await withGitDecodeChannel(git, (channel) =>
      observeContractsAt(git, channel, [id]),
    );
    const terminalDecision = decideAbandon({
      input: { contractId: id, at: "2026-08-06T00:00:01Z" },
      attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW")] },
      observation: terminalObservation.decision,
    });
    assert.ok(terminalDecision.kind === "offer", 'expected terminalDecision.kind = "offer"');
    assert.equal((await admit(git, terminalDecision.offer, terminalObservation)).kind, "accepted");
    const afterTerminal = await readGitPaths(git, [
      contractJournalPath(id, "active"),
      contractJournalPath(id, "terminal"),
    ]);
    assert.equal(afterTerminal.paths.has(contractJournalPath(id, "active")), false);
    assert.equal(afterTerminal.paths.has(contractJournalPath(id, "terminal")), true);
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

  test("protocol bind admits one explicit identity and refuses a second use of it", async () => {
    const repository = repositoryWithHead();
    const git = await repositoryAt(repository.path);
    const id = contractId(`kei/${"a".repeat(48)}`);
    const first = await bindOperation({
      scope: git,
      contractId: id,
      terms: terms([]),
    });
    assert.ok(first.kind === "accepted", 'expected first.kind = "accepted"');
    assert.equal(first.state.id, id);

    const collision = await bindOperation({
      scope: git,
      contractId: id,
      terms: terms([]),
    });
    assert.deepEqual(collision, {
      kind: "refused",
      refusal: { kind: "contract-exists" },
    });
  });

  test("targetless bind retries after a different HEAD OID fails the atomic assertion", async () => {
    const repository = repositoryWithHead();
    const predecessor = repository.run(["rev-parse", "HEAD"]).trim();
    const tree = repository.run(["rev-parse", `${predecessor}^{tree}`]).trim();
    const moved = repository.run(["commit-tree", tree, "-p", predecessor, "-m", "move HEAD"]).trim();
    repository.run(["branch", "feature", moved]);
    const marker = join(repository.path, "bind-head-observation.marker");
    const git = await repositoryAt(repository.path);

    const bound = await withGitShim(
      [
        'if [ "$1 $2" = "update-ref --stdin" ] && [ ! -e "$KEIYAKU_BIND_MARKER" ]; then',
        '  : > "$KEIYAKU_BIND_MARKER"',
        '  "$KEIYAKU_REAL_GIT" symbolic-ref HEAD refs/heads/feature || exit $?',
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_BIND_MARKER: marker },
      async (gitPath) =>
        bindOperation({
          scope: await productionRepositoryAt(repository.path, gitPath),
          title: "Different OID checkout movement",
          terms: terms([]),
        }),
    );

    const id = protocolContractId("Different OID checkout movement");
    assert.ok(bound.kind === "accepted", 'expected bound.kind = "accepted"');
    assert.equal(repository.run(["symbolic-ref", "HEAD"]).trim(), "refs/heads/feature");
    assert.equal((await observeContract(git, id)).state?.coordinates.start, moved);
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

  test("bind and amend reject unresolved after", async () => {
    const repository = repositoryWithHead();
    const git = await repositoryAt(repository.path);
    const missing = contractId("kei/missing-prerequisite");
    const bound = await bindOperation({
      scope: git,
      terms: terms([missing]),
    });
    assert.ok(bound.kind === "refused", 'expected bound.kind = "refused"');
    assert.equal(bound.refusal.kind, "unknown-prerequisite");

    const existing = await bindOperation({
      scope: git,
      terms: terms([]),
    });
    assert.ok(existing.kind === "accepted", 'expected existing.kind = "accepted"');
    const existingState = (await observeContract(git, existing.state.id)).state;
    if (existingState === null) throw new Error("existing contract state was not observed");
    const amended = await amendOperation({
      scope: git,
      contractId: existing.state.id,
      source: existingState.terms,
      terms: terms([missing]),
    });
    assert.deepEqual(amended, {
      kind: "refused",
      refusal: { kind: "unknown-prerequisite" },
    });
  });

  test("bind and amend leave eligible prerequisites unmaterialized", async () => {
    const repository = repositoryWithHead();
    const activeDependency = await bindOperation({
      scope: await repositoryAt(repository.path),
      terms: terms([]),
    });
    assert.ok(activeDependency.kind === "accepted", 'expected activeDependency.kind = "accepted"');
    const waiting = await bindOperation({
      scope: await repositoryAt(repository.path),
      terms: terms([activeDependency.state.id]),
    });
    assert.ok(waiting.kind === "accepted", 'expected waiting.kind = "accepted"');

    const git = await repositoryAt(repository.path);
    const keis = Keis.of(await Repo.at({ path: repository.path }));
    const { kei } = accepted(await keis.bind({ terms: contractBody(), target: null, gates: [] }));
    assert.equal(accepted(await kei.deliver()).placement?.kind, "placed");

    const immediatelyBound = await bindOperation({
      scope: git,
      terms: terms([kei.id]),
    });
    assert.ok(immediatelyBound.kind === "accepted", 'expected immediatelyBound.kind = "accepted"');
    assert.deepEqual(
      immediatelyBound.facts.map((entry) => entry.kind),
      ["bind"],
    );

    const waitingState = (await observeContract(git, waiting.state.id)).state;
    if (waitingState === null) throw new Error("waiting contract state was not observed");

    const amended = await amendOperation({
      scope: git,
      contractId: waiting.state.id,
      source: waitingState.terms,
      terms: terms([kei.id]),
    });
    assert.ok(amended.kind === "accepted", 'expected amended.kind = "accepted"');
    assert.deepEqual(
      amended.facts.map((entry) => entry.kind),
      ["amend"],
    );
  });
});
