import { present, accepted, assertRefused } from "./support/library-verbs.js";
import { captureWorktreeFiles, restoreWorktreeFiles, type WorktreeFixtureFile } from "./support/git.js";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { encodeEntry } from "../src/core/facts/codec.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { renderContractBody } from "../src/body/render.js";
import { changeId, contractId, entryUlid, snapshotId, type ContractId } from "../src/core/facts/types.js";
import { contractJournalPath, contractPhysicalName } from "../src/git/identity.js";
import { GIT_REF, HANDOFF_RECEIPT_REF_NAMESPACE, readBlob, readGitPaths, readRef, updateGitTree, writeBlob, writeCommit } from "../src/git/repository.js";
import { acquireTargetPlacementFence } from "../src/git/target-placement.js";
import { Keiyaku, Repo, type ContractRow } from "../src/index.js";
import { appointedWorktreePath, cachedRepoAt, cachedRepositoryAt, snapshotGitRepository, withGitShim } from "./support/git.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { conflictRecovery } from "../src/git/workspace.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

type ContractHandle = Pick<Keiyaku, "state">;

test("bind persists the canonical rendering, so amending one section leaves other bytes untouched", async () => {
  const repository = repositoryWithMain();
  const repo = await cachedRepoAt(repository.path);
  const raw = document().replace(/\n## Objective/u, "\n\n\n## Objective");
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: raw, workspace: "worktree" }));
  const before = present(await bound.value.keiyaku.state()).terms.document.bytes;
  assert.equal(before, renderContractBody(decodeContractDocument(document())));
  const amended = accepted(
    await bound.value.keiyaku.amend({ markdown: "## Replace: Objective\n\nA sharpened objective.\n" }),
  );
  assert.match(amended.value.documentDiff, /sharpened objective/u);
  const after = present(await bound.value.keiyaku.state()).terms.document.bytes;
  const start = before.indexOf("## Objective");
  const end = before.indexOf("## Design");
  assert.equal(after.slice(0, start), before.slice(0, start));
  assert.equal(after.slice(after.indexOf("## Design")), before.slice(end));
});

