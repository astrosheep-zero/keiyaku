import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { Keis, Repo } from "../src/index.js";
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
  const contract = Keis.of(await cachedRepoAt(repository.path)).kei({ id: prepared.id });
  const state = present(await contract.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  repository.run(["worktree", "add", "--quiet", "--detach", worktree, prepared.candidate]);
  repository.run(["update-ref", "-d", "refs/heads/test-completion-template"]);
  restoreWorktreeFiles(worktree, prepared.generated);
  return { repository, contract, state, worktree };
}

// These tests exercise the real admission boundary, not a synthetic accepted object.
import { createKeiHandle } from "../src/library/kei.js";
import { captureLocalContractComposition } from "../src/library/contract-settings.js";
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
    assert.ok(delivered.kind === "accepted", 'expected delivered.kind = "accepted"');
    assert.notEqual(delivered.placement?.kind, "placed");
    assert.equal(delivered.admission, undefined);
    const review = accepted(await contract.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.equal(present(await contract.state()).attestations.length, 1);
    assert.ok(review.placement?.kind === "placed");
    assert.equal(present(await contract.state()).terminal?.kind, "claimed");
  });

  test("review cancellation after admission stops fenced placement and retains the real receipt", async () => {
    const repository = repositoryWithMain();
    const primary = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: document(),
        target: "refs/heads/main",
        gates: ["reviewed"],
      }),
    ).kei;
    const state = present(await primary.state());
    await primary.deliver();
    const scope = await cachedRepositoryAt(repository.path);
    const held = await acquireTargetPlacementFence(scope, "refs/heads/main");
    const committed = deferred(),
      controller = new AbortController();
    try {
      const native = createKeiHandle(state.id, { ...scope, onPrivateStateSeatClose: committed.resolve }, captureLocalContractComposition());
      const pending = native.review({ verdict: "satisfied", summary: "Completion review passed", signal: controller.signal });
      await committed.promise;
      controller.abort(new Error("cancel review after its receipt"));
      const reviewed = accepted(await pending);
      assert.equal(present(await primary.state()).attestations.length, 1);
      assert.notEqual(reviewed.placement?.kind, "placed");
      assert.ok(
        reviewed.issues?.some(
          (stop) => stop.kind === "execution-stopped" && stop.reason === "cancelled",
        ),
      );
      assert.equal(present(await primary.state()).terminal, null);
    } finally {
      held.close();
    }
    const reacquired = await acquireTargetPlacementFence(scope, "refs/heads/main");
    reacquired.close();
  });

  test("dependent continuation skips ungated Verification", async () => {
    const { repository, contract: primary, state: prerequisite } = await fixture();
    const bound = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: document("exit 1"),
        gates: [],
        // Continuation fixtures stay targetless like their prerequisite.
        target: null,
        after: [prerequisite.id],
      }),
    );
    const state = present(await bound.kei.state());
    const delivered = accepted(await bound.kei.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.ok(delivered.placement?.kind === "prerequisites-unsatisfied");
    assert.equal(delivered.placement.unmet[0]?.state, "active");
    assert.equal(present(await bound.kei.state()).terminal, null);
    await primary.deliver();
    const reviewed = accepted(await primary.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.deepEqual(reviewed.continuation?.claimed, [state.id], JSON.stringify(reviewed.continuation));
    assert.deepEqual(reviewed.continuation?.stopped, undefined);
    const final = present(await bound.kei.state());
    assert.deepEqual(final.attestations, []);
    assert.equal(final.terminal?.kind, "claimed");
  });

  test("delivery, review, target refresh and redelivery consume evidence without executing Verification", async () => {
    const repository = repositoryWithMain();
    const marker = join(repository.path, ".git", "verification-ran");
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: document(`touch '${marker}'`),
        target: "refs/heads/main",
        gates: ["reviewed", "verified"],
      }),
    ).kei;
    const state = present(await contract.state());
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    commitCandidate(repository, worktree);
    const delivered = accepted(await contract.deliver());
    assert.equal(delivered.admission, undefined);
    writeFileSync(join(repository.path, "target-only.txt"), "target movement\n");
    repository.run(["add", "target-only.txt"]);
    repository.run(["commit", "--quiet", "-m", "move target"]);
    const reviewed = accepted(await contract.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.equal(present(await contract.state()).attestations.length, 1);
    const refreshed = present(await contract.state());
    assert.notEqual(refreshed.currentIntegration?.snapshot, delivered.integration);
    assert.ok(reviewed.placement?.kind === "gates-unsatisfied");
    assert.equal(reviewed.placement.unmet[0]?.state, "missing");
    const repeated = accepted(await contract.deliver());
    assert.equal(repeated.admission, "reused");
    assert.equal(repeated.candidate, delivered.candidate);
    assert.equal(present(await contract.state()).currentIntegration?.snapshot, refreshed.currentIntegration?.snapshot);
    const overwritten = accepted(await contract.deliver({ overwrite: true }));
    assert.equal(overwritten.admission, undefined);
    assert.equal(existsSync(marker), false);
    assert.equal(
      present(await contract.state()).attestations.filter((entry) => entry.data.gate === "verified").length,
      0,
    );
  });

  test("dependent continuation leaves missing Verification pending without executing it", async () => {
    const { repository, contract: primary, state: prerequisite } = await fixture();
    const marker = join(repository.path, ".git", "dependent-verification-ran");
    const dependent = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: document(`touch '${marker}'`),
        gates: ["verified"],
        target: null,
        after: [prerequisite.id],
      }),
    ).kei;
    const delivered = accepted(await dependent.deliver());
    assert.equal(delivered.admission, undefined);
    await primary.deliver();
    const reviewed = accepted(await primary.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.deepEqual(reviewed.continuation?.claimed, undefined);
    const stopped = reviewed.continuation?.stopped?.[0];
    assert.equal(stopped?.contractId, present(await dependent.state()).id);
    assert.equal(stopped?.stop.kind, "gates-unsatisfied");
    assert.equal(existsSync(marker), false);
    assert.deepEqual(present(await dependent.state()).attestations, []);
    assert.equal(present(await dependent.state()).terminal, null);
  });

  test("pre-delivery Verification remains current in preview and unchanged later delivery", async () => {
    const repository = repositoryWithMain();
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: document("exit 0"),
        gates: ["verified"],
      }),
    ).kei;
    const verified = accepted(await contract.verify());
    const verifiedState = present(await contract.state());
    assert.equal(verifiedState.delivery, null);
    assert.equal(verifiedState.attestations.length, 1);
    const preview = await contract.previewDelivery();
    assert.ok(preview.kind === "ready");
    assert.equal(preview.integration, verified.snapshot);
    assert.equal(preview.unmetGates, undefined);
    const delivered = accepted(await contract.deliver({ message: "deliver already verified bytes" }));
    assert.equal(delivered.integration, verified.snapshot);
    assert.equal(delivered.admission, undefined);
    assert.ok(delivered.placement?.kind === "placed");
  });

  test("preview exposes every current requirement after selected unsatisfied Verification", async () => {
    const repository = repositoryWithMain();
    const markdown = document("exit 1") + "\n~~~bash timeout=5m\nexit 0\n~~~\n";
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown,
        gates: ["verified"],
      }),
    ).kei;
    accepted(await contract.verify({ index: 1 }));
    const preview = await contract.previewDelivery();
    assert.ok(preview.kind === "ready");
    assert.deepEqual(
      preview.unmetGates?.map((report) => ({
        requirement: report.requirement,
        kind: report.state,
      })),
      [
        { requirement: present(await contract.state()).terms.requirements["verified"]![0], kind: "unsatisfied" },
        { requirement: present(await contract.state()).terms.requirements["verified"]![1], kind: "missing" },
      ],
    );
    const before = present(await contract.state());
    const delivered = accepted(await contract.deliver());
    const repeated = accepted(await contract.deliver());
    assert.equal(delivered.admission, undefined);
    assert.equal(repeated.admission, "reused");
    assert.equal(repeated.candidate, delivered.candidate);
    assert.deepEqual(present(await contract.state()).attestations, before.attestations);
  });

  test("Verification of a moved target supplies the exact snapshot for completion reintegration", async () => {
    const repository = repositoryWithMain();
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: document("exit 0"),
        gates: ["reviewed", "verified"],
      }),
    ).kei;
    const state = present(await contract.state());
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    commitCandidate(repository, worktree);
    const delivered = accepted(await contract.deliver({ message: "original delivery message" }));
    const first = accepted(await contract.verify());
    assert.notEqual(first.placement?.kind, "placed");
    writeFileSync(join(repository.path, "target-only.txt"), "target movement\n");
    repository.run(["add", "target-only.txt"]);
    repository.run(["commit", "--quiet", "-m", "move target"]);
    const second = accepted(await contract.verify());
    assert.notEqual(second.snapshot, delivered.integration);
    assert.ok(second.placement?.kind === "gates-unsatisfied");
    assert.equal(second.placement.unmet.some(({ gate }) => gate === "verified"), false);
    assert.equal(present(await contract.state()).currentIntegration?.snapshot, second.snapshot);
    const reviewed = accepted(await contract.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.ok(reviewed.placement?.kind === "placed");
    assert.equal(reviewed.placement.integration, second.snapshot);
    const attestations = present(await contract.state()).attestations.filter((entry) => entry.data.gate === "verified");
    assert.equal(attestations.length, 2);
    assert.notEqual(attestations[0]?.data.subject, attestations[1]?.data.subject);
  });

  test("dirty targetless pre-delivery Verification survives a later delivery note", async () => {
    const repository = repositoryWithMain();
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: document("exit 0"),
        gates: ["verified"],
        target: null,
      }),
    ).kei;
    const state = present(await contract.state());
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    commitCandidate(repository, worktree);
    writeFileSync(join(worktree, "dirty.txt"), "captured bytes\n");
    const verified = accepted(await contract.verify({ includeDirty: true }));
    const delivered = accepted(await contract.deliver({ includeDirty: true, message: "a different delivery note" }));
    assert.equal(delivered.integration, verified.snapshot);
    assert.ok(delivered.placement?.kind === "placed");
  });

  test("fatal post-admission errors retain their identity and real journal receipts", async () => {
    const { repository, contract, state } = await fixture();
    const scope = await cachedRepositoryAt(repository.path),
      original = new TypeError("injected trailing bug");
    let armed = false;
    const native = createKeiHandle(state.id, { ...scope,
      onPrivateStateSeatClose: () => { armed = true; },
      get gitPath(): string { if (armed) throw original; return scope.gitPath; },
    }, captureLocalContractComposition());
    let caught: unknown;
    try {
      await native.review({ verdict: "unsatisfied", summary: "Completion review found an issue" });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof KeiyakuError);
    assert.equal(caught.category, "internal");
    assert.equal(caught.cause, original);
    const receipt = caught.outcome;

    assert.ok(receipt?.kind === "contract");
    assert.equal(receipt.contractId, state.id);
    assert.deepEqual(receipt.admitted?.map(({ kind }) => kind), ["attestation"]);
    const history = await contract.history({ full: true });
    assert.ok(history.kind === "contract");
    const attestations = history.events.filter((event) => event.kind === "attestation");
    assert.equal(attestations.length, 1);
    assert.equal(attestations[0]?.gate, "reviewed");
    assert.equal(attestations[0]?.verdict, "unsatisfied");
    assert.equal(receipt.admitted?.length, 1);
  });

  test("diamond continuation revisits unready candidates and admits each dependent only once", async () => {
    const { repository, contract: primary, state } = await fixture();
    const repo = await Repo.at({ path: repository.path });
    const child = async (title: string, after: readonly ContractId[]) =>
      accepted(
        await Keis.of(repo).bind({
          markdown: document().replace("# Library verbs", `# ${title}`),
          gates: [],
          // Continuation fixtures stay targetless like their prerequisite.
          target: null,
          after,
        }),
      ).kei;
    const left = await child("Diamond a", [state.id]),
      right = await child("Diamond b", [state.id]);
    const leftId = present(await left.state()).id,
      rightId = present(await right.state()).id;
    const leaf = await child("Diamond leaf", [leftId, rightId]),
      leafId = present(await leaf.state()).id;
    await left.deliver();
    await right.deliver();
    await leaf.deliver();
    await primary.deliver();
    const reviewed = accepted(await primary.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.deepEqual(reviewed.continuation?.claimed, [leftId, rightId, leafId]);
    assert.deepEqual(reviewed.continuation?.stopped, undefined);
    assert.equal(reviewed.continuation?.claimed?.filter((id) => id === leafId).length, 1);
    assert.equal(present(await primary.state()).terminal?.kind, "claimed");
    assert.equal(present(await leaf.state()).terminal?.kind, "claimed");
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
        const native = createKeiHandle(state.id, await cachedRepositoryAt(repository.path, gitPath), captureLocalContractComposition());
        const pending = native.review({ verdict: "satisfied", summary: "Completion review passed", signal: controller.signal });
        try {
          await waitForFile(marker);
        } finally {
          controller.abort(new Error("cancel after physical publication"));
        }
        return accepted(await pending);
      },
    );
    assert.equal(result.contractId, state.id);
    assert.equal(present(await contract.state()).attestations.length, 1);
    assert.equal(present(await contract.state()).terminal, null);
    assert.ok(result.issues?.some((stop) => stop.kind === "execution-stopped" && stop.reason === "cancelled"));
  });
});
