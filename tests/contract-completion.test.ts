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
    assert.equal(delivered.value.completion, undefined);
    assert.deepEqual(
      delivered.facts.map((fact) => fact.kind),
      ["deliver"],
    );
    const review = accepted(await contract.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.deepEqual(
      review.facts.map((fact) => fact.kind),
      ["attestation", "claimed"],
    );
    assert.ok(review.value.completion);
    assert.equal(review.head, present(await contract.state()).head);
  });

  test("review cancellation after admission stops fenced placement and retains the real receipt", async () => {
    const repository = repositoryWithMain();
    const primary = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: document(),
        target: "refs/heads/main",
        workspace: "worktree",
        gates: ["reviewed"],
      }),
    ).value.kei;
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
      assert.deepEqual(
        reviewed.facts.map((fact) => fact.kind),
        ["attestation"],
      );
      assert.equal(reviewed.head, present(await primary.state()).head);
      assert.equal(reviewed.value.completion, undefined);
      assert.ok(
        reviewed.effects.some(
          (stop) => stop.kind === "execution-stopped" && stop.stage === "placement" && stop.reason === "cancelled",
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
        workspace: "worktree",
        gates: [],
        // Continuation fixtures stay targetless like their prerequisite.
        target: null,
        after: [prerequisite.id],
      }),
    );
    const state = present(await bound.value.kei.state());
    const delivered = accepted(await bound.value.kei.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.deepEqual(delivered.value.gates, []);
    assert.equal(present(await bound.value.kei.state()).terminal, null);
    await primary.deliver();
    const reviewed = accepted(await primary.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.deepEqual(reviewed.value.continuation?.claimed, [state.id], JSON.stringify(reviewed.value.continuation));
    assert.deepEqual(reviewed.value.continuation?.stopped, []);
    const final = present(await bound.value.kei.state());
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
    ).value.kei;
    const state = present(await contract.state());
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    commitCandidate(repository, worktree);
    const delivered = accepted(await contract.deliver());
    assert.deepEqual(
      delivered.facts.map((fact) => fact.kind),
      ["deliver"],
    );
    writeFileSync(join(repository.path, "target-only.txt"), "target movement\n");
    repository.run(["add", "target-only.txt"]);
    repository.run(["commit", "--quiet", "-m", "move target"]);
    const reviewed = accepted(await contract.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.deepEqual(
      reviewed.facts.map((fact) => fact.kind),
      ["attestation", "reintegrated"],
    );
    const refreshed = present(await contract.state());
    assert.notEqual(refreshed.currentIntegration?.snapshot, delivered.value.integration.snapshot);
    assert.equal(reviewed.value.gates?.find((report) => report.gate === "verified")?.requirements[0]?.current.kind, "missing");
    const repeated = accepted(await contract.deliver());
    assert.deepEqual(repeated.facts, []);
    assert.deepEqual(repeated.value.leading, { kind: "already-admitted", fact: delivered.value.leading.fact });
    assert.equal(present(await contract.state()).currentIntegration?.snapshot, refreshed.currentIntegration?.snapshot);
    const overwritten = accepted(await contract.deliver({ overwrite: true }));
    assert.deepEqual(
      overwritten.facts.map((fact) => fact.kind),
      ["deliver"],
    );
    assert.equal(overwritten.value.leading.kind, "admitted-now");
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
    ).value.kei;
    const delivered = accepted(await dependent.deliver());
    assert.deepEqual(
      delivered.facts.map((fact) => fact.kind),
      ["deliver"],
    );
    await primary.deliver();
    const reviewed = accepted(await primary.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.deepEqual(reviewed.value.continuation?.claimed, []);
    const stopped = reviewed.value.continuation?.stopped[0];
    assert.equal(stopped?.contractId, present(await dependent.state()).id);
    assert.ok(stopped && "refusal" in stopped.stop);
    assert.equal(stopped.stop.refusal.kind, "gates-unsatisfied");
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
    ).value.kei;
    const verified = accepted(await contract.verify());
    const verifiedState = present(await contract.state());
    assert.equal(verifiedState.delivery, null);
    assert.deepEqual(
      verified.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    const preview = accepted(await contract.previewDelivery());
    assert.ok(preview.value.candidate.kind === "ready");
    assert.equal(preview.value.candidate.identity.integration.snapshot, verified.value.snapshot);
    assert.ok(preview.value.verification.kind === "requirements");
    assert.equal(preview.value.verification.requirements.length, 1);
    assert.equal(preview.value.verification.requirements[0]!.index, 1);
    assert.equal(preview.value.verification.requirements[0]!.current.kind, "attested");
    const delivered = accepted(await contract.deliver({ message: "deliver already verified bytes" }));
    assert.equal(delivered.value.integration.snapshot, verified.value.snapshot);
    assert.deepEqual(
      delivered.facts.map((fact) => fact.kind),
      ["deliver", "claimed"],
    );
    assert.ok(delivered.value.completion);
  });

  test("preview exposes every current requirement after selected unsatisfied Verification", async () => {
    const repository = repositoryWithMain();
    const markdown = document("exit 1") + "\n~~~bash timeout=5m\nexit 0\n~~~\n";
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown,
        gates: ["verified"],
      }),
    ).value.kei;
    accepted(await contract.verify({ index: 1 }));
    const preview = accepted(await contract.previewDelivery());
    assert.ok(preview.value.verification.kind === "requirements");
    assert.deepEqual(
      preview.value.verification.requirements.map((report) => ({
        index: report.index,
        kind: report.current.kind,
        verdict: report.current.kind === "attested" ? report.current.verdict : undefined,
      })),
      [
        { index: 1, kind: "attested", verdict: "unsatisfied" },
        { index: 2, kind: "missing", verdict: undefined },
      ],
    );
    assert.ok(preview.value.candidate.kind === "ready");
    assert.equal(preview.value.candidate.requirements.gates[0]!.satisfied, false);
    const before = present(await contract.state());
    const delivered = accepted(await contract.deliver());
    const repeated = accepted(await contract.deliver());
    assert.deepEqual(
      delivered.facts.map((fact) => fact.kind),
      ["deliver"],
    );
    assert.deepEqual(repeated.facts, []);
    assert.deepEqual(repeated.value.leading, { kind: "already-admitted", fact: delivered.value.leading.fact });
    assert.deepEqual(present(await contract.state()).attestations, before.attestations);
  });

  test("Verification of a moved target supplies the exact snapshot for completion reintegration", async () => {
    const repository = repositoryWithMain();
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: document("exit 0"),
        gates: ["reviewed", "verified"],
      }),
    ).value.kei;
    const state = present(await contract.state());
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    commitCandidate(repository, worktree);
    const delivered = accepted(await contract.deliver({ message: "original delivery message" }));
    const first = accepted(await contract.verify());
    assert.equal(first.value.completion, undefined);
    writeFileSync(join(repository.path, "target-only.txt"), "target movement\n");
    repository.run(["add", "target-only.txt"]);
    repository.run(["commit", "--quiet", "-m", "move target"]);
    const second = accepted(await contract.verify());
    assert.notEqual(second.value.snapshot, delivered.value.integration.snapshot);
    assert.equal(second.value.gates?.find((report) => report.gate === "verified")?.satisfied, true);
    assert.equal(present(await contract.state()).currentIntegration?.snapshot, second.value.snapshot);
    const reviewed = accepted(await contract.review({ verdict: "satisfied", summary: "Completion review passed" }));
    assert.ok(reviewed.value.completion);
    assert.equal(reviewed.value.completion.integration, second.value.snapshot);
    assert.deepEqual(
      present(await contract.state())
        .attestations.filter((entry) => entry.data.gate === "verified")
        .map((entry) => entry.entry),
      [...first.facts, ...second.facts].filter((entry) => entry.kind === "attestation").map((entry) => entry.entry),
    );
  });

  test("dirty targetless pre-delivery Verification survives a later delivery note", async () => {
    const repository = repositoryWithMain();
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: document("exit 0"),
        gates: ["verified"],
        target: null,
      }),
    ).value.kei;
    const state = present(await contract.state());
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    commitCandidate(repository, worktree);
    writeFileSync(join(worktree, "dirty.txt"), "captured bytes\n");
    const verified = accepted(await contract.verify({ includeDirty: true }));
    const delivered = accepted(await contract.deliver({ includeDirty: true, message: "a different delivery note" }));
    assert.equal(delivered.value.integration.snapshot, verified.value.snapshot);
    assert.ok(delivered.value.completion);
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

    assert.ok(receipt);
    assert.ok(receipt.operation === "review");
    assert.equal(receipt.head, present(await contract.state()).head);
    assert.deepEqual(
      receipt.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    assert.deepEqual(
      present(await contract.history())
        .events.filter((event) => event.source === "journal" && event.fact.kind === "attestation")
        .map((event) => (event.source === "journal" ? event.fact.entry : null)),
      receipt.facts.map((fact) => fact.entry),
    );
  });

  test("diamond continuation revisits unready candidates and admits each dependent only once", async () => {
    const { repository, contract: primary, state } = await fixture();
    const repo = await Repo.at({ path: repository.path });
    const child = async (title: string, after: readonly ContractId[]) =>
      accepted(
        await Keis.of(repo).bind({
          markdown: document().replace("# Library verbs", `# ${title}`),
          workspace: "worktree",
          gates: [],
          // Continuation fixtures stay targetless like their prerequisite.
          target: null,
          after,
        }),
      ).value.kei;
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
    assert.deepEqual(reviewed.value.continuation?.claimed, [leftId, rightId, leafId]);
    assert.deepEqual(reviewed.value.continuation?.stopped, []);
    assert.equal(reviewed.facts.filter((fact) => fact.contract === leafId && fact.kind === "claimed").length, 1);
    assert.equal(reviewed.head, present(await primary.state()).head);
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
    assert.equal(result.operation, "review");
    assert.deepEqual(
      result.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    assert.equal(result.head, present(await contract.state()).head);
    assert.equal(present(await contract.state()).attestations.length, 1);
    assert.equal(present(await contract.state()).terminal, null);
    assert.ok(result.effects.some((stop) => stop.kind === "execution-stopped" && stop.reason === "cancelled"));
  });
});
