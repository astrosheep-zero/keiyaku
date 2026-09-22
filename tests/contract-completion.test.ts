import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { appointedWorktreePath, cachedRepoAt, cachedRepositoryAt, captureWorktreeFiles, restoreWorktreeFiles, snapshotGitRepository } from "./support/git.js";
import { bind, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";

// Bind once for setup, then give every scenario independent refs, files and worktree.
// The behavior under test (review, delivery, cancellation, completion) is never cached.
async function candidateTemplate() {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const state = await contract.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  commitCandidate(repository, worktree);
  const candidate = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  const generated = captureWorktreeFiles(worktree);
  repository.run(["update-ref", "refs/heads/test-completion-template", candidate]);
  repository.run(["worktree", "remove", "--force", worktree]);
  return { repository, id: state.id, candidate, generated };
}
let template: ReturnType<typeof candidateTemplate> | undefined;
async function fixture() {
  const prepared = await (template ??= candidateTemplate());
  const repository = snapshotGitRepository(prepared.repository);
  const contract = Keiyaku.of({ repo: await cachedRepoAt(repository.path), id: prepared.id });
  const state = await contract.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  repository.run(["worktree", "add", "--quiet", "--detach", worktree, prepared.candidate]);
  repository.run(["update-ref", "-d", "refs/heads/test-completion-template"]);
  restoreWorktreeFiles(worktree, prepared.generated);
  return { repository, contract, state, worktree };
}


// These tests exercise the real admission boundary, not a synthetic accepted object.
import { executeLocalReview, withContractExecution } from "../src/library/contract-execution.js";
import { requireLeadingAdmission } from "../src/library/refusal.js";
import { admitReviewOperation } from "../src/protocol/review.js";
import { executionReceipt } from "../src/library/execution-result.js";
import { acquireTargetPlacementFence } from "../src/git/target-placement.js";
import { withGitShim } from "./support/git.js";
import { EMPTY_WORKTREE_HOOKS } from "../src/git/hooks.js";
import { type ContractId } from "../src/core/facts/types.js";

function deferred() {
  const { promise: promise, resolve } = promiseBarrier<void>();
  return { promise, resolve };
}

import { waitForFile } from "./support/git.js";

// Each case owns a separate repository and scoped fault injection, never a process-wide mock.
describe("contract-completion isolated repositories", { concurrency: 4 }, () => {

  test("review after delivery uses the same completion node without replaying delivery facts", async () => {
    const { contract } = await fixture();
    const delivered = await contract.deliver();
    assert.ok(delivered.kind === "accepted", "expected delivered.kind = \"accepted\"");
    assert.equal(delivered.value.completion, undefined);
    assert.deepEqual(
      delivered.facts.map((fact) => fact.kind),
      ["bound", "deliver"],
    );
    const review = await contract.review({ verdict: "satisfied" });
    assert.deepEqual(
      review.facts.map((fact) => fact.kind),
      ["attestation", "claimed"],
    );
    assert.ok(review.value.completion);
    assert.equal(review.head, (await contract.state()).head);
  });

  test("review cancellation after admission stops fenced placement and retains the real receipt", async () => {
    const repository = repositoryWithMain();
    const primary = (
      await Keiyaku.bind({
        repo: await Repo.at({ path: repository.path }),
        markdown: document(),
        target: "refs/heads/main",
        workspace: "worktree",
        gates: ["reviewed"],
      })
    ).keiyaku;
    const state = await primary.state();
    await primary.deliver();
    const scope = await cachedRepositoryAt(repository.path);
    const held = await acquireTargetPlacementFence(scope, "refs/heads/main");
    const committed = deferred(),
      controller = new AbortController();
    try {
      const pending = executeLocalReview({
        scope: { ...scope, onPrivateStateSeatClose: committed.resolve },
        contractId: state.id,
        verdict: "satisfied",
        signal: controller.signal,
        hooks: EMPTY_WORKTREE_HOOKS,
      });
      await committed.promise;
      controller.abort(new Error("cancel review after its receipt"));
      const reviewed = await pending;
      assert.deepEqual(
        reviewed.facts.map((fact) => fact.kind),
        ["attestation"],
      );
      assert.equal(reviewed.head, (await primary.state()).head);
      assert.equal(reviewed.value.completion, undefined);
      assert.ok(reviewed.executionStops.some((stop) => stop.stage === "placement" && stop.reason === "cancelled"));
      assert.equal((await primary.state()).terminal, null);
    } finally {
      held.close();
    }
    const reacquired = await acquireTargetPlacementFence(scope, "refs/heads/main");
    reacquired.close();
  });

  test("completion retains a stopped Verification without letting it block an unverified Contract", async () => {
    const repository = repositoryWithMain();
    const bound = await Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: document("exit 0"),
      workspace: "worktree",
      gates: [],
    });
    const state = await bound.keiyaku.state();
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
    mkdirSync(join(worktree, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(worktree, ".keiyaku", "settings.json"),
      JSON.stringify({
        worktree: {
          create: [{ name: "reject-candidate", argv: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 5_000 }],
        },
      }),
    );
    repository.run(["-C", worktree, "add", "candidate.txt", ".keiyaku/settings.json"]);
    repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);

    const delivered = await bound.keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const verification = delivered.value.verification;
    assert.ok(verification !== undefined && "failure" in verification);
    assert.equal(verification.failure, "environment-failure");
    assert.ok(delivered.value.completion);
    assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  });

  test("fatal post-admission errors retain their identity and real journal receipts", async () => {
    const { repository, contract, state } = await fixture();
    const scope = await cachedRepositoryAt(repository.path),
      original = new TypeError("injected trailing bug");
    let caught: unknown;
    try {
      await withContractExecution(
        { scope, contractId: state.id, hooks: EMPTY_WORKTREE_HOOKS },
        "review",
        async (context) => {
          requireLeadingAdmission(await admitReviewOperation({ ...context, verdict: "unsatisfied" }));
          throw original;
        },
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, original);
    const receipt = executionReceipt(caught);
    assert.ok(receipt);
    assert.equal(receipt.operation, "review");
    assert.equal(receipt.head, (await contract.state()).head);
    assert.deepEqual(
      receipt.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    assert.deepEqual(
      (await contract.history()).events
        .filter((event) => event.source === "journal" && event.fact.kind === "attestation")
        .map((event) => (event.source === "journal" ? event.fact.entry : null)),
      receipt.facts.map((fact) => fact.entry),
    );
  });

  test("diamond continuation revisits unready candidates and admits each dependent only once", async () => {
    const { repository, contract: primary, state } = await fixture();
    const repo = await Repo.at({ path: repository.path });
    const child = async (title: string, after: readonly ContractId[]) =>
      (
        await Keiyaku.bind({
          repo,
          markdown: document().replace("# Library verbs", `# ${title}`),
          workspace: "worktree",
          gates: [],
          after,
        })
      ).keiyaku;
    const left = await child("Diamond a", [state.id]),
      right = await child("Diamond b", [state.id]);
    const leftId = (await left.state()).id,
      rightId = (await right.state()).id;
    const leaf = await child("Diamond leaf", [leftId, rightId]),
      leafId = (await leaf.state()).id;
    await left.deliver();
    await right.deliver();
    await leaf.deliver();
    await primary.deliver();
    const reviewed = await primary.review({ verdict: "satisfied" });
    assert.deepEqual(reviewed.value.continuation?.claimed, [leftId, rightId, leafId]);
    assert.deepEqual(reviewed.value.continuation?.stopped, []);
    assert.equal(reviewed.facts.filter((fact) => fact.contract === leafId && fact.kind === "claimed").length, 1);
    assert.equal(reviewed.head, (await primary.state()).head);
    assert.equal((await leaf.state()).terminal?.kind, "claimed");
  });

  test("cancellation during an unknown Git publication recovers its receipt with independent read custody", async () => {
    const { repository, contract, state } = await fixture();
    const marker = join(repository.path, "publication-confirmed"),
      controller = new AbortController();
    const result = await withGitShim(
      [
        'if [ "$1" = "update-ref" ]; then',
        '  input_file=$(mktemp); cat > "$input_file"',
        '  "$KEIYAKU_REAL_GIT" "$@" < "$input_file" || exit "$?"',
        '  rm -f "$input_file"; touch "$CONFIRMED_MARKER"',
        "  while :; do sleep 1; done",
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { CONFIRMED_MARKER: marker },
      async (gitPath) => {
        const pending = executeLocalReview({
          scope: await cachedRepositoryAt(repository.path, gitPath),
          contractId: state.id,
          verdict: "satisfied",
          signal: controller.signal,
          hooks: EMPTY_WORKTREE_HOOKS,
        });
        try {
          await waitForFile(marker);
        } finally {
          controller.abort(new Error("cancel after physical publication"));
        }
        return await pending;
      },
    );
    assert.equal(result.operation, "review");
    assert.deepEqual(
      result.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    assert.equal(result.head, (await contract.state()).head);
    assert.equal((await contract.state()).attestations.length, 1);
    assert.equal((await contract.state()).terminal, null);
    assert.ok(result.executionStops.some((stop) => stop.reason === "cancelled"));
  });
});
