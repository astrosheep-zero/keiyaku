import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AuthorityCorruptionError, Keiyaku } from "../src/index.js";
import { encodeEntry } from "../src/core/facts/codec.js";
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
import { bindOperation as rawBindOperation } from "../src/protocol/bind.js";
import { amendOperation as rawAmendOperation } from "../src/protocol/amend.js";
import {
  contractId,
  contractIdFromSegment,
  documentKey,
  entryUlid,
  gate,
  type AmendData,
  type ContractId,
  type ContractTerms,
  type JournalEntry,
  type SnapshotId,
} from "../src/core/facts/types.js";
import { decideArc } from "../src/core/verbs/arc.js";
import { decideDeliver } from "../src/core/verbs/deliver.js";
import { admitIntent } from "../src/protocol/intent.js";
import { admitPlacement } from "../src/protocol/placement.js";
import { runProtocol } from "../src/protocol/run.js";
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

test("observes a targetless current snapshot when bind target is omitted", async () => {
  const repository = repositoryWithHead();
  const start = repository.run(["rev-parse", "HEAD"]).trim();

  assert.deepEqual(await observeBindCoordinates(await repositoryAt(repository.path)), {
    start,
    branch: "refs/heads/main",
  });
});

test("observes an explicit target by its exact full ref", async () => {
  const repository = repositoryWithHead();
  repository.run(["branch", "release"]);
  const target = "refs/heads/release";
  const start = repository.run(["rev-parse", target]).trim();

  assert.deepEqual(await observeBindCoordinates(await repositoryAt(repository.path), { kind: "explicit", target }), {
    target,
    start,
    branch: "refs/heads/main",
  });
});

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

test("observes an unborn targetless HEAD as a typed pre-admission outcome", async () => {
  const repository = makeGitRepository();
  assert.deepEqual(await observeBindCoordinates(await repositoryAt(repository.path)), {
    kind: "unborn-head",
    branch: "refs/heads/main",
  });
});

test("observes current-branch intent from the attached HEAD without a second resolver", async () => {
  const repository = repositoryWithHead();
  const start = repository.run(["rev-parse", "HEAD"]).trim();

  assert.deepEqual(await observeBindCoordinates(await repositoryAt(repository.path), { kind: "current-branch" }), {
    start,
    target: "refs/heads/main",
    branch: "refs/heads/main",
  });

  repository.run(["checkout", "--quiet", "--detach"]);
  assert.deepEqual(await observeBindCoordinates(await repositoryAt(repository.path), { kind: "current-branch" }), {
    start,
    branch: null,
  });
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

function contractBody(): string {
  return [
    "# Targeted observation",
    "",
    "## Context",
    "Test one-contract observation.",
    "",
    "## Objective",
    "Avoid decoding unrelated journals.",
    "",
    "## Design",
    "Use the requested contract primitive.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### C1",
    "The local operation ignores unrelated malformed journals.",
  ].join("\n");
}

async function publishMalformedJournal(
  repository: Awaited<ReturnType<typeof repositoryAt>>,
  path: string,
): Promise<void> {
  const git = await readGit(repository);
  const malformed = await writeBlob(repository, "not a journal\n");
  const tree = await updateGitTree(repository, git.tree, new Map([[path, { oid: malformed }]]));
  const commit = await writeCommit({ repository, tree, parent: git.commit });
  assert.equal(
    (
      await updateRefsAtomically(repository, [
        {
          ref: GIT_REF,
          newOid: commit,
          expectedOid: git.commit,
        },
      ])
    ).kind,
    "published",
  );
}

async function publishMalformedUnrelatedJournal(repository: Awaited<ReturnType<typeof repositoryAt>>): Promise<void> {
  await publishMalformedJournal(repository, "contracts/unrelated.jsonl");
}

test("batches full Contract observation through one call-scoped object process", async () => {
  const repository = repositoryWithHead();
  await Keiyaku.bind({ repo: await cachedRepoAt(repository.path), markdown: contractBody(), workspace: "worktree" });
  for (let index = 1; index < 4; index += 1) {
    await Keiyaku.bind({ repo: await cachedRepoAt(repository.path), markdown: contractBody(), workspace: "worktree" });
  }

  const git = await readGit(await repositoryAt(repository.path));
  const journals = [...git.paths.keys()].filter((path) => path.startsWith("contracts/") && path.endsWith(".jsonl"));
  assert.equal(journals.length, 4);
  const log = join(repository.path, "cat-file.log");
  const observed = await withGitShim(
    'if [ "$1" = "cat-file" ]; then printf \'%s\\n\' "$*" >> "$KEIYAKU_READ_LOG"; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { KEIYAKU_READ_LOG: log },
    async (gitPath) => {
      const git = await productionRepositoryAt(repository.path, gitPath);
      return withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, observeContractWorld));
    },
  );

  assert.equal(observed.contracts.size, journals.length);
  const invocations = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command.startsWith("cat-file blob ")).length, 0);
});

