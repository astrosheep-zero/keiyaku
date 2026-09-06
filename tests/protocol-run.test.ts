import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { decodeContractDocument } from "../src/body/decode.js";
import { decideArc } from "../src/core/verbs/arc.js";
import { entryUlid } from "../src/core/facts/types.js";
import { GIT_REF, readGit, updateRefsAtomically, writeCommit } from "../src/git/repository.js";
import { withPrivateStatePublicationSeat } from "../src/git/private-state-seat.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { documentDerivation } from "../src/library/input.js";
import { admitDeliveryOperation } from "../src/protocol/deliver.js";
import { admitReviewOperation } from "../src/protocol/review.js";
import { STALE_PRIVATE_STATE_PREPARATION, runProtocol } from "../src/protocol/run.js";
import { Keiyaku } from "../src/index.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  makeGitRepository,
  snapshotGitRepository,
} from "./support/git.js";

const ARC = {
  title: "Observation",
  objective: "Keep protocol custody on a fresh private root",
  brief: "Speculative preparation must revalidate before admission.",
} as const;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function repositoryWithHead() {
  const template = makeGitRepository();
  template.run(["config", "user.name", "Test User"]);
  template.run(["config", "user.email", "test@example.com"]);
  template.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return snapshotGitRepository(template);
}

function contractBody(): string {
  return [
    "# Protocol run seat",
    "",
    "## Context",
    "Exercise speculative private-state preparation.",
    "",
    "## Objective",
    "Keep admission on a matching private-root observation.",
    "",
    "## Design",
    "Bind one Contract and admit an arc.",
    "",
    "## Region",
    "~~~",
    "src/protocol/**",
    "~~~",
    "",
    "## Criteria",
    "### Custody",
    "Stale preparation does not write.",
  ].join("\n");
}

test("slow protocol preparation does not serialize an unrelated admission", async () => {
  const repository = repositoryWithHead();
  const first = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const firstId = (await first.keiyaku.state()).id;
  let releasePreparation: (() => void) | undefined;
  const preparationHeld = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  let enteredPreparation = false;
  const git = await cachedRepositoryAt(repository.path);
  const slow = withGitDecodeChannel(git, (channel) =>
    runProtocol({
      input: {
        contractId: firstId,
        at: "2026-09-02T00:00:00Z",
        data: ARC,
      },
      channel,
      repository: git,
      contracts: [firstId],
      attempts: [{ entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] }],
      decide: decideArc,
      prepareInput: async (_observation, input) => {
        enteredPreparation = true;
        await preparationHeld;
        return { kind: "prepared", input };
      },
    }),
  );
  while (!enteredPreparation) await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: `${contractBody()}\n`,
    workspace: "worktree",
  });
  assert.equal(second.kind, "accepted");
  releasePreparation?.();
  const result = await slow;
  assert.equal(result.kind, "publication-failed");
});

test("stale protocol preparation retries without admission or a partial write", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const id = (await bound.keiyaku.state()).id;
  const git = await cachedRepositoryAt(repository.path);
  const before = repository.run(["rev-parse", GIT_REF]).trim();
  const hold = deferred();
  const acquired = deferred();
  const holder = withPrivateStatePublicationSeat(git, async () => {
    acquired.resolve();
    await hold.promise;
  });
  await acquired.promise;
  let prepared = false;
  const waiting = deferred();
  const waitingGit = { ...git, onPrivateStateSeatContention: waiting.resolve };
  const resultPromise = withGitDecodeChannel(waitingGit, (channel) =>
    runProtocol({
      input: {
        contractId: id,
        at: "2026-09-02T00:00:00Z",
        data: ARC,
      },
      channel,
      repository: waitingGit,
      contracts: [id],
      attempts: [{ entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] }],
      decide: decideArc,
      prepareInput: async (_observation, input) => {
        prepared = true;
        return { kind: "prepared", input };
      },
    }),
  );
  while (!prepared) await new Promise((resolve) => setTimeout(resolve, 10));
  await waiting.promise;
  const snapshot = await readGit(git);
  if (snapshot.commit === null || snapshot.tree === null) throw new Error("private root is missing");
  const commit = await writeCommit({ repository: git, tree: snapshot.tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );
  hold.resolve();
  await holder;
  const result = await resultPromise;
  assert.deepEqual(result, STALE_PRIVATE_STATE_PREPARATION);
  assert.equal(repository.run(["rev-parse", GIT_REF]).trim(), commit);
  assert.notEqual(commit, before);
  assert.equal(
    (await bound.keiyaku.history()).events.some((event) => event.source === "journal" && event.fact.kind === "arc"),
    false,
  );
});

