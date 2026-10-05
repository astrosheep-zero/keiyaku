import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  captureWorktreeFiles,
  restoreWorktreeFiles,
  snapshotGitRepository,
} from "./support/git.js";
import { bind, commitCandidate, document, repositoryWithMain, present, accepted } from "./support/library-verbs.js";

// Bind once for setup, then give every scenario independent refs, files and worktree.
// The behavior under test (review, delivery, cancellation, completion) is never cached.
async function candidateTemplate() {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const state = present(await contract.state());
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
  const contract = Keiyaku.with().select({ repo: await cachedRepoAt(repository.path), id: prepared.id });
  const state = present(await contract.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  repository.run(["worktree", "add", "--quiet", "--detach", worktree, prepared.candidate]);
  repository.run(["update-ref", "-d", "refs/heads/test-completion-template"]);
  restoreWorktreeFiles(worktree, prepared.generated);
  return { repository, contract, state, worktree };
}


// These tests exercise the real admission boundary, not a synthetic accepted object.
import { createKeiyakuHandle } from "../src/library/keiyaku.js";
import { captureLocalContractComposition } from "../src/library/contract-settings.js";
import { localExecutionContext } from "../src/akuma/requests.js";
import { KeiyakuError } from "../src/library/outcome.js";
import { acquireTargetPlacementFence } from "../src/git/target-placement.js";
import { withGitShim } from "./support/git.js";
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
    const delivered = accepted(await contract.deliver());
    assert.ok(delivered.kind === "accepted", "expected delivered.kind = \"accepted\"");
    assert.equal(delivered.value.completion, undefined);
    assert.deepEqual(
      delivered.facts.map((fact) => fact.kind),
      ["deliver"],
    );
    const review = accepted(await contract.review({ verdict: "satisfied" }));
    assert.deepEqual(
      review.facts.map((fact) => fact.kind),
      ["attestation", "claimed"],
    );
    assert.ok(review.value.completion);
    assert.equal(review.head, (present(await contract.state())).head);
  });

  test("review cancellation after admission stops fenced placement and retains the real receipt", async () => {
    const repository = repositoryWithMain();
    const primary = (
      accepted(await Keiyaku.with().bind({
        repo: await Repo.at({ path: repository.path }),
        markdown: document(),
        target: "refs/heads/main",
        workspace: "worktree",
        gates: ["reviewed"],
      }))
    ).value.keiyaku;
    const state = present(await primary.state());
    await primary.deliver();
    const scope = await cachedRepositoryAt(repository.path);
    const held = await acquireTargetPlacementFence(scope, "refs/heads/main");
    const committed = deferred(),
      controller = new AbortController();
    try {
      const native = createKeiyakuHandle(state.id, { ...scope, onPrivateStateSeatClose: committed.resolve }, localExecutionContext(), captureLocalContractComposition());
      const pending = native.review({ verdict: "satisfied", signal: controller.signal });
      await committed.promise;
      controller.abort(new Error("cancel review after its receipt"));
      const reviewed = accepted(await pending);
      assert.deepEqual(
        reviewed.facts.map((fact) => fact.kind),
        ["attestation"],
      );
      assert.equal(reviewed.head, (present(await primary.state())).head);
      assert.equal(reviewed.value.completion, undefined);
      assert.ok(reviewed.effects.some((stop) => stop.kind === "execution-stopped" && stop.stage === "placement" && stop.reason === "cancelled"));
      assert.equal((present(await primary.state())).terminal, null);
    } finally {
      held.close();
    }
    const reacquired = await acquireTargetPlacementFence(scope, "refs/heads/main");
    reacquired.close();
  });

  test("completion retains a stopped Verification without letting it block an unverified Contract", async () => {
    const repository = repositoryWithMain();
    const bound = accepted(await Keiyaku.with().bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: document("exit 0"),
      workspace: "worktree",
      gates: [],
    }));
    const state = present(await bound.value.keiyaku.state());
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

    const delivered = accepted(await bound.value.keiyaku.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const verification = delivered.value.verification;
    assert.ok(verification !== undefined && "failure" in verification);
    assert.equal(verification.failure, "environment-failure");
    assert.ok(delivered.value.completion);
    assert.equal((present(await bound.value.keiyaku.state())).terminal?.kind, "claimed");
  });

  test("fatal post-admission errors retain their identity and real journal receipts", async () => {
    const { repository, contract, state } = await fixture();
    const scope = await cachedRepositoryAt(repository.path),
      original = new TypeError("injected trailing bug");
    let armed = false;
    const native = createKeiyakuHandle(state.id, { ...scope,
      onPrivateStateSeatClose: () => { armed = true; },
      get gitPath(): string { if (armed) throw original; return scope.gitPath; },
    }, localExecutionContext(), captureLocalContractComposition());
    let caught: unknown;
    try { await native.review({ verdict: "unsatisfied" }); }
    catch (error) { caught = error; }
    assert.ok(caught instanceof KeiyakuError);
    assert.equal(caught.category, "internal");
    assert.equal(caught.cause, original);
    const receipt = caught.outcome;

    assert.ok(receipt);
    assert.ok(receipt.operation === "review");
    assert.equal(receipt.head, (present(await contract.state())).head);
    assert.deepEqual(
      receipt.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    assert.deepEqual(
      present(await contract.history()).events
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
        accepted(await Keiyaku.with().bind({
          repo,
          markdown: document().replace("# Library verbs", `# ${title}`),
          workspace: "worktree",
          gates: [],
          after,
        }))
      ).value.keiyaku;
    const left = await child("Diamond a", [state.id]),
      right = await child("Diamond b", [state.id]);
    const leftId = (present(await left.state())).id,
      rightId = (present(await right.state())).id;
    const leaf = await child("Diamond leaf", [leftId, rightId]),
      leafId = (present(await leaf.state())).id;
    await left.deliver();
    await right.deliver();
    await leaf.deliver();
    await primary.deliver();
    const reviewed = accepted(await primary.review({ verdict: "satisfied" }));
    assert.deepEqual(reviewed.value.continuation?.claimed, [leftId, rightId, leafId]);
    assert.deepEqual(reviewed.value.continuation?.stopped, []);
    assert.equal(reviewed.facts.filter((fact) => fact.contract === leafId && fact.kind === "claimed").length, 1);
    assert.equal(reviewed.head, (present(await primary.state())).head);
    assert.equal((present(await leaf.state())).terminal?.kind, "claimed");
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
        const native = createKeiyakuHandle(state.id, await cachedRepositoryAt(repository.path, gitPath), localExecutionContext(), captureLocalContractComposition());
        const pending = native.review({ verdict: "satisfied", signal: controller.signal });
        try {
          await waitForFile(marker);
        } finally {
          controller.abort(new Error("cancel after physical publication"));
        }
        return accepted(await pending);
      },
    );
    assert.equal(result.operation, "review");
    assert.deepEqual(
      result.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    assert.equal(result.head, (present(await contract.state())).head);
    assert.equal((present(await contract.state())).attestations.length, 1);
    assert.equal((present(await contract.state())).terminal, null);
    assert.ok(result.effects.some((stop) => stop.kind === "execution-stopped" && stop.reason === "cancelled"));
  });
});