function gitProcessCounts(invocations: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const invocation of invocations) {
    const command = invocation.split(" ")[0];
    if (command === undefined || command.length === 0) throw new Error("Git invocation is missing a command");
    counts[command] = (counts[command] ?? 0) + 1;
  }
  return counts;
}

test("known publication failure is returned without a post-result ref read", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const id = (await bound.keiyaku.state()).id;
  const failed = join(repository.path, "publication-failed.marker");
  const postRead = join(repository.path, "post-publication-read.marker");

  const result = await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      "  cat >/dev/null",
      '  touch "$KEIYAKU_PUBLICATION_FAILED"',
      '  printf "forced publication failure\\n" >&2',
      "  exit 42",
      "fi",
      'if [ -e "$KEIYAKU_PUBLICATION_FAILED" ] && [ "$1" = "rev-parse" ]; then',
      '  touch "$KEIYAKU_POST_FAILURE_READ"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {
      KEIYAKU_PUBLICATION_FAILED: failed,
      KEIYAKU_POST_FAILURE_READ: postRead,
    },
    async (gitPath) => {
      const scoped = await productionRepositoryAt(repository.path, gitPath);
      return withGitDecodeChannel(scoped, async (channel) => {
        const observation = await observeContractsForAdmissionAt(scoped, channel, [id]);
        const attempt = { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] };
        const decision = decideArc({
          input: {
            contractId: id,
            at: "2026-08-06T00:00:00Z",
            data: { title: "Failed publication", objective: "Keep failure factual", brief: "Do not reread refs." },
          },
          attempt,
          observation: observation.decision,
        });
        assert.equal(decision.kind, "offer");
        if (decision.kind !== "offer") throw new Error("arc decision was not an offer");
        return admit(scoped, decision.offer, observation.admission);
      });
    },
  );

  assert.equal(result.kind, "publication-failed");
  if (result.kind !== "publication-failed") throw new Error("publication failure was not preserved");
  assert.match(result.diagnostic, /forced publication failure/);
  assert.equal(existsSync(postRead), false);
});