test("stale delivery worktree inputs retry without admission or a partial write", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const id = (await bound.keiyaku.state()).id;
  const git = await cachedRepositoryAt(repository.path);
  const worktree = await appointedWorktreePath(git, id);
  const before = repository.run(["rev-parse", GIT_REF]).trim();
  const hold = deferred();
  const acquired = deferred();
  const holder = withPrivateStatePublicationSeat(git, async () => {
    acquired.resolve();
    await hold.promise;
  });
  await acquired.promise;
  const waiting = deferred();
  const waitingGit = { ...git, onPrivateStateSeatContention: waiting.resolve };
  const resultPromise = withGitDecodeChannel(waitingGit, (channel) =>
    admitDeliveryOperation({
      scope: waitingGit,
      channel,
      contractId: id,
      deriveDocument: (state) =>
        documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id),
      requireBranchesToBeUpToDate: false,
      includeDirty: true,
      materializeConflict: false,
    }),
  );
  await waiting.promise;
  writeFileSync(join(worktree, "candidate.txt"), "changed worktree\n");
  hold.resolve();
  await holder;
  const result = await resultPromise;
  assert.equal(result.kind, "retry");
  if (result.kind !== "retry") throw new Error("expected stale delivery retry");
  assert.deepEqual(result.reason, STALE_PRIVATE_STATE_PREPARATION);
  assert.equal(repository.run(["rev-parse", GIT_REF]).trim(), before);
  assert.equal(
    (await bound.keiyaku.history()).events.some((event) => event.source === "journal" && event.fact.kind === "deliver"),
    false,
  );
});

test("stale review worktree inputs retry without admission or a partial write", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const id = (await bound.keiyaku.state()).id;
  const git = await cachedRepositoryAt(repository.path);
  const worktree = await appointedWorktreePath(git, id);
  const before = repository.run(["rev-parse", GIT_REF]).trim();
  const hold = deferred();
  const acquired = deferred();
  const holder = withPrivateStatePublicationSeat(git, async () => {
    acquired.resolve();
    await hold.promise;
  });
  await acquired.promise;
  const waiting = deferred();
  const waitingGit = { ...git, onPrivateStateSeatContention: waiting.resolve };
  const resultPromise = withGitDecodeChannel(waitingGit, (channel) =>
    admitReviewOperation({
      scope: waitingGit,
      channel,
      contractId: id,
      verdict: "unsatisfied",
      summary: "stale worktree",
    }),
  );
  await waiting.promise;
  writeFileSync(join(worktree, "candidate.txt"), "changed worktree\n");
  hold.resolve();
  await holder;
  const result = await resultPromise;
  assert.equal(result.kind, "retry");
  if (result.kind !== "retry") throw new Error("expected stale review retry");
  assert.deepEqual(result.reason, STALE_PRIVATE_STATE_PREPARATION);
  assert.equal(repository.run(["rev-parse", GIT_REF]).trim(), before);
  assert.equal(
    (await bound.keiyaku.history()).events.some(
      (event) => event.source === "journal" && event.fact.kind === "attestation",
    ),
    false,
  );
});

test("private-state seat contention projects as a publication-failed retry", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const id = (await bound.keiyaku.state()).id;
  const git = await cachedRepositoryAt(repository.path);
  const before = repository.run(["rev-parse", GIT_REF]).trim();
  let releaseHolder: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let holding: (() => void) | undefined;
  const acquired = new Promise<void>((resolve) => {
    holding = resolve;
  });
  const holder = withPrivateStatePublicationSeat(git, async () => {
    holding?.();
    await hold;
  });
  await acquired;
  const result = await withGitDecodeChannel(git, (channel) =>
    runProtocol({
      input: {
        contractId: id,
        at: "2026-09-02T00:00:00Z",
        data: ARC,
      },
      channel,
      repository: git,
      contracts: [id],
      attempts: [{ entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] }],
      decide: decideArc,
    }),
  );
  releaseHolder?.();
  await holder;
  assert.equal(result.kind, "publication-failed");
  if (result.kind !== "publication-failed") throw new Error("expected publication-failed contention");
  assert.match(result.diagnostic, /timed out/u);
  assert.equal(repository.run(["rev-parse", GIT_REF]).trim(), before);
});
