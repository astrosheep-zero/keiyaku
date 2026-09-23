import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { AuthorityCorruptionError, Keiyaku } from "../src/index.js";
import { prepareDelivery } from "../src/protocol/deliver.js";
import { admit } from "../src/git/admission.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  GIT_REF,
  DELIVERY_REF_NAMESPACE,
  readBlob,
  readGit,
  repositoryAt as productionRepositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import { observeBindCoordinates, observeContractWorld, observeContractsForAdmissionAt } from "../src/git/observe.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { runGit } from "../src/git/process.js";
import { contractJournalPath } from "../src/git/identity.js";
import { decideAbandon } from "../src/core/verbs/abandon.js";
import { bindOperation as rawBindOperation } from "../src/protocol/bind.js";
import { amendOperation as rawAmendOperation } from "../src/protocol/amend.js";
import {
  contractId,
  contractIdFromSegment,
  documentKey,
  entryUlid, type AmendData,
  type ContractId,
  type ContractTerms
} from "../src/core/facts/types.js";
import { decideArc } from "../src/core/verbs/arc.js";
import { decideDeliver } from "../src/core/verbs/deliver.js";
import { admitIntent } from "../src/protocol/intent.js";
import { admitPlacement } from "../src/protocol/placement.js";
import { appointManagedWorktrees, readManagedWorktreeAppointment } from "../src/workspace-place.js";
import {
  cachedRepoAt,
  cachedRepositoryAt,
  makeGitRepository,
  observeContract,
  protocolContractId,
  snapshotGitRepository,
  type TestGitRepository,
  withGitShim,
} from "./support/git.js";

const repositoryAt = cachedRepositoryAt;

const NO_VERIFICATION = { kind: "prepared", data: null } as const;
const DELIVERY_DOCUMENT = "# Contract\n";

let untitledBind = 0;