test("admission publishes a journal append and opaque companion in one Git snapshot", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({
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
    assert.equal(decision.kind, "offer");
    if (decision.kind !== "offer") throw new Error("arc decision was not an offer");

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
  const bound = await Keiyaku.bind({
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
  assert.equal(decision.kind, "offer");
  if (decision.kind !== "offer") throw new Error("arc decision was not an offer");

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

async function appendUnrelatedGitJournals(
  repository: Awaited<ReturnType<typeof repositoryAt>>,
  count: number,
  start: SnapshotId,
): Promise<void> {
  const snapshot = await readGit(repository);
  const changes = new Map();
  for (let index = 0; index < count; index += 1) {
    const id = contractId(`kei/git-load-${index}`);
    const entry: JournalEntry = {
      v: 1,
      kind: "bind",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      at: "2026-08-06T00:00:00Z",
      data: {
        coordinates: { start, workspace: "worktree" },
        terms: terms([]),
      },
    };
    changes.set(contractJournalPath(id), { oid: await writeBlob(repository, encodeEntry(entry)) });
  }
  const tree = await updateGitTree(repository, snapshot.tree, changes);
  const commit = await writeCommit({ repository, tree, parent: snapshot.commit });
  assert.equal(
    (
      await updateRefsAtomically(repository, [
        {
          ref: GIT_REF,
          newOid: commit,
          expectedOid: snapshot.commit,
        },
      ])
    ).kind,
    "published",
  );
}

async function amendObjectIo(
  repository: Awaited<ReturnType<typeof repositoryAt>>,
  id: ContractId,
): Promise<Record<string, number>> {
  const state = (await observeContract(repository, id)).state;
  if (state === null) throw new Error("bound contract state was not observed");
  const log = join(repository.effectiveCwd, "amend-object-io.log");
  const amended = await withGitShim(
    'printf \'%s\\n\' "$*" >> "$KEIYAKU_READ_LOG"\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { KEIYAKU_READ_LOG: log },
    async (gitPath) =>
      amendOperation({
        scope: await productionRepositoryAt(repository.effectiveCwd, gitPath),
        contractId: id,
        source: state.terms,
        terms: state.terms,
      }),
  );
  assert.equal(amended.kind, "accepted");
  return gitProcessCounts(readFileSync(log, "utf8").split("\n").filter(Boolean));
}

async function amendBatchRequests(
  repository: Awaited<ReturnType<typeof repositoryAt>>,
  id: ContractId,
): Promise<number> {
  const state = (await observeContract(repository, id)).state;
  if (state === null) throw new Error("bound contract state was not observed");
  const log = join(repository.effectiveCwd, "amend-batch-oids.log");
  const amended = await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      '  tee "$KEIYAKU_BATCH_OID_LOG" | "$KEIYAKU_REAL_GIT" "$@"',
      "  exit $?",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_BATCH_OID_LOG: log },
    async (gitPath) =>
      amendOperation({
        scope: await productionRepositoryAt(repository.effectiveCwd, gitPath),
        contractId: id,
        source: state.terms,
        terms: state.terms,
      }),
  );
  assert.equal(amended.kind, "accepted");
  return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
}

test("single-contract amend object I/O stays fixed as the git grows", async () => {
  const one = repositoryWithHead();
  const oneGit = await repositoryAt(one.path);
  const oneBound = await bindOperation({ scope: oneGit, terms: terms([]), workspace: "worktree" });
  assert.equal(oneBound.kind, "accepted");
  if (oneBound.kind !== "accepted") throw new Error("one-contract bind was not accepted");

  const many = repositoryWithHead();
  const manyGit = await repositoryAt(many.path);
  const manyBound = await bindOperation({ scope: manyGit, terms: terms([]), workspace: "worktree" });
  assert.equal(manyBound.kind, "accepted");
  if (manyBound.kind !== "accepted") throw new Error("many-contract bind was not accepted");
  const manyState = (await observeContract(manyGit, manyBound.value.contractId)).state;
  if (manyState === null) throw new Error("many-contract bound state was not observed");
  await appendUnrelatedGitJournals(manyGit, 32, manyState.coordinates.start);

  const oneIo = await amendObjectIo(oneGit, oneBound.value.contractId);
  const manyIo = await amendObjectIo(manyGit, manyBound.value.contractId);
  assert.deepEqual(manyIo, oneIo);
  assert.equal(oneIo.mktree, 1);

  assert.equal(
    await amendBatchRequests(manyGit, manyBound.value.contractId),
    await amendBatchRequests(oneGit, oneBound.value.contractId),
  );
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

  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("moved target bind was not accepted");
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
  assert.equal(first.kind, "accepted");
  if (first.kind !== "accepted") throw new Error("explicit bind was not accepted");
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

test("bind never restores a targeted checkout that moved to a same-OID branch", async () => {
  const repository = repositoryWithHead();
  repository.run(["branch", "feature"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  const git = await repositoryAt(repository.path);

  const bound = await withGitShim(
    [
      'if [ "$1 $2" = "update-ref --stdin" ]; then',
      '  "$KEIYAKU_REAL_GIT" symbolic-ref HEAD refs/heads/feature || exit $?',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) =>
      bindOperation({
        scope: await productionRepositoryAt(repository.path, gitPath),
        title: "Same OID checkout movement",
        terms: terms([]),
        targetSelection: { kind: "explicit", target: "refs/heads/main" },
        workspace: "worktree",
      }),
  );

  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("same-OID moved bind was not accepted");
  assert.equal(repository.run(["symbolic-ref", "HEAD"]).trim(), "refs/heads/feature");
  assert.equal((await observeContract(git, bound.value.contractId)).state?.coordinates.start, start);
});

test("current-branch bind reobserves and asserts the attached branch after Git movement", async () => {
  const repository = repositoryWithHead();
  const git = await repositoryAt(repository.path);
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const tree = repository.run(["rev-parse", `${predecessor}^{tree}`]).trim();
  const moved = repository.run(["commit-tree", tree, "-p", predecessor, "-m", "move current branch"]).trim();
  const marker = join(repository.path, "bind-current-branch-observation.marker");
  const bound = await withGitShim(
    [
      'if [ "$1 $2" = "update-ref --stdin" ] && [ ! -e "$KEIYAKU_BIND_MARKER" ]; then',
      '  : > "$KEIYAKU_BIND_MARKER"',
      '  "$KEIYAKU_REAL_GIT" update-ref refs/heads/main "$KEIYAKU_MOVED_TARGET" "$KEIYAKU_OLD_TARGET" || exit $?',
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
        title: "Moving current branch",
        terms: terms([]),
        targetSelection: { kind: "current-branch" },
        workspace: "worktree",
      }),
  );

  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("moved current-branch bind was not accepted");
  const state = (await observeContract(git, bound.value.contractId)).state;
  assert.equal(state?.coordinates.target, "refs/heads/main");
  assert.equal(state?.coordinates.start, moved);
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

  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("moved targetless bind was not accepted");
  assert.equal(repository.run(["symbolic-ref", "HEAD"]).trim(), "refs/heads/feature");
  assert.equal((await observeContract(git, bound.value.contractId)).state?.coordinates.start, moved);
});

test("runProtocol observes only watched contracts", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const id = (await bound.keiyaku.state()).id;

  const git = await readGit(await repositoryAt(repository.path));
  const malformed = await writeBlob(await repositoryAt(repository.path), "not a journal\n");
  const tree = await updateGitTree(
    await repositoryAt(repository.path),
    git.tree,
    new Map([["contracts/unrelated.jsonl", { oid: malformed }]]),
  );
  const commit = await writeCommit({ repository: await repositoryAt(repository.path), tree, parent: git.commit });
  assert.equal(
    (
      await updateRefsAtomically(await repositoryAt(repository.path), [
        {
          ref: GIT_REF,
          newOid: commit,
          expectedOid: git.commit,
        },
      ])
    ).kind,
    "published",
  );

  const gitOwner = await repositoryAt(repository.path);
  const result = await withGitDecodeChannel(gitOwner, (channel) =>
    runProtocol({
      input: { contractId: id },
      channel,
      repository: gitOwner,
      contracts: [id],
      attempts: [{ entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] }],
      decide: ({ observation }) => {
        assert.deepEqual([...observation.keys()], [id]);
        return { kind: "refused", refusal: "test refusal" };
      },
    }),
  );
  assert.deepEqual(result, { kind: "refused", refusal: "test refusal" });
});

test("contract-local intent ignores an unrelated malformed journal", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const id = (await bound.keiyaku.state()).id;
  const git = await repositoryAt(repository.path);
  await publishMalformedUnrelatedJournal(git);

  const result = await withGitDecodeChannel(git, (channel) =>
    admitIntent(
      channel,
      git,
      {
        contractId: id,
        at: "2026-08-06T00:00:00Z",
        data: { title: "Observation", objective: "Observe one journal", brief: "Keep the intent local." },
      },
      decideArc,
    ),
  );

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("arc was not accepted");
  assert.deepEqual(
    result.facts.map((entry) => entry.kind),
    ["arc"],
  );
});

function terms(after: readonly ContractId[]) {
  return {
    document: { bytes: "# Targeted\n", key: documentKey("targeted") },
    segments: [],
    gates: [],
    after,
  } as const;
}

test("Git journal depth is independent of contract identity length", () => {
  const short = contractJournalPath(contractId("kei/alpha"));
  const long = contractJournalPath(contractId(`kei/${"可读".repeat(1_000)}`));

  assert.match(short, /^contracts\/active\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{60}\.jsonl$/);
  assert.match(long, /^contracts\/active\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{60}\.jsonl$/);
  assert.notEqual(long, short);
});

test("placement claims only the selected contract", async () => {
  const repository = repositoryWithHead();
  const git = await repositoryAt(repository.path);
  const source = await bindOperation({ scope: git, terms: terms([]), workspace: "worktree" });
  assert.equal(source.kind, "accepted");
  if (source.kind !== "accepted") throw new Error("source bind was not accepted");
  const dependent = await bindOperation({
    scope: git,
    terms: terms([source.value.contractId]),
    workspace: "worktree",
  });
  assert.equal(dependent.kind, "accepted");
  if (dependent.kind !== "accepted") throw new Error("dependent bind was not accepted");

  const sourceState = (await observeContract(git, source.value.contractId)).state;
  if (sourceState === null) throw new Error("source state was not observed");
  const prepared = await prepareDelivery(git, await preparationCoordinates(git, sourceState), {
    title: "Frozen journal bytes",
    document: DELIVERY_DOCUMENT,
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("source delivery was not prepared");
  const delivered = await withGitDecodeChannel(git, (channel) =>
    admitIntent(
      channel,
      git,
      {
        contractId: source.value.contractId,
        at: "2026-08-07T00:00:00Z",
        preparation: { kind: "prepared", document: sourceState.terms.document.key, data: prepared.data },
      },
      decideDeliver<never>,
    ),
  );
  assert.equal(delivered.kind, "accepted");

  const claimed = await withGitDecodeChannel(git, (channel) =>
    admitPlacement({
      channel,
      repository: git,
      target: sourceState.coordinates.target,
      placement: { contractId: source.value.contractId, at: "2026-08-07T00:00:01Z" },
    }),
  );

  assert.equal(claimed.kind, "accepted");
  if (claimed.kind !== "accepted") throw new Error("placement was not accepted");
  assert.deepEqual(
    claimed.facts.map((entry) => entry.kind),
    ["claimed"],
  );
  assert.equal((await observeContract(git, dependent.value.contractId)).state?.bound, null);
});

test("public reconcile and admission observation retain canonical journal validation", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({
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

test("bind and amend eligibility read only self and their after contracts", async () => {
  const repository = repositoryWithHead();
  const git = await repositoryAt(repository.path);
  const dependency = await bindOperation({
    scope: git,
    terms: terms([]),
    workspace: "worktree",
  });
  assert.equal(dependency.kind, "accepted");
  if (dependency.kind !== "accepted") throw new Error("dependency bind was not accepted");
  const dependencyId = dependency.value.contractId;
  await publishMalformedUnrelatedJournal(git);

  const result = await bindOperation({
    scope: git,
    terms: terms([dependencyId]),
    workspace: "worktree",
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("targeted bind was not accepted");
  assert.deepEqual(
    result.facts.map((entry) => entry.kind),
    ["bind"],
  );
  const resultState = (await observeContract(git, result.value.contractId)).state;
  if (resultState === null) throw new Error("bound contract state was not observed");

  const amended = await amendOperation({
    scope: git,
    contractId: result.value.contractId,
    source: resultState.terms,
    terms: terms([dependencyId]),
  });
  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("targeted amend was not accepted");
  assert.deepEqual(
    amended.facts.map((entry) => entry.kind),
    ["amend"],
  );
});

test("amend reads the current prerequisite before replacing it", async () => {
  const repository = repositoryWithHead();
  const git = await repositoryAt(repository.path);
  const dependency = await bindOperation({ scope: git, terms: terms([]), workspace: "worktree" });
  assert.equal(dependency.kind, "accepted");
  if (dependency.kind !== "accepted") throw new Error("dependency bind was not accepted");
  const waiting = await bindOperation({
    scope: git,
    terms: terms([dependency.value.contractId]),
    workspace: "worktree",
  });
  assert.equal(waiting.kind, "accepted");
  if (waiting.kind !== "accepted") throw new Error("waiting bind was not accepted");
  const before = (await observeContract(git, waiting.value.contractId)).state;
  if (before === null) throw new Error("waiting contract was not observed");
  const amended = await amendOperation({
    scope: git,
    contractId: waiting.value.contractId,
    source: before.terms,
    terms: terms([]),
  });

  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("replacement amend was not accepted");
  assert.deepEqual(
    amended.facts.map((entry) => entry.kind),
    ["amend"],
  );
});

test("amend refuses a stale complete-terms replacement when document bytes did not move", async () => {
  const repository = repositoryWithHead();
  const git = await repositoryAt(repository.path);
  const bound = await bindOperation({ scope: git, terms: terms([]), workspace: "worktree" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const before = (await observeContract(git, bound.value.contractId)).state;
  if (before === null) throw new Error("contract state was not observed");
  const reviewed = { ...before.terms, gates: [gate("reviewed")] };
  assert.equal(
    (
      await amendOperation({
        scope: git,
        contractId: before.id,
        source: before.terms,
        terms: reviewed,
      })
    ).kind,
    "accepted",
  );

  const stale = await amendOperation({
    scope: git,
    contractId: before.id,
    source: before.terms,
    terms: before.terms,
  });
  assert.deepEqual(stale, {
    kind: "refused",
    refusal: { kind: "terms-moved", contractId: before.id },
  });
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
  assert.equal(bound.kind, "refused");
  if (bound.kind !== "refused") throw new Error("bind must refuse an unresolved prerequisite");
  assert.equal(bound.refusal.kind, "unknown-prerequisite");

  const existing = await bindOperation({
    scope: git,
    terms: terms([]),
    workspace: "worktree",
  });
  assert.equal(existing.kind, "accepted");
  if (existing.kind !== "accepted") throw new Error("existing bind was not accepted");
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

test("amend observes the transitive prerequisite closure before judging cycles", async () => {
  const repository = repositoryWithHead();
  const git = await repositoryAt(repository.path);
  const a = await bindOperation({ scope: git, terms: terms([]), workspace: "worktree", title: "A" });
  assert.equal(a.kind, "accepted");
  if (a.kind !== "accepted") throw new Error("A bind was not accepted");
  const c = await bindOperation({ scope: git, terms: terms([a.value.contractId]), workspace: "worktree", title: "C" });
  assert.equal(c.kind, "accepted");
  if (c.kind !== "accepted") throw new Error("C bind was not accepted");
  const b = await bindOperation({ scope: git, terms: terms([c.value.contractId]), workspace: "worktree", title: "B" });
  assert.equal(b.kind, "accepted");
  if (b.kind !== "accepted") throw new Error("B bind was not accepted");

  const aState = (await observeContract(git, a.value.contractId)).state;
  if (aState === null) throw new Error("A state was not observed");
  const amended = await amendOperation({
    scope: git,
    contractId: a.value.contractId,
    source: aState.terms,
    terms: terms([b.value.contractId]),
  });

  assert.deepEqual(amended, {
    kind: "refused",
    refusal: { kind: "cyclic-prerequisite", contractId: a.value.contractId },
  });
});

test("delivery binds before after and placement reads amended prerequisites", async () => {
  const repository = repositoryWithHead();
  const git = await repositoryAt(repository.path);
  const originalPrerequisite = await bindOperation({ scope: git, terms: terms([]), workspace: "worktree" });
  const replacementPrerequisite = await bindOperation({ scope: git, terms: terms([]), workspace: "worktree" });
  assert.equal(originalPrerequisite.kind, "accepted");
  assert.equal(replacementPrerequisite.kind, "accepted");
  if (originalPrerequisite.kind !== "accepted" || replacementPrerequisite.kind !== "accepted") {
    throw new Error("prerequisite bind was not accepted");
  }
  const dependent = await bindOperation({
    scope: git,
    terms: terms([originalPrerequisite.value.contractId]),
    workspace: "worktree",
  });
  assert.equal(dependent.kind, "accepted");
  if (dependent.kind !== "accepted") throw new Error("dependent bind was not accepted");

  const dependentState = (await observeContract(git, dependent.value.contractId)).state;
  if (dependentState === null) throw new Error("dependent state was not observed");
  const dependentDelivery = await prepareDelivery(git, await preparationCoordinates(git, dependentState), {
    title: "Dependent",
    document: DELIVERY_DOCUMENT,
  });
  assert.equal(dependentDelivery.kind, "prepared");
  if (dependentDelivery.kind !== "prepared") throw new Error("dependent delivery was not prepared");
  const delivered = await withGitDecodeChannel(git, (channel) =>
    admitIntent(
      channel,
      git,
      {
        contractId: dependent.value.contractId,
        at: "2026-08-07T00:00:00Z",
        preparation: {
          kind: "prepared",
          document: dependentState.terms.document.key,
          data: dependentDelivery.data,
        },
      },
      decideDeliver<never>,
    ),
  );
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("dependent delivery was not accepted");
  assert.deepEqual(
    delivered.facts.map((entry) => entry.kind),
    ["bound", "deliver"],
  );

  const waitingPlacement = await withGitDecodeChannel(git, (channel) =>
    admitPlacement({
      channel,
      repository: git,
      target: dependentState.coordinates.target,
      placement: { contractId: dependent.value.contractId, at: "2026-08-07T00:00:01Z" },
    }),
  );
  assert.deepEqual(waitingPlacement, {
    kind: "refused",
    refusal: {
      kind: "prerequisites-unsatisfied",
      contractId: dependent.value.contractId,
      unmet: [{ contractId: originalPrerequisite.value.contractId, state: "active" }],
    },
  });

  const deliveredState = (await observeContract(git, dependent.value.contractId)).state;
  if (deliveredState === null) throw new Error("delivered state was not observed");
  const amended = await amendOperation({
    scope: git,
    contractId: dependent.value.contractId,
    source: deliveredState.terms,
    terms: terms([replacementPrerequisite.value.contractId]),
  });
  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("post-delivery after amendment was not accepted");
  assert.deepEqual(
    amended.facts.map((entry) => entry.kind),
    ["amend"],
  );

  const prerequisiteState = (await observeContract(git, replacementPrerequisite.value.contractId)).state;
  if (prerequisiteState === null) throw new Error("replacement prerequisite state was not observed");
  const prerequisiteDelivery = await prepareDelivery(git, await preparationCoordinates(git, prerequisiteState), {
    title: "Prerequisite",
    document: DELIVERY_DOCUMENT,
  });
  assert.equal(prerequisiteDelivery.kind, "prepared");
  if (prerequisiteDelivery.kind !== "prepared") throw new Error("prerequisite delivery was not prepared");
  const prerequisiteDelivered = await withGitDecodeChannel(git, (channel) =>
    admitIntent(
      channel,
      git,
      {
        contractId: replacementPrerequisite.value.contractId,
        at: "2026-08-07T00:00:02Z",
        preparation: {
          kind: "prepared",
          document: prerequisiteState.terms.document.key,
          data: prerequisiteDelivery.data,
        },
      },
      decideDeliver<never>,
    ),
  );
  assert.equal(prerequisiteDelivered.kind, "accepted");
  const prerequisiteClaimed = await withGitDecodeChannel(git, (channel) =>
    admitPlacement({
      channel,
      repository: git,
      target: prerequisiteState.coordinates.target,
      placement: { contractId: replacementPrerequisite.value.contractId, at: "2026-08-07T00:00:03Z" },
    }),
  );
  assert.equal(prerequisiteClaimed.kind, "accepted");

  const claimed = await withGitDecodeChannel(git, (channel) =>
    admitPlacement({
      channel,
      repository: git,
      target: dependentState.coordinates.target,
      placement: { contractId: dependent.value.contractId, at: "2026-08-07T00:00:04Z" },
    }),
  );
  assert.equal(claimed.kind, "accepted");
  if (claimed.kind !== "accepted") throw new Error("dependent placement was not accepted");
  assert.deepEqual(
    claimed.facts.map((entry) => entry.kind),
    ["claimed"],
  );
  assert.equal((await observeContract(git, originalPrerequisite.value.contractId)).state?.terminal, null);

  const terminalState = (await observeContract(git, dependent.value.contractId)).state;
  if (terminalState === null) throw new Error("terminal dependent state was not observed");
  const lateAmendment = await amendOperation({
    scope: git,
    contractId: dependent.value.contractId,
    source: terminalState.terms,
    terms: terms([]),
  });
  assert.deepEqual(lateAmendment, {
    kind: "refused",
    refusal: { kind: "terminal", contractId: dependent.value.contractId },
  });
});

test("bind and amend leave eligible prerequisites unmaterialized", async () => {
  const repository = repositoryWithHead();
  const activeDependency = await bindOperation({
    scope: await repositoryAt(repository.path),
    terms: terms([]),
    workspace: "worktree",
  });
  assert.equal(activeDependency.kind, "accepted");
  if (activeDependency.kind !== "accepted") throw new Error("active dependency bind was not accepted");
  const waiting = await bindOperation({
    scope: await repositoryAt(repository.path),
    terms: terms([activeDependency.value.contractId]),
    workspace: "worktree",
  });
  assert.equal(waiting.kind, "accepted");
  if (waiting.kind !== "accepted") throw new Error("waiting bind was not accepted");

  const claimedDependency = await bindOperation({
    scope: await repositoryAt(repository.path),
    terms: terms([]),
    workspace: "worktree",
  });
  assert.equal(claimedDependency.kind, "accepted");
  if (claimedDependency.kind !== "accepted") throw new Error("claimable dependency bind was not accepted");
  const git = await repositoryAt(repository.path);
  const state = (
    await withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, observeContractWorld))
  ).contracts.get(claimedDependency.value.contractId)?.state;
  if (state === undefined || state === null) throw new Error("claimable dependency state was not observed");
  const delivery = await prepareDelivery(git, await preparationCoordinates(git, state), {
    title: "Targeted",
    document: DELIVERY_DOCUMENT,
  });
  assert.equal(delivery.kind, "prepared");
  if (delivery.kind !== "prepared") throw new Error("claimable dependency delivery was not prepared");
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
  assert.equal(immediatelyBound.kind, "accepted");
  if (immediatelyBound.kind !== "accepted") throw new Error("claimed prerequisite bind was not accepted");
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
  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("eligible amend was not accepted");
  assert.deepEqual(
    amended.facts.map((entry) => entry.kind),
    ["amend"],
  );
});

test("placement redecides after a world advance without binding a dependent", async () => {
  const repository = repositoryWithHead();
  const source = await bindOperation({
    scope: await repositoryAt(repository.path),
    terms: terms([]),
    workspace: "worktree",
  });
  assert.equal(source.kind, "accepted");
  if (source.kind !== "accepted") throw new Error("source bind was not accepted");

  const git = await repositoryAt(repository.path);
  const sourceState = (await observeContract(git, source.value.contractId)).state;
  if (sourceState === null) throw new Error("source state was not observed");
  const prepared = await prepareDelivery(git, await preparationCoordinates(git, sourceState), {
    title: "Concurrent placement",
    document: DELIVERY_DOCUMENT,
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("source delivery was not prepared");
  const delivered = await withGitDecodeChannel(git, (channel) =>
    admitIntent(
      channel,
      git,
      {
        contractId: source.value.contractId,
        at: "2026-08-06T00:00:00Z",
        preparation: { kind: "prepared", document: sourceState.terms.document.key, data: prepared.data },
      },
      decideDeliver<never>,
    ),
  );
  assert.equal(delivered.kind, "accepted");

  const dependent = contractId("kei/concurrent-dependent");
  const waitingEntry: JournalEntry = {
    v: 1,
    kind: "bind",
    contract: dependent,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
    at: "2026-08-06T00:00:01Z",
    data: {
      coordinates: { start: sourceState.coordinates.start, workspace: "worktree" },
      terms: terms([source.value.contractId]),
    },
  };
  const marker = join(repository.path, ".concurrent-bind-once");
  const dependentJournal = encodeEntry(waitingEntry);
  const shim = [
    'if [ "$1" = "update-ref" ] && [ ! -e "$KEIYAKU_RACE_MARKER" ]; then',
    '  touch "$KEIYAKU_RACE_MARKER"',
    '  current=$("$KEIYAKU_REAL_GIT" rev-parse refs/heads/keiyaku-state)',
    '  tree=$("$KEIYAKU_REAL_GIT" rev-parse "$current^{tree}")',
    '  blob=$(printf "%s" "$KEIYAKU_RACE_JOURNAL" | "$KEIYAKU_REAL_GIT" hash-object -w --stdin)',
    "  index=$(mktemp)",
    '  GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" read-tree "$tree"',
    `  printf "100644 blob %s\\t${contractJournalPath(dependent)}\\n" "$blob" | GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" update-index --index-info`,
    '  next_tree=$(GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" write-tree)',
    '  next_commit=$("$KEIYAKU_REAL_GIT" commit-tree "$next_tree" -p "$current" < /dev/null)',
    '  "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$next_commit" "$current"',
    '  rm -f "$index"',
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");

  const claimed = await withGitShim(
    shim,
    { KEIYAKU_RACE_MARKER: marker, KEIYAKU_RACE_JOURNAL: dependentJournal },
    async (gitPath) => {
      const scoped = await productionRepositoryAt(repository.path, gitPath);
      return withGitDecodeChannel(scoped, (channel) =>
        admitPlacement({
          channel,
          repository: scoped,
          target: sourceState.coordinates.target,
          placement: { contractId: source.value.contractId, at: "2026-08-06T00:00:02Z" },
        }),
      );
    },
  );
  assert.equal(claimed.kind, "accepted");
  if (claimed.kind !== "accepted") throw new Error("placement was not accepted after redecision");
  assert.deepEqual(
    claimed.facts.map((fact) => fact.kind),
    ["claimed"],
  );
  assert.equal((await observeContract(git, source.value.contractId)).state?.terminal?.kind, "claimed");
  assert.equal((await observeContract(git, dependent)).state?.bound, null);
});

test("delivery preparation ignores an unrelated malformed journal", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const id = (await bound.keiyaku.state()).id;
  const git = await repositoryAt(repository.path);
  await publishMalformedUnrelatedJournal(git);

  const state = (await observeContract(git, id)).state;
  if (state === null) throw new Error("bound contract state was not observed");
  assert.equal(
    (
      await prepareDelivery(git, await preparationCoordinates(git, state), {
        title: "Observation",
        document: DELIVERY_DOCUMENT,
      })
    ).kind,
    "prepared",
  );
});
