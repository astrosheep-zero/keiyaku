import { captureWorktreeFiles, restoreWorktreeFiles, type WorktreeFixtureFile } from "./support/git.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { describe } from "node:test";
import { encodeEntry } from "../src/core/facts/codec.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { changeId, contractId, entryUlid, snapshotId, type ContractId } from "../src/core/facts/types.js";
import { contractJournalPath } from "../src/git/identity.js";
import { GIT_REF, readBlob, readGit, readRef, updateGitTree, writeBlob, writeCommit } from "../src/git/repository.js";
import { acquireTargetPlacementFence } from "../src/git/target-placement.js";
import { Keiyaku, Repo, type IntegrationConflictMaterialized, type MutationResult } from "../src/index.js";
import type { ContinuationStop } from "../src/library/continuation.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  snapshotGitRepository,
  withGitShim,
} from "./support/git.js";
import {
  bind,
  commitCandidate,
  document,
  refused,
  repositoryWithMain,
} from "./support/library-verbs.js";
import { waitForFixtureFile } from "./support/process.js";

type ContractHandle = Pick<Keiyaku, "state">;

async function publicContractId(handle: ContractHandle): Promise<ContractId> {
  return (await handle.state()).id;
}

function expectMutation<Value>(result: MutationResult<Value> | IntegrationConflictMaterialized): MutationResult<Value> {
  if (result.kind !== "accepted") throw new Error("expected an admitted mutation result");
  return result;
}

function placementRefusalKind(placement: ContinuationStop | undefined): string | undefined {
  return placement !== undefined && "refusal" in placement ? placement.refusal.kind : undefined;
}

type DefaultPostBindTemplate = Readonly<{
  repository: ReturnType<typeof repositoryWithMain>;
  id: ReturnType<typeof contractId>;
  start: ReturnType<typeof snapshotId>;
  generatedFiles: readonly WorktreeFixtureFile[];
}>;

let defaultPostBindTemplate: Promise<DefaultPostBindTemplate> | undefined;

async function buildDefaultPostBindTemplate(): Promise<DefaultPostBindTemplate> {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const state = await contract.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  const generatedFiles = captureWorktreeFiles(worktree);
  repository.run(["worktree", "remove", "--force", worktree]);
  return { repository, id: state.id, start: state.coordinates.start, generatedFiles };
}

async function defaultBoundFixture() {
  const templatePromise = (defaultPostBindTemplate ??= buildDefaultPostBindTemplate());
  let template: DefaultPostBindTemplate;
  try {
    template = await templatePromise;
  } catch (error) {
    if (defaultPostBindTemplate === templatePromise) defaultPostBindTemplate = undefined;
    throw error;
  }
  const repository = snapshotGitRepository(template.repository);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), template.id);
  repository.run(["worktree", "add", "--detach", worktree, template.start]);
  restoreWorktreeFiles(worktree, template.generatedFiles);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keiyaku.of({ repo, id: template.id });
  return { repository, repo, contract, worktree };
}

async function bindRetained(
  repo: Repo,
  title: string,
  after: readonly ReturnType<typeof contractId>[] = [],
  reviewed = false,
  verification?: string,
) {
  return await Keiyaku.bind({
    repo,
    markdown: document(verification).replace("# Library verbs", `# ${title}`),
    workspace: "worktree",
    gates: reviewed ? ["reviewed"] : [],
    ...(after.length === 0 ? {} : { after }),
  });
}

async function retainedVerifiedCandidate(
  repository: ReturnType<typeof repositoryWithMain>,
  title: string,
  verification = "true",
) {
  const bound = await bindRetained(await cachedRepoAt(repository.path), title, [], true, verification);
  const contract = bound.keiyaku;
  const worktree = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    await publicContractId(contract),
  );
  commitCandidate(repository, worktree);
  return { contract, worktree };
}

async function cancelDuringVerification<Value>(
  marker: string,
  run: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  rmSync(marker, { force: true });
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (existsSync(marker)) controller.abort();
  }, 1);
  try {
    return await run(controller.signal);
  } finally {
    clearInterval(timer);
  }
}