function bindOperation(
  input: Omit<Parameters<typeof rawBindOperation>[0], "channel" | "verification" | "contractId"> &
    Readonly<{
      title?: string;
      contractId?: ContractId;
    }>,
) {
  const { title, contractId: id, ...rest } = input;
  return withGitDecodeChannel(input.scope, (channel) =>
    rawBindOperation({
      ...rest,
      channel,
      contractId:
        id ??
        (title === undefined ? contractIdFromSegment(`protocol-bind-${untitledBind++}`) : protocolContractId(title)),
      verification: NO_VERIFICATION,
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
        : { source, deriveAmendment: () => ({ terms, verification: NO_VERIFICATION }) }),
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

async function preparationCoordinates(
  repository: Awaited<ReturnType<typeof repositoryAt>>,
  state: NonNullable<Awaited<ReturnType<typeof observeContract>>["state"]>,
) {
  await appointManagedWorktrees(repository, [state.id]);
  const appointment = await readManagedWorktreeAppointment(repository, state.id);
  if (appointment.kind !== "appointed") throw new Error(`managed worktree appointment missing for ${state.id}`);
  if (!existsSync(appointment.path))
    await runGit(repository, ["worktree", "add", "--detach", appointment.path, "HEAD"]);
  return { contractId: state.id, coordinates: state.coordinates };
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
    after,
  } as const;
}

// Each case owns its repository, fault injector and cleanup; no process-global mocks.
describe("protocol-bind-observe isolated fixtures", { concurrency: 3 }, () => {
  test("observes a targetless detached bind snapshot", async () => {
    const repository = repositoryWithHead();
    repository.run(["checkout", "--quiet", "--detach"]);
    const start = repository.run(["rev-parse", "HEAD"]).trim();

    assert.deepEqual(await observeBindCoordinates(await repositoryAt(repository.path)), { start, branch: null });
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
        throw new Error("seat close failed after publication");
      },
    };
    const bound = await bindOperation({
      scope: git,
      terms: terms([]),
      workspace: "worktree",
    });
    assert.ok(bound.kind === "accepted", "expected bound.kind = \"accepted\"");
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
        workspace: "worktree",
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

  test("admission publishes a journal append and opaque companion in one Git snapshot", async () => {
    const repository = repositoryWithHead();
    const bound = await Keiyaku.with().bind({
      repo: await cachedRepoAt(repository.path),
      markdown: contractBody(),
      workspace: "worktree",
    });
    const id = (await bound.keiyaku.state()).id;
    const git = await repositoryAt(repository.path);
    const { before, result } = await withGitDecodeChannel(git, async (channel) => {
      const observation = await observeContractsForAdmissionAt(git, channel, [id]);
      const before = observation.admission.snapshot.paths.get(contractJournalPath(id));
      assert.ok(before);
      const decision = decideArc({
        input: {
          contractId: id,
          at: "2026-08-06T00:00:00Z",
          data: { title: "Atomic companion", objective: "Publish together", brief: "Use one root CAS." },
        },
        attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
        observation: observation.decision,
      });
      assert.ok(decision.kind === "offer", "expected decision.kind = \"offer\"");

      const foreignJournal = contractJournalPath(contractId("kei/foreign-companion-target"));
      await assert.rejects(
        () =>
          admit(
            git,
            {
              ...decision.offer,
              companions: [{ path: foreignJournal, bytes: Buffer.from("not a journal\n") }],
            },
            observation.admission,
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
          observation.admission,
        ),
      };
    });

    assert.equal(result.kind, "accepted");
    const after = await readGit(git);
    assert.equal(after.paths.has("test/companion.txt"), true);
    assert.notEqual(after.paths.get(contractJournalPath(id))?.oid, before.oid);
  });

  test("a failed Git CAS publishes neither its journal append nor its companion", async () => {
    const repository = repositoryWithHead();
    const bound = await Keiyaku.with().bind({
      repo: await cachedRepoAt(repository.path),
      markdown: contractBody(),
      workspace: "worktree",
    });
    const id = (await bound.keiyaku.state()).id;
    const git = await repositoryAt(repository.path);
    const observation = await withGitDecodeChannel(git, (channel) => observeContractsForAdmissionAt(git, channel, [id]));
    const before = observation.admission.snapshot.paths.get(contractJournalPath(id));
    assert.ok(before);
    const decision = decideArc({
      input: {
        contractId: id,
        at: "2026-08-06T00:00:00Z",
        data: { title: "Losing companion", objective: "Lose one CAS", brief: "Leave no partial fact." },
      },
      attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
      observation: observation.decision,
    });
    assert.ok(decision.kind === "offer", "expected decision.kind = \"offer\"");

    const winnerBlob = await writeBlob(git, "winner\n");
    const winnerTree = await updateGitTree(
      git,
      observation.admission.snapshot.tree,
      new Map([["test/winner.txt", { oid: winnerBlob }]]),
    );
    const winnerCommit = await writeCommit({
      repository: git,
      tree: winnerTree,
      parent: observation.admission.snapshot.commit,
    });
    assert.equal(
      (
        await updateRefsAtomically(git, [
          {
            ref: GIT_REF,
            newOid: winnerCommit,
            expectedOid: observation.admission.snapshot.commit,
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
      observation.admission,
    );

    assert.equal(result.kind, "publication-failed");
    const after = await readGit(git);
    assert.equal(after.paths.has("test/winner.txt"), true);
    assert.equal(after.paths.has("test/loser.txt"), false);
    assert.equal(after.paths.get(contractJournalPath(id))?.oid, before.oid);
  });

  test("rejects a foreign-contract journal entry before publication", async () => {
    const repository = repositoryWithHead();
    const bound = await Keiyaku.with().bind({
      repo: await cachedRepoAt(repository.path),
      markdown: contractBody(),
      workspace: "worktree",
    });
    const id = (await bound.keiyaku.state()).id;
    const foreign = contractId("kei/foreign-admission-entry");
    const git = await repositoryAt(repository.path);
    const observation = await withGitDecodeChannel(git, (channel) => observeContractsForAdmissionAt(git, channel, [id]));
    const decision = decideAbandon({
      input: { contractId: id, at: "2026-08-06T00:00:00Z" },
      attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
      observation: observation.decision,
    });
    assert.ok(decision.kind === "offer", "expected decision.kind = \"offer\"");
    const append = decision.offer.facts[0]!;
    const foreignEntry = { ...append.entries[0]!, contract: foreign };
    const before = await readGit(git);

    await assert.rejects(
      () =>
        admit(
          git,
          { ...decision.offer, facts: [{ ...append, entries: [foreignEntry] }] },
          observation.admission,
        ),
      (error: unknown) =>
        error instanceof AuthorityCorruptionError &&
        error.message === `candidate journal entry belongs to ${foreign}, not ${id}`,
    );

    const after = await readGit(git);
    assert.equal(after.commit, before.commit);
    assert.equal(after.paths.get(contractJournalPath(id))?.oid, before.paths.get(contractJournalPath(id))?.oid);
    assert.equal(after.paths.has(contractJournalPath(id, "terminal")), false);
  });

  test("classifies the candidate journal from its folded terminal state", async () => {
    const repository = repositoryWithHead();
    const bound = await Keiyaku.with().bind({
      repo: await cachedRepoAt(repository.path),
      markdown: contractBody(),
      workspace: "worktree",
    });
    const id = (await bound.keiyaku.state()).id;
    const git = await repositoryAt(repository.path);

    const activeObservation = await withGitDecodeChannel(git, (channel) =>
      observeContractsForAdmissionAt(git, channel, [id]),
    );
    const activeDecision = decideArc({
      input: {
        contractId: id,
        at: "2026-08-06T00:00:00Z",
        data: { title: "Remain active", objective: "Classify folded state", brief: "Keep the journal active." },
      },
      attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
      observation: activeObservation.decision,
    });
    assert.ok(activeDecision.kind === "offer", "expected activeDecision.kind = \"offer\"");
    assert.equal((await admit(git, activeDecision.offer, activeObservation.admission)).kind, "accepted");
    const afterActive = await readGit(git);
    assert.equal(afterActive.paths.has(contractJournalPath(id, "active")), true);
    assert.equal(afterActive.paths.has(contractJournalPath(id, "terminal")), false);

    const terminalObservation = await withGitDecodeChannel(git, (channel) =>
      observeContractsForAdmissionAt(git, channel, [id]),
    );
    const terminalDecision = decideAbandon({
      input: { contractId: id, at: "2026-08-06T00:00:01Z" },
      attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW")] },
      observation: terminalObservation.decision,
    });
    assert.ok(terminalDecision.kind === "offer", "expected terminalDecision.kind = \"offer\"");
    assert.equal((await admit(git, terminalDecision.offer, terminalObservation.admission)).kind, "accepted");
    const afterTerminal = await readGit(git);
    assert.equal(afterTerminal.paths.has(contractJournalPath(id, "active")), false);
    assert.equal(afterTerminal.paths.has(contractJournalPath(id, "terminal")), true);
  });

  test("bind reobserves and atomically asserts target coordinates after Git movement", async () => {
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
          workspace: "worktree",
        }),
    );

    assert.ok(bound.kind === "accepted", "expected bound.kind = \"accepted\"");
    const state = (await observeContract(git, bound.value.contractId)).state;
    assert.equal(state?.coordinates.start, moved);
    assert.equal(bound.value.contractId, protocolContractId("Moving target"));
  });

  test("protocol bind admits one explicit identity and refuses a second use of it", async () => {
    const repository = repositoryWithHead();
    const git = await repositoryAt(repository.path);
    const id = contractId(`kei/${"a".repeat(48)}`);
    const first = await bindOperation({
      scope: git,
      contractId: id,
      terms: terms([]),
      workspace: "worktree",
    });
    assert.ok(first.kind === "accepted", "expected first.kind = \"accepted\"");
    assert.equal(first.value.contractId, id);

    const collision = await bindOperation({
      scope: git,
      contractId: id,
      terms: terms([]),
      workspace: "worktree",
    });
    assert.deepEqual(collision, {
      kind: "refused",
      refusal: { kind: "contract-exists", contractId: id },
    });
  });

  test("targetless bind reobserves a different HEAD OID after atomic verification fails", async () => {
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
          workspace: "worktree",
        }),
    );

    assert.ok(bound.kind === "accepted", "expected bound.kind = \"accepted\"");
    assert.equal(repository.run(["symbolic-ref", "HEAD"]).trim(), "refs/heads/feature");
    assert.equal((await observeContract(git, bound.value.contractId)).state?.coordinates.start, moved);
  });

  test("public reconcile and admission observation retain canonical journal validation", async () => {
    const repository = repositoryWithHead();
    const bound = await Keiyaku.with().bind({
      repo: await cachedRepoAt(repository.path),
      markdown: contractBody(),
      workspace: "worktree",
    });
    const id = (await bound.keiyaku.state()).id;
    const git = await repositoryAt(repository.path);
    const snapshot = await readGit(git);
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
      () => withGitDecodeChannel(git, (channel) => observeContractsForAdmissionAt(git, channel, [id])),
      (error: unknown) =>
        error instanceof AuthorityCorruptionError && /journal entry is not canonical/.test(error.message),
    );
    await assert.rejects(
      () => bound.keiyaku.reconcile(),
      (error: unknown) =>
        error instanceof AuthorityCorruptionError && /journal entry is not canonical/.test(error.message),
    );
  });

  test("bind and amend reject unresolved after", async () => {
    const repository = repositoryWithHead();
    const git = await repositoryAt(repository.path);
    const missing = contractId("kei/missing-prerequisite");
    const bound = await bindOperation({
      scope: git,
      terms: terms([missing]),
      workspace: "worktree",
    });
    assert.ok(bound.kind === "refused", "expected bound.kind = \"refused\"");
    assert.equal(bound.refusal.kind, "unknown-prerequisite");

    const existing = await bindOperation({
      scope: git,
      terms: terms([]),
      workspace: "worktree",
    });
    assert.ok(existing.kind === "accepted", "expected existing.kind = \"accepted\"");
    const existingState = (await observeContract(git, existing.value.contractId)).state;
    if (existingState === null) throw new Error("existing contract state was not observed");
    const amended = await amendOperation({
      scope: git,
      contractId: existing.value.contractId,
      source: existingState.terms,
      terms: terms([missing]),
    });
    assert.deepEqual(amended, {
      kind: "refused",
      refusal: { kind: "unknown-prerequisite", contractId: existing.value.contractId },
    });
  });

  test("bind and amend leave eligible prerequisites unmaterialized", async () => {
    const repository = repositoryWithHead();
    const activeDependency = await bindOperation({
      scope: await repositoryAt(repository.path),
      terms: terms([]),
      workspace: "worktree",
    });
    assert.ok(activeDependency.kind === "accepted", "expected activeDependency.kind = \"accepted\"");
    const waiting = await bindOperation({
      scope: await repositoryAt(repository.path),
      terms: terms([activeDependency.value.contractId]),
      workspace: "worktree",
    });
    assert.ok(waiting.kind === "accepted", "expected waiting.kind = \"accepted\"");

    const claimedDependency = await bindOperation({
      scope: await repositoryAt(repository.path),
      terms: terms([]),
      workspace: "worktree",
    });
    assert.ok(claimedDependency.kind === "accepted", "expected claimedDependency.kind = \"accepted\"");
    const git = await repositoryAt(repository.path);
    const state = (
      await withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, observeContractWorld))
    ).contracts.get(claimedDependency.value.contractId)?.state;
    if (state === undefined || state === null) throw new Error("claimable dependency state was not observed");
    const delivery = await prepareDelivery(git, await preparationCoordinates(git, state), {
      title: "Targeted",
      document: DELIVERY_DOCUMENT,
    });
    assert.ok(delivery.kind === "prepared", "expected delivery.kind = \"prepared\"");
    const delivered = await withGitDecodeChannel(git, (channel) =>
      admitIntent(
        channel,
        git,
        {
          contractId: claimedDependency.value.contractId,
          at: "2026-08-06T00:00:00Z",
          preparation: { kind: "prepared", document: state.terms.document.key, data: delivery.data },
        },
        decideDeliver<never>,
      ),
    );
    assert.equal(delivered.kind, "accepted");
    const claimed = await withGitDecodeChannel(git, (channel) =>
      admitPlacement({
        channel,
        repository: git,
        target: state.coordinates.target,
        placement: { contractId: claimedDependency.value.contractId, at: "2026-08-06T00:00:01Z" },
      }),
    );
    assert.equal(claimed.kind, "accepted");

    const immediatelyBound = await bindOperation({
      scope: git,
      terms: terms([claimedDependency.value.contractId]),
      workspace: "worktree",
    });
    assert.ok(immediatelyBound.kind === "accepted", "expected immediatelyBound.kind = \"accepted\"");
    assert.deepEqual(
      immediatelyBound.facts.map((entry) => entry.kind),
      ["bind"],
    );

    const waitingState = (await observeContract(git, waiting.value.contractId)).state;
    if (waitingState === null) throw new Error("waiting contract state was not observed");

    const amended = await amendOperation({
      scope: git,
      contractId: waiting.value.contractId,
      source: waitingState.terms,
      terms: terms([claimedDependency.value.contractId]),
    });
    assert.ok(amended.kind === "accepted", "expected amended.kind = \"accepted\"");
    assert.deepEqual(
      amended.facts.map((entry) => entry.kind),
      ["amend"],
    );
  });
});