async function publicContractId(handle: ContractHandle): Promise<ContractId> {
  return present(await handle.state()).id;
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
  const bound = accepted(
    await Keiyaku.with().bind({
      repo: await cachedRepoAt(repository.path),
      markdown: document(),
      workspace: "worktree",
      target: "refs/heads/main",
      gates: ["reviewed"],
    }),
  );
  const boundId = await publicContractId(bound.value.keiyaku);
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
  const contract = Keiyaku.with().select({ repo, id: template.id });
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

async function conflictBoardFixture(count: number) {
  const repository = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const repo = await cachedRepoAt(repository.path);
  const git = await cachedRepositoryAt(repository.path);
  const contracts = [];
  for (let index = 0; index < count; index += 1) {
    const contract = accepted(await Keiyaku.with().bind({
      repo,
      markdown: document().replace("# Library verbs", `# Board handoff ${index}`),
      workspace: "worktree",
      target: "refs/heads/main",
      gates: ["reviewed"],
    })).value.keiyaku;
    const id = await publicContractId(contract);
    const appointment = await readManagedWorktreeAppointment(git, id);
    assert.equal(appointment.kind, "appointed");
    if (appointment.kind !== "appointed") throw new Error("missing fixture appointment");
    writeFileSync(join(appointment.path, "shared.txt"), "tender\n");
    repository.run(["-C", appointment.path, "add", "shared.txt"]);
    repository.run(["-C", appointment.path, "commit", "--quiet", "-m", "tender"]);
    contracts.push({ contract, id, worktree: appointment.path,
      ref: `${HANDOFF_RECEIPT_REF_NAMESPACE}/${contractPhysicalName(id)}/${appointment.place}` });
  }
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target"]);
  for (const { contract } of contracts) {
    const handoff = await contract.deliver({ materializeConflict: true });
    assert.equal(handoff.kind, "handoff", JSON.stringify(handoff));
  }
  return { repository, repo, git, contracts };
}

// Each case owns a separate repository and scoped fault injection, never a process-wide mock.
describe("library-contract-operations isolated repositories", { concurrency: 4 }, () => {
  test("Contract boards batch handoff reads at one and six rows with unchanged row facts", async (context) => {
    for (const count of [1, 6]) {
      const { repository, repo, contracts } = await conflictBoardFixture(count);
      const expected: ContractRow[] = [];
      for (const { id } of contracts) {
        const observed = await Keiyaku.with().observe({ repo, id });
        assert.equal(observed.kind, "present");
        if (observed.kind !== "present") throw new Error("missing fixture row");
        expected.push(observed.row);
        assert.equal(observed.row.workspaceObservation.kind, "dirty");
        if (observed.row.workspaceObservation.kind !== "dirty") throw new Error("missing conflict");
        assert.deepEqual(observed.row.workspaceObservation.merge, {
          head: repository.run(["rev-parse", "refs/heads/main"]).trim(),
          unmergedPaths: ["shared.txt"],
          handoffBase: repository.run(["-C", observed.row.worktreePath!, "rev-parse", "HEAD"]).trim(),
          recovery: conflictRecovery,
        });
        assert.deepEqual(observed.row.targetLag, {
          kind: "counted", behind: 1, subject: { kind: "worktree", path: observed.row.worktreePath },
        });
      }
      const reference = await Keiyaku.with().list({ repo });
      assert.deepEqual(reference.rows.map((row) => expected.find(({ id }) => id === row.id)), reference.rows);
      const calls = join(repository.path, ".git", "board-calls");
      const board = await withGitShim(
        'printf "%s\\n" "$*" >> "$KEIYAKU_BOARD_CALLS"\nexec "$KEIYAKU_REAL_GIT" "$@"',
        { KEIYAKU_BOARD_CALLS: calls },
        async (gitPath) => {
          const traced = await Repo.at({ path: repository.path, gitPath });
          writeFileSync(calls, ""); // Exclude repository construction from the product read.
          const start = performance.now();
          const board = await Keiyaku.with().list({ repo: traced });
          const commands = readFileSync(calls, "utf8").trim().split("\n");
          const refBatches = commands.filter((command) => command === "cat-file --batch-check=%(objectname)").length;
          const blobChannels = commands.filter((command) => command === "cat-file --batch").length;
          const statusWalks = commands.filter((command) => command.includes(" status --porcelain=v2 ")).length;
          const individualHandoffRefs = commands.filter((command) => command.includes("rev-parse") && command.includes(HANDOFF_RECEIPT_REF_NAMESPACE)).length;
          const individualBlobs = commands.filter((command) => command.startsWith("cat-file blob ")).length;
          context.diagnostic(JSON.stringify({ rows: count, refBatches, blobChannels, statusWalks,
            individualHandoffRefs, individualBlobs, totalProcesses: commands.length,
            wallMs: Math.round(performance.now() - start) }));
          assert.equal(refBatches, 1);
          assert.equal(blobChannels, 1);
          assert.equal(statusWalks, count);
          assert.equal(individualHandoffRefs, 0);
          assert.equal(individualBlobs, 0);
          return board;
        },
      );
      assert.deepEqual(board.rows, reference.rows);
      const catalogue = await Keiyaku.with().list({ repo, limit: 1 });
      assert.equal(catalogue.hasMore, count > 1);
      const recent = [...expected].sort((left, right) =>
        right.lastJournalAt.localeCompare(left.lastJournalAt) || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
      assert.deepEqual(catalogue.rows, recent.slice(0, 1));
    }
  });

  test("handoff selection preserves absent, mismatched, malformed and consumed workspace judgments", async () => {
    const { repository, repo, git, contracts } = await conflictBoardFixture(6);
    const before = await Keiyaku.with().list({ repo });
    const absent = contracts[1]!;
    repository.run(["update-ref", "-d", absent.ref]);
    for (const [index, field] of ["contractId", "place", "workspace"].entries()) {
      const coordinate = contracts[index + 2]!;
      const oid = present(await readRef(git, coordinate.ref));
      const receipt = JSON.parse((await readBlob(git, oid)).toString("utf8"));
      receipt[field] = field === "workspace" ? repository.path : "different";
      repository.run(["update-ref", coordinate.ref, await writeBlob(git, JSON.stringify(receipt))]);
    }
    const orphan = contracts[5]!;
    repository.run(["-C", orphan.worktree, "merge", "--quit"]);
    const after = await Keiyaku.with().list({ repo });
    assert.deepEqual(after.rows, before.rows.map((row) => {
      if (row.id === contracts[0]!.id) return row;
      const workspace = row.workspaceObservation;
      if (workspace.kind !== "dirty" || workspace.merge === null) throw new Error("missing fixture conflict");
      const { handoffBase: _base, recovery: _recovery, ...merge } = workspace.merge;
      return { ...row, workspaceObservation: { ...workspace, merge: row.id === orphan.id ? null : merge } };
    }));
    for (const row of after.rows) {
      const exact = await Keiyaku.with().observe({ repo, id: row.id });
      assert.equal(exact.kind, "present");
      if (exact.kind === "present") assert.deepEqual(exact.row, row);
    }

    const selected = (await Keiyaku.with().list({ repo, limit: 1 })).rows[0]!;
    const unrelated = contracts.find(({ id }) => id !== selected.id && id !== contracts[0]!.id)!;
    const corrupt = await writeBlob(git, '{"version":1}');
    repository.run(["update-ref", unrelated.ref, corrupt]);
    const calls = join(repository.path, ".git", "selection-calls");
    const refs = join(repository.path, ".git", "selection-refs");
    await withGitShim(
      [
        'printf "%s\\n" "$*" >> "$KEIYAKU_SELECTION_CALLS"',
        'if [ "$1 $2" = "cat-file --batch-check=%(objectname)" ]; then',
        '  while IFS= read -r ref; do printf "%s\\n" "$ref" >> "$KEIYAKU_SELECTION_REFS"; done',
        '  exec "$KEIYAKU_REAL_GIT" "$@" < "$KEIYAKU_SELECTION_REFS"',
        'fi',
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_SELECTION_CALLS: calls, KEIYAKU_SELECTION_REFS: refs },
      async (gitPath) => {
        const traced = await Repo.at({ path: repository.path, gitPath });
        writeFileSync(calls, "");
        writeFileSync(refs, "");
        const bounded = await Keiyaku.with().list({ repo: traced, limit: 1 });
        assert.deepEqual(bounded.rows, [selected]);
        assert.equal(bounded.hasMore, true);
        assert.equal(readFileSync(refs, "utf8"), `${contracts.find(({ id }) => id === selected.id)!.ref}\n`);
        assert.equal(readFileSync(calls, "utf8").includes(unrelated.worktree), false);
        writeFileSync(calls, "");
        writeFileSync(refs, "");
        const exact = await Keiyaku.with().observe({ repo: traced, id: selected.id });
        assert.equal(exact.kind, "present");
        if (exact.kind === "present") assert.deepEqual(exact.row, selected);
        assert.equal(readFileSync(refs, "utf8"), `${contracts.find(({ id }) => id === selected.id)!.ref}\n`);
        assert.equal(readFileSync(calls, "utf8").includes(unrelated.worktree), false);
      },
    );
    await assert.rejects(Keiyaku.with().list({ repo }), /handoff receipt is malformed/u);
    await assert.rejects(Keiyaku.with().observe({ repo, id: unrelated.id }), /handoff receipt is malformed/u);
    repository.run(["update-ref", "-d", unrelated.ref]);

    const matching = contracts[0]!;
    // Resolve using final bytes, then consume the handoff through the ordinary delivery path.
    writeFileSync(join(matching.worktree, "shared.txt"), "resolved\n");
    accepted(await matching.contract.deliver({ includeDirty: true }));
    assert.equal(await readRef(git, matching.ref), null);
    const resolved = await Keiyaku.with().observe({ repo, id: matching.id });
    assert.equal(resolved.kind, "present");
    if (resolved.kind !== "present") throw new Error("missing resolved row");
    assert.equal(resolved.row.workspaceObservation.kind, "dirty");
    if (resolved.row.workspaceObservation.kind === "dirty") assert.equal(resolved.row.workspaceObservation.merge, null);
  });

  test("plain deliver conflict is an executable handoff and does not mutate", async () => {
    const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
    const git = await cachedRepositoryAt(repository.path);
    const journal = await readRef(git, GIT_REF);
    await assertRefused(() => contract.deliver(), {
      kind: "integration-failed",
      contractId: await publicContractId(contract),
      reason: "conflict",
      targetHead,
      conflictPaths: ["a.txt", "z.txt"],
      recovery: DELIVER_CONFLICT_RECOVERY,
    });
    const state = present(await contract.state());
    assert.equal(state.delivery, null);
    assert.equal(state.terminal, null);
    assert.equal(await readRef(git, GIT_REF), journal);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetHead);
    assert.equal(mergeHead(repository, worktree), null);
  });

  test("a satisfied review cannot interleave a stale integration stop across the target fence", async () => {
    const { repository, contract, targetHead } = await reviewGatedConflictCandidateFixture();
    const git = await cachedRepositoryAt(repository.path);
    const held = await acquireTargetPlacementFence(git, "refs/heads/main");
    const pending = contract.review({ verdict: "satisfied" });
    // A full parallel suite can delay Git observation without changing the fence ordering.
    const deadline = Date.now() + 15000;
    let state = present(await contract.state());
    while (state.attestations.at(-1)?.data.verdict !== "satisfied" && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      state = present(await contract.state());
    }
    assert.equal(state.attestations.at(-1)?.data.verdict, "satisfied");
    assert.equal(state.delivery, null);
    const reviewedChangeId = changeIdFromSubject(state.attestations.at(-1)?.data.subject);
    if (reviewedChangeId === undefined) throw new Error("reviewed subject is missing its ChangeId");
    const journalPath = contractJournalPath(state.id);
    const before = await readGitPaths(git, [journalPath]);
    const active = before.paths.get(journalPath);
    if (active?.type !== "blob") throw new Error("missing active journal");
    const oid = await writeBlob(
      git,
      Buffer.concat([
        await readBlob(git, active.oid),
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
    assert.equal(accepted(reviewed).value.placement, undefined);
    const finalState = present(await contract.state());
    assert.equal(finalState.terminal?.kind, "claimed");
    assert.equal(finalState.currentIntegration?.snapshot, repository.run(["rev-parse", "refs/heads/main"]).trim());
  });

  test("declared failing Verification with no gate does not block a library delivery claim", async () => {
    const repository = repositoryWithMain();
    const bound = accepted(
      await Keiyaku.with().bind({
        repo: await cachedRepoAt(repository.path),
        markdown: document("exit 1"),
        workspace: "worktree",
        gates: [],
      }),
    );
    const state = present(await bound.value.keiyaku.state());
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
    repository.run(["-C", worktree, "add", "candidate.txt"]);
    repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);

    const delivered = await bound.value.keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.deepEqual(delivered.value.completion?.verification, { mode: "ran", verdict: "unsatisfied" });
    assert.equal(delivered.value.placement, undefined);
    assert.equal(present(await bound.value.keiyaku.state()).terminal?.kind, "claimed");
  });
});
