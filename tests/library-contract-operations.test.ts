import { present, accepted, assertRefused } from "./support/library-verbs.js";
import { captureWorktreeFiles, restoreWorktreeFiles, type WorktreeFixtureFile } from "./support/git.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { describe } from "node:test";
import { encodeEntry } from "../src/core/facts/codec.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { renderContractBody } from "../src/body/render.js";
import { changeId, contractId, entryUlid, snapshotId, type ContractId } from "../src/core/facts/types.js";
import { contractJournalPath, contractPhysicalName, gitRefLocator } from "../src/git/identity.js";
import {
  GIT_REF,
  HANDOFF_RECEIPT_REF_NAMESPACE,
  commonGitDirectory,
  readBlob,
  readGitPaths,
  readRef,
  updateGitTree,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import { tryAcquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { Kei, Keis, Repo, contractSummarySchema, type ContractDetail } from "../src/index.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  snapshotGitRepository,
  withGitShim,
} from "./support/git.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";
import { settlementProbe, waitForCondition } from "./support/process.js";

type ContractHandle = Pick<Kei, "state">;

test("bind persists the canonical rendering, so amending one section leaves other bytes untouched", async () => {
  const repository = repositoryWithMain();
  const repo = await cachedRepoAt(repository.path);
  const raw = document().replace(/\n## Objective/u, "\n\n\n## Objective");
  const bound = accepted(await Keis.of(repo).bind({ markdown: raw, workspace: "worktree" }));
  const before = present(await bound.kei.state()).terms.document.bytes;
  assert.equal(before, renderContractBody(decodeContractDocument(document())));
  const amended = accepted(
    await bound.kei.amend({ markdown: "## Replace: Objective\n\nA sharpened objective.\n" }),
  );
  assert.deepEqual(amended.changedSections, ["objective"]);
  const after = present(await bound.kei.state()).terms.document.bytes;
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
    await Keis.of(await cachedRepoAt(repository.path)).bind({
      markdown: document(),
      workspace: "worktree",
      target: "refs/heads/main",
      gates: ["reviewed"],
    }),
  );
  const boundId = await publicContractId(bound.kei);
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
  const contract = Keis.of(repo).kei({ id: template.id });
  return { repository, repo, contract, targetHead: template.targetHead, worktree };
}

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
    const contract = accepted(
      await Keis.of(repo).bind({
        markdown: document().replace("# Library verbs", `# Board handoff ${index}`),
        workspace: "worktree",
        target: "refs/heads/main",
        gates: ["reviewed"],
      }),
    ).kei;
    const id = await publicContractId(contract);
    const appointment = await readManagedWorktreeAppointment(git, id);
    assert.equal(appointment.kind, "appointed");
    if (appointment.kind !== "appointed") throw new Error("missing fixture appointment");
    writeFileSync(join(appointment.path, "shared.txt"), "tender\n");
    repository.run(["-C", appointment.path, "add", "shared.txt"]);
    repository.run(["-C", appointment.path, "commit", "--quiet", "-m", "tender"]);
    contracts.push({
      contract,
      id,
      worktree: appointment.path,
      ref: `${HANDOFF_RECEIPT_REF_NAMESPACE}/${contractPhysicalName(id)}/${appointment.place}`,
    });
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
  test("Contract catalogue retains compact physical attention while exact detail retains handoff facts", async (context) => {
    for (const count of [1, 6]) {
      const { repository, repo, contracts } = await conflictBoardFixture(count);
      const expected: ContractDetail[] = [];
      for (const { id } of contracts) {
        const observed = await Keis.of(repo).observe({ id });
        assert.equal(observed.kind, "present");
        if (observed.kind !== "present") throw new Error("missing fixture row");
        expected.push(observed.row);
        assert.equal(observed.row.workspace.kind, "present");
        if (observed.row.workspace.kind !== "present") throw new Error("missing conflict");
        assert.deepEqual(observed.row.workspace.merge, ["shared.txt"]);
        assert.deepEqual(observed.row.targetLag, { kind: "counted", behind: 1 });
      }
      const reference = await Keis.of(repo).list({});
      const referenceRows = reference.rows!;
      assert.deepEqual(
        referenceRows.map(({ id }) => id).sort(),
        expected.map(({ id }) => id).sort(),
      );
      for (const row of referenceRows) {
        const detail = expected.find(({ id }) => id === row.id)!;
        assert.equal(row.title, detail.title);
        assert.deepEqual(contractSummarySchema.parse(JSON.parse(JSON.stringify(row))), row);
        assert.deepEqual(row.attention, [
          { kind: "merge-in-progress", path: contracts.find(({ id }) => id === row.id)!.worktree, conflicts: 1 },
          { kind: "target-behind", behind: 1, subject: contracts.find(({ id }) => id === row.id)!.worktree },
        ]);
      }
      const calls = join(repository.path, ".git", "board-calls");
      const board = await withGitShim(
        'printf "%s\\n" "$*" >> "$KEIYAKU_BOARD_CALLS"\nexec "$KEIYAKU_REAL_GIT" "$@"',
        { KEIYAKU_BOARD_CALLS: calls },
        async (gitPath) => {
          const traced = await Repo.at({ path: repository.path, gitPath });
          writeFileSync(calls, ""); // Exclude repository construction from the product read.
          const start = performance.now();
          const board = await Keis.of(traced).list({  });
          const commands = readFileSync(calls, "utf8").trim().split("\n");
          const refBatches = commands.filter((command) => command === "cat-file --batch-check=%(objectname)").length;
          const blobChannels = commands.filter((command) => command === "cat-file --batch").length;
          const statusWalks = commands.filter((command) => command.includes(" status --porcelain=v2 ")).length;
          const individualHandoffRefs = commands.filter(
            (command) => command.includes("rev-parse") && command.includes(HANDOFF_RECEIPT_REF_NAMESPACE),
          ).length;
          const individualBlobs = commands.filter((command) => command.startsWith("cat-file blob ")).length;
          context.diagnostic(
            JSON.stringify({
              rows: count,
              refBatches,
              blobChannels,
              statusWalks,
              individualHandoffRefs,
              individualBlobs,
              totalProcesses: commands.length,
              wallMs: Math.round(performance.now() - start),
            }),
          );
          assert.equal(refBatches, 0, "the summary catalogue reads no handoff refs");
          assert.equal(blobChannels, 1, "journal reads share one blob channel");
          assert.equal(statusWalks, count, "only selected catalogue workspaces are observed");
          assert.equal(individualHandoffRefs, 0);
          assert.equal(individualBlobs, 0);
          return board;
        },
      );
      assert.deepEqual(board.rows, reference.rows);
      const catalogue = await Keis.of(repo).list({ limit: 1 });
      assert.equal(catalogue.more, count > 1 ? true : undefined);
      assert.deepEqual(catalogue.rows, referenceRows.slice(0, 1));
    }
  });

  test("selected workspace judgment ignores unrelated handoff receipt bytes while absent, mismatched and consumed refs stay local", async () => {
    const { repository, repo, git, contracts } = await conflictBoardFixture(6);
    const before = await Keis.of(repo).list({});
    const detailFor = async (id: ContractId): Promise<ContractDetail> => {
      const exact = await Keis.of(repo).observe({ id });
      assert.equal(exact.kind, "present");
      if (exact.kind !== "present") throw new Error("missing fixture detail");
      return exact.row;
    };
    const beforeDetails = await Promise.all(before.rows!.map((row) => detailFor(row.id)));
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
    const after = await Keis.of(repo).list({});
    assert.deepEqual(after.rows, before.rows!.map(row => row.id === orphan.id
      ? { ...row, attention: row.attention!.filter(issue => issue.kind !== "merge-in-progress") }
      : row));
    const afterDetails = await Promise.all(after.rows!.map((row) => detailFor(row.id)));
    assert.deepEqual(
      afterDetails,
      beforeDetails.map((row) => {
        if (row.id !== orphan.id) return row;
        const workspace = row.workspace;
        if (workspace.kind !== "present" || workspace.merge === undefined)
          throw new Error("missing fixture conflict");
        const { merge: _merge, ...withoutMerge } = workspace;
        return { ...row, workspace: withoutMerge };
      }),
    );

    const selected = (await Keis.of(repo).list({ limit: 1 })).rows![0]!;
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
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_SELECTION_CALLS: calls, KEIYAKU_SELECTION_REFS: refs },
      async (gitPath) => {
        const traced = await Repo.at({ path: repository.path, gitPath });
        writeFileSync(calls, "");
        writeFileSync(refs, "");
        const bounded = await Keis.of(traced).list({ limit: 1 });
        assert.deepEqual(bounded.rows, [selected]);
        assert.equal(bounded.more, true);
        assert.equal(readFileSync(refs, "utf8"), "", "the summary catalogue reads no handoff ref");
        assert.equal(readFileSync(calls, "utf8").includes(unrelated.worktree), false);
        writeFileSync(calls, "");
        writeFileSync(refs, "");
        const exact = await Keis.of(traced).observe({ id: selected.id });
        assert.equal(exact.kind, "present");
        if (exact.kind === "present")
          assert.deepEqual(
            exact.row,
            afterDetails.find(({ id }) => id === selected.id),
          );
        assert.equal(readFileSync(calls, "utf8").includes(unrelated.worktree), false);
      },
    );
    assert.deepEqual(
      (await Keis.of(repo).list({})).rows,
      after.rows,
      "the summary catalogue does not read the malformed handoff receipt",
    );
    const malformed = await Keis.of(repo).observe({ id: unrelated.id });
    assert.equal(malformed.kind, "present");
    if (malformed.kind === "present") assert.equal(malformed.row.issue, undefined);
    repository.run(["update-ref", "-d", unrelated.ref]);

    const matching = contracts[0]!;
    // Resolve using final bytes, then consume the handoff through the ordinary delivery path.
    writeFileSync(join(matching.worktree, "shared.txt"), "resolved\n");
    accepted(await matching.contract.deliver({ includeDirty: true }));
    assert.equal(await readRef(git, matching.ref), null);
    const resolved = await Keis.of(repo).observe({ id: matching.id });
    assert.equal(resolved.kind, "present");
    if (resolved.kind !== "present") throw new Error("missing resolved row");
    assert.equal(resolved.row.workspace.kind, "present");
    if (resolved.row.workspace.kind === "present") assert.equal(resolved.row.workspace.merge, undefined);
  });

  test("plain deliver conflict is an executable handoff and does not mutate", async () => {
    const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
    const git = await cachedRepositoryAt(repository.path);
    const journal = await readRef(git, GIT_REF);
    await assertRefused(() => contract.deliver(), {
      kind: "integration-conflict",
      targetHead,
      conflictPaths: ["a.txt", "z.txt"],
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
    const armed = join(repository.path, ".git", "placement-fence-armed");
    const parked = join(repository.path, ".git", "placement-fence-parked");
    const released = join(repository.path, ".git", "placement-fence-released");
    await withGitShim(
      [
        // Park the first Git observation after placement acquires its fence. Preparing competing
        // journal/target changes now consumes no lock-acquisition budget.
        'if [ -f "$KEIYAKU_FENCE_ARMED" ] && [ ! -f "$KEIYAKU_FENCE_RELEASED" ]; then',
        '  : > "$KEIYAKU_FENCE_PARKED"',
        '  while [ ! -f "$KEIYAKU_FENCE_RELEASED" ]; do sleep 0.05; done',
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_FENCE_ARMED: armed, KEIYAKU_FENCE_PARKED: parked, KEIYAKU_FENCE_RELEASED: released },
      async (gitPath) => {
        const traced = Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({
          id: await publicContractId(contract),
        });
        const pending = traced.review(
          { verdict: "satisfied", summary: "Contract operation review passed" },
          {
            observe: (event) => {
              if (event.kind === "stage" && event.stage === "placement" && event.state === "started")
                writeFileSync(armed, "");
            },
          },
        );
        try {
          await waitForCondition("review parked inside the placement fence", () => existsSync(parked), {
            terminalState: settlementProbe(pending, () => "review settled before parking"),
          });
          // The parked review holds the target-placement fence, so a contender cannot enter it.
          const contender = await tryAcquireSqliteTransactionLock({
            path: resolve(
              commonGitDirectory(git),
              "keiyaku",
              "locks",
              "target-placement",
              `${gitRefLocator("refs/heads/main")}.sqlite`,
            ),
            mode: "immediate",
          });
          contender?.close();
          assert.equal(contender, null);
          const state = present(await contract.state());
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
        } finally {
          // Release the parked review and drain it on every path so its fence closes.
          writeFileSync(released, "");
          await pending.catch(() => undefined);
        }
        const reviewed = await pending;
        assert.equal(accepted(reviewed).placement?.kind, "placed");
        const finalState = present(await contract.state());
        assert.equal(finalState.terminal?.kind, "claimed");
        assert.equal(finalState.currentIntegration?.snapshot, repository.run(["rev-parse", "refs/heads/main"]).trim());
      },
    );
  });

  test("ungated Verification is absent from a library delivery claim", async () => {
    const repository = repositoryWithMain();
    const bound = accepted(
      await Keis.of(await cachedRepoAt(repository.path)).bind({
        markdown: document("exit 1"),
        workspace: "worktree",
        gates: [],
      }),
    );
    const state = present(await bound.kei.state());
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
    repository.run(["-C", worktree, "add", "candidate.txt"]);
    repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);

    let preparedIntegration: string | undefined;
    const delivered = await bound.kei.deliver({}, { observe: (event) => {
      if (event.kind !== "admitted" || event.fact.kind !== "deliver") return;
      preparedIntegration = event.fact.data.integration.snapshot;
      writeFileSync(join(repository.path, "target-only.txt"), "moved after candidate admission\n");
      repository.run(["add", "target-only.txt"]);
      repository.run(["commit", "--quiet", "-m", "advance target after admission"]);
    } });
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.ok(delivered.placement?.kind === "placed");
    assert.notEqual(delivered.integration, preparedIntegration);
    assert.deepEqual(present(await bound.kei.state()).attestations, []);
    assert.equal(present(await bound.kei.state()).terminal?.kind, "claimed");
  });
});
