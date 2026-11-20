import { present, accepted } from "./support/library-verbs.js";
import { captureWorktreeFiles, restoreWorktreeFiles, type WorktreeFixtureFile } from "./support/git.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { decodeContractDocument } from "../src/body/decode.js";
import { renderContractBody } from "../src/body/render.js";
import { contractId, snapshotId, type ContractId } from "../src/core/facts/types.js";
import { contractPhysicalName } from "../src/git/identity.js";
import {
  GIT_REF,
  HANDOFF_RECEIPT_REF_NAMESPACE,
  readBlob,
  readRef,
} from "../src/git/repository.js";
import { Kei, Keis, Keiyaku, Repo } from "../src/index.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  snapshotGitRepository,
  withGitShim,
} from "./support/git.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

type ContractHandle = Pick<Kei, "state">;

test("bind persists the canonical rendering, so amending one section leaves other bytes untouched", async () => {
  const repository = repositoryWithMain();
  const repo = await cachedRepoAt(repository.path);
  const raw = document().replace(/\n## Objective/u, "\n\n\n## Objective");
  const bound = accepted(await Keis.of(repo).bind({ terms: raw }));
  const before = present(await bound.kei.state()).terms.document.bytes;
  assert.equal(before, renderContractBody(decodeContractDocument(document())));
  const amended = accepted(
    await bound.kei.amend({ edits: "## Replace: Objective\n\nA sharpened objective.\n" }),
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
      terms: document(),
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

// Each case owns a separate repository and scoped fault injection, never a process-wide mock.
describe("library-contract-operations isolated repositories", { concurrency: 4 }, () => {
  test("an older admitted delivery cannot retire a newer conflict handoff", async () => {
    const { repository, repo, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
    const git = await cachedRepositoryAt(repository.path);
    const id = await publicContractId(contract);
    const candidateHead = snapshotId(repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim());

    // Admit a clean older candidate without placement; the reviewed gate is unmet.
    repository.run(["-C", worktree, "checkout", "--detach", "--quiet", `${candidateHead}^`]);
    accepted(await contract.deliver());
    const older = present(await contract.state());
    assert.notEqual(older.delivery, null);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetHead);

    // Restore the conflicting candidate and materialize the native handoff.
    repository.run(["-C", worktree, "checkout", "--detach", "--quiet", candidateHead]);
    const handoff = await contract.deliver({ includeDirty: true, materializeConflict: true });
    assert.equal(handoff.kind, "handoff", JSON.stringify(handoff));
    if (handoff.kind !== "handoff") throw new Error("expected a native conflict handoff");

    const appointment = await readManagedWorktreeAppointment(git, id);
    assert.equal(appointment.kind, "appointed");
    if (appointment.kind !== "appointed") throw new Error("missing fixture appointment");
    const receiptRef = `${HANDOFF_RECEIPT_REF_NAMESPACE}/${contractPhysicalName(id)}/${appointment.place}`;
    const receiptOid = await readRef(git, receiptRef);
    assert.ok(receiptOid);
    assert.equal(mergeHead(repository, worktree), targetHead);
    const conflictedIndex = repository.run(["-C", worktree, "ls-files", "--stage"]);
    const conflictedBytes = readFileSync(join(worktree, "a.txt"), "utf8");

    // Ordinary reconcile must not let the earlier delivery retire this unconsumed handoff.
    const reconciled = await Keis.of(repo).reconcile({ contract: id });
    assert.equal(reconciled.kind, "contract");
    assert.deepEqual(present(await contract.state()), older);
    assert.equal(await readRef(git, receiptRef), receiptOid);
    assert.equal(mergeHead(repository, worktree), targetHead);
    assert.equal(repository.run(["-C", worktree, "ls-files", "--stage"]), conflictedIndex);
    assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), conflictedBytes);

    // Resolving the bytes consumes the exact receipt atomically; one refused post-admission
    // metadata retirement leaves durable consumed custody for a later ordinary reconcile.
    writeFileSync(join(worktree, "a.txt"), "resolved a\n");
    writeFileSync(join(worktree, "z.txt"), "resolved z\n");
    repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
    accepted(await contract.review({ verdict: "satisfied", summary: "Resolved handoff review passed" }));
    const resolvedIndex = repository.run(["-C", worktree, "ls-files", "--stage"]);
    const refuse = join(repository.path, ".git", "merge-quit-refused");
    const fired = join(repository.path, ".git", "merge-quit-refusal-fired");
    writeFileSync(refuse, "");
    await withGitShim(
      [
        'case " $* " in',
        '  *" merge --quit "*)',
        '    if [ -e "$KEIYAKU_REFUSE_MERGE_QUIT" ]; then : > "$KEIYAKU_MERGE_QUIT_REFUSED"; exit 1; fi ;;',
        "esac",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_REFUSE_MERGE_QUIT: refuse, KEIYAKU_MERGE_QUIT_REFUSED: fired },
      async (gitPath) => {
        const traced = Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({ id });
        const delivered = accepted(await traced.deliver({ includeDirty: true }));
        assert.equal(existsSync(fired), true, "the post-admission merge-quit refusal must fire");
        assert.equal(delivered.placement?.kind, "placed");
        assert.ok(delivered.issues?.some((issue) => issue.kind === "reconcile-failed"));
        assert.equal(repository.run(["show", `${delivered.candidate}:a.txt`]), "resolved a\n");
        unlinkSync(refuse);

        const consumedOid = await readRef(git, receiptRef);
        assert.ok(consumedOid);
        assert.notEqual(consumedOid, receiptOid);
        const proof = JSON.parse((await readBlob(git, consumedOid!)).toString("utf8")) as Record<string, unknown>;
        assert.equal(proof.consumed, true);
        assert.equal(proof.head, handoff.handoffBase);
        assert.equal(proof.mergeHead, targetHead);
        assert.equal(mergeHead(repository, worktree), targetHead);
        assert.equal(repository.run(["-C", worktree, "ls-files", "--stage"]), resolvedIndex);
        const mainIndex = repository.run(["ls-files", "--stage", "--", "a.txt", "z.txt"]);
        const mainBytes = readFileSync(join(repository.path, "a.txt"), "utf8");
        const afterDelivery = present(await traced.state());
        assert.equal(afterDelivery.terminal?.kind, "claimed");

        const retried = await Keis.of(await Repo.at({ path: repository.path, gitPath })).reconcile({
          contract: id,
        });
        assert.equal(retried.kind, "contract");
        assert.deepEqual(present(await contract.state()), afterDelivery);
        assert.equal(await readRef(git, receiptRef), null);
        assert.equal(repository.run(["ls-files", "--stage", "--", "a.txt", "z.txt"]), mainIndex);
        assert.equal(readFileSync(join(repository.path, "a.txt"), "utf8"), mainBytes);
        assert.equal(repository.run(["show", `${delivered.candidate}:z.txt`]), "resolved z\n");
        assert.equal(existsSync(worktree), false, "terminal cleanup follows the retired handoff");
      },
    );
  });

  test("plain deliver conflict is an executable handoff and does not mutate", async () => {
    const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
    const git = await cachedRepositoryAt(repository.path);
    const journal = await readRef(git, GIT_REF);
    const refused = await contract.deliver();
    assert.deepEqual(refused, {
      kind: "refused",
      contractId: contract.id,
      reason: { kind: "integration-conflict", targetHead, conflictPaths: ["a.txt", "z.txt"] },
    });
    assertWireRoundTrip(Keiyaku.verbs.deliver.output, refused);
    const state = present(await contract.state());
    assert.equal(state.delivery, null);
    assert.equal(state.terminal, null);
    assert.equal(await readRef(git, GIT_REF), journal);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetHead);
    assert.equal(mergeHead(repository, worktree), null);
  });

});