function blockingVerification(marker: string): string {
  return `${process.execPath} -e ${JSON.stringify(
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); setTimeout(() => {}, 30000);`,
  )}`;
}

async function plantDispatch(
  repository: ReturnType<typeof repositoryWithMain>,
  akuId: string,
  owner: string,
  dispatchedAt: string,
  bytes?: Buffer,
): Promise<void> {
  const git = await cachedRepositoryAt(repository.path);
  const path = `dispatch/${createHash("sha256").update(akuId).digest("hex")}.json`;
  const payload =
    bytes ??
    Buffer.from(
      `${JSON.stringify({
        akuId,
        contractId: owner,
        dispatchedAt,
      })}\n`,
    );
  const before = await readGit(git);
  const tree = await updateGitTree(git, before.tree, new Map([[path, { oid: await writeBlob(git, payload) }]]));
  const commit = await writeCommit({
    repository: git,
    tree,
    parent: before.commit,
    message: `dispatch ${akuId}`,
    at: dispatchedAt,
  });
  repository.run(["update-ref", GIT_REF, commit, before.commit ?? ""]);
}

function changeIdFromSubject(subject: string | undefined): string | undefined {
  return (JSON.parse(subject ?? "[]") as readonly (readonly [string, string])[]).find(
    ([kind]) => kind === "change",
  )?.[1];
}

type ReviewGatedConflictCandidateTemplate = Readonly<{
  repository: ReturnType<typeof repositoryWithMain>;
  id: ReturnType<typeof contractId>;
  targetHead: ReturnType<typeof snapshotId>;
  candidateHead: ReturnType<typeof snapshotId>;
  generatedFiles: readonly WorktreeFixtureFile[];
}>;

let reviewGatedConflictCandidateTemplate: Promise<ReviewGatedConflictCandidateTemplate> | undefined;

async function buildReviewGatedConflictCandidateTemplate(): Promise<ReviewGatedConflictCandidateTemplate> {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "a.txt"), "base\n");
  writeFileSync(join(repository.path, "z.txt"), "base\n");
  repository.run(["add", "a.txt", "z.txt"]);
  repository.run(["commit", "--quiet", "-m", "base"]);
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["reviewed"],
  });
  const boundId = await publicContractId(bound.keiyaku);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), boundId);
  writeFileSync(join(repository.path, "a.txt"), "target\n");
  writeFileSync(join(repository.path, "z.txt"), "target\n");
  repository.run(["add", "a.txt", "z.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = repository.run(["rev-parse", "refs/heads/main"]).trim();
  writeFileSync(join(worktree, "a.txt"), "tender\n");
  writeFileSync(join(worktree, "z.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  const candidateHead = snapshotId(repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim());
  const generatedFiles = captureWorktreeFiles(worktree);
  repository.run(["worktree", "remove", "--force", worktree]);
  return { repository, id: boundId, targetHead: snapshotId(targetHead), candidateHead, generatedFiles };
}

async function reviewGatedConflictCandidateFixture() {
  const templatePromise = (reviewGatedConflictCandidateTemplate ??= buildReviewGatedConflictCandidateTemplate());
  let template: ReviewGatedConflictCandidateTemplate;
  try {
    template = await templatePromise;
  } catch (error) {
    if (reviewGatedConflictCandidateTemplate === templatePromise) reviewGatedConflictCandidateTemplate = undefined;
    throw error;
  }
  const repository = snapshotGitRepository(template.repository);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), template.id);
  repository.run(["worktree", "add", "--detach", worktree, template.candidateHead]);
  restoreWorktreeFiles(worktree, template.generatedFiles);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keiyaku.of({ repo, id: template.id });
  return { repository, repo, contract, targetHead: template.targetHead, worktree };
}

const DELIVER_CONFLICT_RECOVERY = {
  materialize: "deliver --materialize-conflict --include-dirty",
  deliver: "deliver --include-dirty",
  staging: "not-required",
} as const;

function mergeHead(repository: ReturnType<typeof repositoryWithMain>, worktree: string): string | null {
  try {
    return repository.run(["-C", worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"]).trim();
  } catch {
    return null;
  }
}

async function interruptStartedDelivery(contract: Keiyaku, marker: string) {
  const controller = new AbortController();
  const pending = contract.deliver({ includeDirty: true, signal: controller.signal });
  try {
    await Promise.race([
      waitForFixtureFile(marker),
      pending.then(() => {
        throw new Error("delivery completed before verification-start evidence");
      }),
    ]);
  } catch (error) {
    controller.abort();
    await pending.catch(() => undefined);
    throw error;
  }
  controller.abort();
  return await pending;
}

// Each case owns a separate repository and scoped fault injection, never a process-wide mock.
describe("library-contract-operations isolated repositories", { concurrency: 4 }, () => {

  test("plain deliver conflict is an executable handoff and does not mutate", async () => {
    const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
    const git = await cachedRepositoryAt(repository.path);
    const journal = await readRef(git, GIT_REF);
    await assert.rejects(
      () => contract.deliver(),
      refused({
        kind: "integration-failed",
        contractId: await publicContractId(contract),
        reason: "conflict",
        targetHead,
        conflictPaths: ["a.txt", "z.txt"],
        recovery: DELIVER_CONFLICT_RECOVERY,
      }),
    );
    const state = await contract.state();
    assert.equal(state.delivery, null);
    assert.equal(state.terminal, null);
    assert.equal(await readRef(git, GIT_REF), journal);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetHead);
    assert.equal(mergeHead(repository, worktree), null);
  });

  test("repo reconcile returns a typed discovery failure without a synthetic ContractId", async () => {
    const repository = repositoryWithMain();
    const bound = await bind(repository);
    const id = (await bound.state()).id;
    const report = await withGitShim(
      [
        `if [ "$*" = "rev-parse --verify --quiet ${GIT_REF}" ]; then`,
        '  printf "forced world observation failure\\n" >&2',
        "  exit 128",
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      {},
      async (gitPath) => (await Repo.at({ path: repository.path, gitPath })).reconcile(),
    );
    assert.ok(report.kind === "world-observation-failed", "expected report.kind = \"world-observation-failed\"");
    assert.equal("contracts" in report, false);
    assert.equal(report.diagnostic.includes(id), false);
    assert.match(report.diagnostic, /forced world observation failure/u);
  });

  test("repo reconcile still throws authority corruption during world discovery", async () => {
    const { repository, contract: bound } = await defaultBoundFixture();
    const id = (await bound.state()).id;
    const git = await cachedRepositoryAt(repository.path);
    const before = await readGit(git);
    const journal = before.paths.get(contractJournalPath(id));
    if (journal?.type !== "blob") throw new Error("missing journal");
    const tree = await updateGitTree(
      git,
      before.tree,
      new Map([[contractJournalPath(id), { oid: await writeBlob(git, Buffer.from("not-a-journal\n")) }]]),
    );
    const commit = await writeCommit({ repository: git, tree, parent: before.commit, message: "corrupt journal" });
    if (before.commit === null) throw new Error("missing state ref");
    repository.run(["update-ref", GIT_REF, commit, before.commit]);
    await assert.rejects(
      () => cachedRepoAt(repository.path).then((repo) => repo.reconcile()),
      (error: unknown) => error instanceof AuthorityCorruptionError,
    );
  });

  test("an unrecorded candidate reuses its admitted delivery despite changed captured content", async () => {
    const repository = repositoryWithMain();
    const marker = join(repository.path, "verification-started");
    const script = `${process.execPath} -e ${JSON.stringify(
      `const fs=require("node:fs"); const p=${JSON.stringify(marker)}; if (!fs.existsSync(p)) { fs.writeFileSync(p, "started"); setTimeout(() => {}, 30000); }`,
    )}`;
    const contract = await bind(repository, script);
    const worktree = await appointedWorktreePath(
      await cachedRepositoryAt(repository.path),
      await publicContractId(contract),
    );
    writeFileSync(join(worktree, "candidate.txt"), "first\n");
    await interruptStartedDelivery(contract, marker);
    const first = await contract.state();
    const firstEntry = first.delivery?.entry;
    const firstChangeId = first.delivery?.data.integration.changeId;
    assert.ok(firstEntry);
    assert.ok(firstChangeId);
    writeFileSync(join(worktree, "candidate.txt"), "changed\n");
    const resumed = expectMutation(await contract.deliver({ includeDirty: true }));
    assert.deepEqual(
      resumed.facts.map((fact) => fact.kind),
      ["attestation", "claimed"],
    );
    const finalState = await contract.state();
    assert.equal(finalState.delivery?.entry, firstEntry);
    assert.equal(finalState.delivery?.data.integration.changeId, firstChangeId);
    assert.equal(finalState.terminal?.kind, "claimed");
  });

  test("redelivery recovers an unrecorded candidate without capturing later dirty work", async () => {
    const repository = repositoryWithMain();
    const marker = join(repository.path, "verification-started");
    const verification = blockingVerification(marker);
    const { contract, worktree } = await retainedVerifiedCandidate(repository, "Interrupted", verification);
    const first = expectMutation(
      await cancelDuringVerification(marker, async (signal) => await contract.deliver({ signal })),
    );
    const delivery = first.facts.find((fact) => fact.kind === "deliver");
    assert.ok(delivery);
    assert.equal(first.value.verification && "failure" in first.value.verification, true);

    writeFileSync(join(worktree, "later.txt"), "not part of the admitted candidate\n");
    const recovered = await withGitShim(
      [
        'if [ "$1" = "commit-tree" ]; then printf "unexpected recapture\\n" >&2; exit 97; fi',
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      {},
      async (gitPath) => {
        const routed = Keiyaku.of({
          repo: await Repo.at({ path: repository.path, gitPath }),
          id: await publicContractId(contract),
        });
        return expectMutation(
          await cancelDuringVerification(marker, async (signal) => await routed.deliver({ includeDirty: true, signal })),
        );
      },
    );
    assert.deepEqual(recovered.facts, []);
    assert.deepEqual(recovered.value.leading, { kind: "already-admitted", fact: delivery!.entry });
    assert.deepEqual(recovered.value.integration, first.value.integration);

    const audited = await cancelDuringVerification(marker, (signal) => contract.audit({ includeDirty: true, signal }));
    assert.equal(audited.value.delivery?.relation, "differs");
    assert.equal(audited.value.delivery?.verification.kind, "unrecorded");

    const overwritten = expectMutation(
      await cancelDuringVerification(
        marker,
        async (signal) => await contract.deliver({ includeDirty: true, overwrite: true, signal }),
      ),
    );
    assert.equal(overwritten.value.leading, undefined);
    assert.notDeepEqual(overwritten.value.integration, first.value.integration);
    assert.equal(overwritten.facts.filter((fact) => fact.kind === "deliver").length, 1);
  });

  test("terminal Verification lets changed captured content replace the candidate", async () => {
    const repository = repositoryWithMain();
    const { contract, worktree } = await retainedVerifiedCandidate(repository, "Terminal");
    const first = expectMutation(await contract.deliver());
    writeFileSync(join(worktree, "next.txt"), "replacement\n");
    repository.run(["-C", worktree, "add", "next.txt"]);
    repository.run(["-C", worktree, "commit", "--quiet", "-m", "replacement"]);
    const second = expectMutation(await contract.deliver());
    assert.equal(second.value.leading, undefined);
    assert.notDeepEqual(second.value.integration, first.value.integration);
    assert.equal(
      (await contract.history()).events.filter((event) => event.source === "journal" && event.fact.kind === "deliver")
        .length,
      2,
    );
  });

  test("delivery terminal refusal outranks a missing managed worktree", async () => {
    const repository = repositoryWithMain();
    const prerequisite = await bind(repository);
    const prerequisiteId = (await prerequisite.state()).id;
    const dependent = await Keiyaku.bind({
      repo: await cachedRepoAt(repository.path),
      markdown: document(),
      workspace: "worktree",
      gates: ["reviewed"],
      after: [prerequisiteId],
    });
    assert.equal((await dependent.keiyaku.state()).bound, null);
    const dependentId = (await dependent.keiyaku.state()).id;
    const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), dependentId);
    await dependent.keiyaku.abandon();
    assert.equal(existsSync(path), false);

    const terminalContractId = (await dependent.keiyaku.state()).id;
    await assert.rejects(
      () => dependent.keiyaku.deliver(),
      refused({ kind: "terminal", contractId: terminalContractId }),
    );
  });

  test("a stopped continuation does not block an eligible sibling", async () => {
    const repository = repositoryWithMain();
    const repo = await cachedRepoAt(repository.path);
    const prerequisite = await bindRetained(repo, "Prerequisite");
    const prerequisiteId = await publicContractId(prerequisite.keiyaku);
    const blocked = await bindRetained(repo, "Blocked dependent", [prerequisiteId], true);
    const eligible = await bindRetained(repo, "Eligible dependent", [prerequisiteId]);
    await blocked.keiyaku.deliver();
    await eligible.keiyaku.deliver();
    const delivered = expectMutation(await prerequisite.keiyaku.deliver());
    const blockedId = await publicContractId(blocked.keiyaku);
    const eligibleId = await publicContractId(eligible.keiyaku);

    assert.deepEqual(delivered.value.continuation?.claimed, [eligibleId]);
    const stopped = delivered.value.continuation?.stopped;
    assert.equal(stopped?.length, 1);
    const blockedStop = stopped?.[0];
    assert.equal(blockedStop?.contractId, blockedId);
    assert.equal(
      blockedStop !== undefined && "refusal" in blockedStop.stop ? blockedStop.stop.refusal.kind : undefined,
      "gates-unsatisfied",
    );
    if (
      blockedStop === undefined ||
      !("refusal" in blockedStop.stop) ||
      blockedStop.stop.refusal.kind !== "gates-unsatisfied"
    )
      return;
    assert.deepEqual(blockedStop.stop.refusal.unmet, [{ gate: "reviewed", current: { kind: "missing" } }]);
    assert.equal((await prerequisite.keiyaku.state()).terminal?.kind, "claimed");
    assert.equal((await eligible.keiyaku.state()).terminal?.kind, "claimed");
    assert.equal((await blocked.keiyaku.state()).terminal, null);
  });

  test("a satisfied review waits on the target-placement fence before reporting delivery-missing", async () => {
    const { repository, contract } = await reviewGatedConflictCandidateFixture();
    const held = await acquireTargetPlacementFence(await cachedRepositoryAt(repository.path), "refs/heads/main");
    const pending = contract.review({ verdict: "satisfied" });
    const raced = await Promise.race([
      pending.then(() => "finished" as const),
      new Promise<"blocked">((resolve) => {
        setTimeout(() => resolve("blocked"), 150);
      }),
    ]);
    assert.equal(raced, "blocked");
    held.close();
    const reviewed = await pending;
    assert.deepEqual(
      reviewed.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    assert.equal(placementRefusalKind(reviewed.value.placement), "delivery-missing");
  });

  test("a satisfied review cannot interleave a stale integration stop across the target fence", async () => {
    const { repository, contract, targetHead } = await reviewGatedConflictCandidateFixture();
    const git = await cachedRepositoryAt(repository.path);
    const held = await acquireTargetPlacementFence(git, "refs/heads/main");
    const pending = contract.review({ verdict: "satisfied" });
    const deadline = Date.now() + 2000;
    let state = await contract.state();
    while (state.attestations.at(-1)?.data.verdict !== "satisfied" && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      state = await contract.state();
    }
    assert.equal(state.attestations.at(-1)?.data.verdict, "satisfied");
    assert.equal(state.delivery, null);
    const reviewedChangeId = changeIdFromSubject(state.attestations.at(-1)?.data.subject);
    if (reviewedChangeId === undefined) throw new Error("reviewed subject is missing its ChangeId");
    const before = await readGit(git);
    const journalPath = contractJournalPath(state.id);
    const active = before.paths.get(journalPath);
    if (active?.type !== "blob") throw new Error("missing active journal");
    const oid = await writeBlob(
      git,
      Buffer.concat([
        await readBlob(git, active.oid),
        Buffer.from(
          encodeEntry({
            v: 1,
            kind: "bound",
            contract: state.id,
            entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBW"),
            at: "2026-08-17T00:00:00.000Z",
            data: {},
          }),
        ),
        Buffer.from(
          encodeEntry({
            v: 1,
            kind: "deliver",
            contract: state.id,
            entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBX"),
            at: "2026-08-17T00:00:01.000Z",
            data: {
              tenderSnapshot: snapshotId(targetHead),
              integration: {
                predecessor: snapshotId(targetHead),
                snapshot: snapshotId(targetHead),
                changeId: changeId(reviewedChangeId),
              },
              method: "squash",
              policy: { requireBranchesToBeUpToDate: false },
            },
          }),
        ),
      ]),
    );
    const tree = await updateGitTree(git, before.tree, new Map([[journalPath, { oid }]]));
    const commit = await writeCommit({ repository: git, tree, parent: before.commit });
    if (before.commit === null) throw new Error("missing state ref");
    repository.run(["update-ref", "refs/heads/keiyaku-state", commit, before.commit]);
    writeFileSync(join(repository.path, "unrelated-target.txt"), "moved\n");
    repository.run(["add", "unrelated-target.txt"]);
    repository.run(["commit", "--quiet", "-m", "move target under fence"]);
    const stillHeld = await Promise.race([
      pending.then(() => "finished" as const),
      new Promise<"blocked">((resolve) => {
        setTimeout(() => resolve("blocked"), 50);
      }),
    ]);
    assert.equal(stillHeld, "blocked");
    held.close();
    const reviewed = await pending;
    assert.deepEqual(
      reviewed.facts.map((fact) => fact.kind),
      ["attestation", "reintegrated", "claimed"],
    );
    assert.equal(reviewed.value.placement, undefined);
    const finalState = await contract.state();
    assert.equal(finalState.terminal?.kind, "claimed");
    assert.equal(finalState.currentIntegration?.snapshot, repository.run(["rev-parse", "refs/heads/main"]).trim());
  });

  test("a whitespace-only worktree change stales prior review testimony", async () => {
    const { repository, contract } = await defaultBoundFixture();
    const worktree = await appointedWorktreePath(
      await cachedRepositoryAt(repository.path),
      await publicContractId(contract),
    );
    writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
    const reviewed = await contract.review({ verdict: "satisfied" });
    const reviewedChangeId = changeIdFromSubject((await contract.state()).attestations.at(-1)?.data.subject);
    writeFileSync(join(worktree, "candidate.txt"), "candidate \n");

    const delivered = expectMutation(await contract.deliver({ includeDirty: true }));
    assert.equal(placementRefusalKind(reviewed.value.placement), "delivery-missing");
    assert.notEqual(delivered.value.integration.changeId, reviewedChangeId);
    assert.deepEqual(
      delivered.facts.map((fact) => fact.kind),
      ["bound", "deliver"],
    );
    assert.equal(placementRefusalKind(delivered.value.placement), "gates-unsatisfied");
    assert.equal((await contract.state()).terminal, null);
  });

  test("contract history composes one frozen journal and Dispatch observation", async () => {
    const repository = repositoryWithMain();
    const first = await bind(repository);
    const firstId = (await first.state()).id;
    const other = await Keiyaku.bind({
      repo: await cachedRepoAt(repository.path),
      markdown: document().replace("# Library verbs", "# Other contract"),
      workspace: "worktree",
    });
    const otherId = (await other.keiyaku.state()).id;
    const observedBind = (await first.history()).events.find(
      (event) => event.source === "journal" && event.fact.kind === "bind",
    );
    if (observedBind === undefined || observedBind.source !== "journal") throw new Error("missing bind fact");
    const bindTime = observedBind.fact.at;
    await plantDispatch(repository, "aku/worker/bbbbbbbb", firstId, bindTime);
    await plantDispatch(repository, "aku/worker/aaaaaaaa", firstId, bindTime);
    await plantDispatch(repository, "aku/reviewer/cccccccc", firstId, "2099-01-01T00:00:00.000Z");
    await plantDispatch(repository, "aku/worker/dddddddd", otherId, bindTime);
    await first.abandon({ note: "done" });
    const abandoned = (await first.history()).events.find(
      (event) => event.source === "journal" && event.fact.kind === "abandoned",
    );
    if (abandoned === undefined || abandoned.source !== "journal") throw new Error("missing abandoned fact");
    await plantDispatch(repository, "aku/worker/eeeeeeee", firstId, abandoned.fact.at);

    const log = resolve(repository.path, "history-observation.log");
    writeFileSync(log, "");
    const history = await withGitShim(
      'printf \'%s\\n\' "$*" >> "$KEIYAKU_HISTORY_OBSERVATION_LOG"\nexec "$KEIYAKU_REAL_GIT" "$@"',
      { KEIYAKU_HISTORY_OBSERVATION_LOG: log },
      async (gitPath) => Keiyaku.of({ repo: await Repo.at({ path: repository.path, gitPath }), id: firstId }).history(),
    );
    const snapshot = await readRef(await cachedRepositoryAt(repository.path), GIT_REF);
    assert.equal(history.id, firstId);
    assert.equal(history.state, snapshot);
    assert.equal(history.events.filter((event) => event.source === "journal").length, 2);
    assert.deepEqual(
      history.events
        .filter((event) => event.source === "dispatch")
        .map((event) => (event.source === "dispatch" ? event.dispatch.akuId : "")),
      ["aku/worker/aaaaaaaa", "aku/worker/bbbbbbbb", "aku/worker/eeeeeeee", "aku/reviewer/cccccccc"],
    );
    assert.equal(
      history.events.some((event) => event.source === "dispatch" && event.dispatch.akuId === "aku/worker/dddddddd"),
      false,
    );
    const times = history.events.map((event) =>
      event.source === "journal" ? event.fact.at : event.dispatch.dispatchedAt,
    );
    assert.deepEqual(times, [...times].sort());
    const equalBind = history.events.filter(
      (event) => (event.source === "journal" ? event.fact.at : event.dispatch.dispatchedAt) === bindTime,
    );
    assert.equal(equalBind[0]?.source, "journal");
    assert.deepEqual(
      equalBind
        .filter((event) => event.source === "dispatch")
        .map((event) => (event.source === "dispatch" ? event.dispatch.akuId : "")),
      ["aku/worker/aaaaaaaa", "aku/worker/bbbbbbbb"],
    );
    const equalAbandon = history.events.filter(
      (event) => (event.source === "journal" ? event.fact.at : event.dispatch.dispatchedAt) === abandoned.fact.at,
    );
    assert.equal(equalAbandon[0]?.source, "journal");
    assert.equal(
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.includes(`rev-parse --verify --quiet ${GIT_REF}`)).length,
      1,
    );
  });

  test("contract history fails the whole read when journal or Dispatch is corrupt", async () => {
    const { repository, contract } = await defaultBoundFixture();
    const id = (await contract.state()).id;
    const git = await cachedRepositoryAt(repository.path);
    const before = await readGit(git);
    const journal = before.paths.get(contractJournalPath(id));
    if (journal?.type !== "blob") throw new Error("missing journal");
    const tree = await updateGitTree(
      git,
      before.tree,
      new Map([[contractJournalPath(id), { oid: await writeBlob(git, Buffer.from("not-a-journal\n")) }]]),
    );
    const commit = await writeCommit({ repository: git, tree, parent: before.commit, message: "corrupt journal" });
    if (before.commit === null) throw new Error("missing state ref");
    repository.run(["update-ref", GIT_REF, commit, before.commit]);
    await assert.rejects(
      async () => Keiyaku.of({ repo: await cachedRepoAt(repository.path), id }).history(),
      (error: unknown) => error instanceof AuthorityCorruptionError,
    );

    const { repository: clean, contract: intact } = await defaultBoundFixture();
    const intactId = (await intact.state()).id;
    await plantDispatch(
      clean,
      "aku/worker/ffffffff",
      intactId,
      "2026-08-17T00:00:00.000Z",
      Buffer.from("{not-canonical\n"),
    );
    await assert.rejects(
      () => intact.history(),
      (error: unknown) => error instanceof AuthorityCorruptionError,
    );
  });
});
