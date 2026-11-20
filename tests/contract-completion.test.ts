import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { Keis, Repo, Settings, type Kei } from "../src/index.js";
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
        terms: document(),
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
      assert.equal(reviewed.placement?.kind, "execution-stopped");
      assert.equal(reviewed.placement.reason, "cancelled");
      assert.ok(reviewed.placement.diagnostic);
      assert.equal(present(await primary.state()).terminal, null);
    } finally {
      held.close();
    }
    const reacquired = await acquireTargetPlacementFence(scope, "refs/heads/main");
    reacquired.close();
  });

  for (const when of ["without dependents", "after a child's claim"] as const) {
    test(`review reports traversal cancellation as an issue ${when}`, async () => {
      const { repository, contract: primary, state } = await fixture();
      const child =
        when === "without dependents"
          ? undefined
          : accepted(
              await Keis.of(await Repo.at({ path: repository.path })).bind({
                terms: document(),
                target: null,
                gates: [],
                after: [state.id],
              }),
            );
      if (child !== undefined) accepted(await child.kei.deliver());
      const delivered = accepted(await primary.deliver());
      const controller = new AbortController();
      const reason = new Error("cancel continuation traversal");
      const reviewed = accepted(
        await primary.review(
          { verdict: "satisfied", summary: "Release the prerequisite", signal: controller.signal },
          {
            observe: (event) => {
              if (event.kind !== "stage") return;
              const atBoundary =
                child === undefined
                  ? event.stage === "continuation" && event.state === "started"
                  : event.stage === "placement" && event.state === "finished" && event.contractId === child.contractId;
              if (atBoundary) controller.abort(reason);
            },
          },
        ),
      );
      assert.deepEqual(reviewed.placement, { kind: "placed", integration: delivered.integration });
      assert.deepEqual(reviewed.continuation, child === undefined ? undefined : { claimed: [child.contractId] });
      // A claimed child may also have its own, independently cancelled reconciliation.
      assert.deepEqual(
        reviewed.issues?.filter(({ kind, contractId }) => kind === "execution-stopped" && contractId === undefined),
        [{ kind: "execution-stopped", severity: "required", reason: "cancelled", diagnostic: reason.message }],
      );
      assert.equal(present(await primary.state()).terminal?.kind, "claimed");
      if (child !== undefined) assert.equal(present(await child.kei.state()).terminal?.kind, "claimed");
    });
  }

  test("dependent continuation skips ungated Verification", async () => {
    const { repository, contract: primary, state: prerequisite } = await fixture();
    const bound = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        terms: document("exit 1"),
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

  test("dependent physical lag stops completion before any claim attempt", async () => {
    const { repository, contract: primary, state } = await fixture();
    const dependent = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        terms: document(),
        gates: [],
        target: null,
        after: [state.id],
      }),
    );
    const child = present(await dependent.kei.state());
    assert.equal(accepted(await dependent.kei.deliver()).placement?.kind, "prerequisites-unsatisfied");
    const localEdit = join(dependent.worktreePath!, "local-edit");
    writeFileSync(localEdit, "keep this edit\n");
    await primary.deliver();
    const reviewed = accepted(await primary.review({ verdict: "satisfied", summary: "Release the prerequisite" }));
    assert.equal(reviewed.placement?.kind, "placed");
    assert.deepEqual(reviewed.continuation, { stopped: [{ contractId: child.id, stop: { kind: "physical-lag" } }] });
    assert.equal(present(await dependent.kei.state()).terminal, null);
    assert.equal(readFileSync(localEdit, "utf8"), "keep this edit\n");
  });

  test("delivery, review, target refresh and redelivery consume evidence without executing Verification", async () => {
    const repository = repositoryWithMain();
    const marker = join(repository.path, ".git", "verification-ran");
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        terms: document(`touch '${marker}'`),
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

  test("late target movement refreshes before considering an old strict red gate", async () => {
    const repository = repositoryWithMain();
    mkdirSync(join(repository.path, ".keiyaku"));
    writeFileSync(join(repository.path, ".keiyaku", "settings.json"), '{"verification":{"mode":"strict"}}');
    const settings = await Settings.load({ cwd: repository.path });
    const { kei: contract, worktreePath } = accepted(await Keis.of(await cachedRepoAt(repository.path), { settings }).bind({
      terms: document("test -f target-only.txt"), target: "main", gates: ["reviewed", "verified"],
    }));
    commitCandidate(repository, worktreePath!);
    const delivered = accepted(await contract.deliver());
    const checked = accepted(await contract.verify());
    const before = present(present(await contract.state()).currentIntegration);
    assert.equal(before.snapshot, delivered.integration);
    assert.equal(checked.snapshot, before.snapshot);
    const check = checked.checks[0];
    assert.ok(check?.kind === "terminal" && check.verdict === "unsatisfied" && check.admission === "admitted");

    const main = () => repository.run(["rev-parse", "refs/heads/main"]).trim();
    let advanced: { oldHead: string; moved: string } | undefined;
    let movementError: unknown;
    const reviewed = accepted(await contract.review({ verdict: "satisfied", summary: "Completion review passed" }, {
      observe(event) {
        if (advanced !== undefined || event.kind !== "stage" || event.stage !== "placement" || event.state !== "started") return;
        try {
          const oldHead = main();
          writeFileSync(join(repository.path, "target-only.txt"), "moved\n");
          repository.run(["add", "target-only.txt"]);
          repository.run(["commit", "--quiet", "-m", "move target at placement start"]);
          advanced = { oldHead, moved: main() };
        } catch (error) { movementError = error; }
      },
    }));
    if (movementError !== undefined) throw movementError;
    assert.ok(advanced);
    const { oldHead, moved } = advanced;
    assert.equal(oldHead, before.predecessor);
    assert.notEqual(moved, oldHead);
    const after = present(await contract.state());
    const integration = present(after.currentIntegration);
    assert.equal(main(), moved);
    assert.equal(after.terminal, null);
    assert.equal(integration.predecessor, moved, "completion must refresh the recorded predecessor");
    assert.equal(repository.run(["rev-parse", `${integration.snapshot}^`]).trim(), moved);
    const history = await contract.history();
    assert.equal(history.kind, "contract");
    assert.equal(history.events.at(-1)?.kind, "reintegrated");
    assert.deepEqual(reviewed.placement, { kind: "gates-unsatisfied", unmet: [{
      gate: "verified", requirement: check.requirement, state: "stale",
      reason: { kind: "snapshot-changed", previousSnapshot: before.snapshot, currentSnapshot: integration.snapshot },
    }] });
  });

  test("pending child refuses a same-path, same-HEAD replacement at review completion", async () => {
    const repository = repositoryWithMain();
    const contracts = Keis.of(await cachedRepoAt(repository.path));
    const parent = accepted(await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }));
    const child = accepted(await contracts.bind({ terms: document(), target: parent.contractId, gates: ["reviewed"] }));
    const path = parent.worktreePath!;
    commitCandidate(repository, child.worktreePath!);
    const delivery = accepted(await child.kei.deliver());
    assert.equal(delivery.placement?.kind, "gates-unsatisfied");
    const pending = present(await child.kei.state());
    const target = pending.coordinates.target;
    assert.ok(typeof target === "object");
    const targetRef = `worktrees/${target.worktree.id}/HEAD`;
    const readRef = (ref: string) => repository.run(["rev-parse", "--verify", ref]).trim();
    const old = readRef(targetRef);
    const main = readRef("refs/heads/main");
    const parentBefore = present(await parent.kei.state()).head;
    const oldStat = statSync(path, { bigint: true });
    assert.equal(old, pending.currentIntegration?.predecessor);
    assert.notEqual(old, delivery.integration);
    repository.run(["worktree", "remove", "--force", path]);
    repository.run(["worktree", "add", "--quiet", "--detach", path, old]);
    const newStat = statSync(path, { bigint: true });
    assert.notDeepEqual([newStat.ino, newStat.birthtimeNs], [oldStat.ino, oldStat.birthtimeNs]);
    assert.equal(readRef(targetRef), old);
    assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), old);
    writeFileSync(join(path, "foreign.txt"), "foreign bytes\n");

    const reviewed = accepted(await child.kei.review({ verdict: "satisfied", summary: "Completion review passed" }));
    const after = present(await child.kei.state());
    assert.equal(readRef("refs/heads/main"), main);
    assert.equal(present(await parent.kei.state()).head, parentBefore);
    assert.equal(readFileSync(join(path, "foreign.txt"), "utf8"), "foreign bytes\n");
    assert.equal(after.attestations.at(-1)?.data.verdict, "satisfied");
    assert.deepEqual(reviewed.placement, {
      kind: "target-workspace-unavailable", targetContractId: parent.contractId, reason: "replaced",
    });
    assert.equal(after.terminal, null);
    assert.equal(readRef(targetRef), old);
    assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), old);
    assert.equal(existsSync(join(path, "candidate.txt")), false);
    const history = await child.kei.history();
    assert.equal(history.kind, "contract");
    assert.equal(history.events.at(-1)?.kind, "attestation");
  });

  test("dependent continuation leaves missing Verification pending without executing it", async () => {
    const { repository, contract: primary, state: prerequisite } = await fixture();
    const marker = join(repository.path, ".git", "dependent-verification-ran");
    const dependent = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        terms: document(`touch '${marker}'`),
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
        terms: document("exit 0"),
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
        terms: markdown,
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

  test("Verification of a moved target executes refreshed bytes while retaining optimistic testimony", async () => {
    const repository = repositoryWithMain();
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        terms: document("exit 0"),
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

  test("optimistic Verification survives target movement through an automatic after continuation cascade", async () => {
    const repository = repositoryWithMain();
    const contracts = Keis.of(await Repo.at({ path: repository.path }));
    const chain: { kei: Kei; id: ContractId; marker: string; snapshot: string }[] = [];
    for (const name of ["primary", "middle", "leaf"]) {
      const marker = join(repository.path, ".git", `${name}-checks`);
      const previous = chain.at(-1);
      const bound = accepted(await contracts.bind({
        terms: document(`printf x >> '${marker}'`),
        target: "main",
        gates: name === "primary" ? ["reviewed", "verified"] : ["verified"],
        after: previous === undefined ? [] : [previous.id],
      }));
      if (name === "primary") {
        const path = bound.worktreePath!;
        writeFileSync(join(path, "primary.txt"), "primary\n");
        repository.run(["-C", path, "add", "primary.txt"]);
        repository.run(["-C", path, "commit", "--quiet", "-m", name]);
      }
      // Sequencing-only dependents can fast-forward their clean worktrees as prerequisites land.
      const verified = accepted(await bound.kei.verify());
      accepted(await bound.kei.deliver());
      chain.push({ kei: bound.kei, id: present(await bound.kei.state()).id, marker, snapshot: verified.snapshot });
    }
    const [primary, middle, leaf] = chain;
    assert.ok(primary && middle && leaf);
    const reviewed = accepted(await primary.kei.review({ verdict: "satisfied", summary: "Release the verified cascade" }));
    assert.equal(reviewed.placement?.kind, "placed");
    assert.deepEqual(reviewed.continuation?.claimed, [middle.id, leaf.id], JSON.stringify(reviewed));
    assert.equal(reviewed.continuation?.stopped, undefined);
    for (const entry of chain) {
      const state = present(await entry.kei.state());
      assert.equal(state.terminal?.kind, "claimed");
      assert.equal(state.attestations.filter(({ data }) => data.gate === "verified").length, 1);
      assert.equal(readFileSync(entry.marker, "utf8"), "x", "continuation never executes Verification");
    }
    assert.notEqual(present(await middle.kei.state()).currentIntegration?.snapshot, middle.snapshot);
    assert.notEqual(present(await leaf.kei.state()).currentIntegration?.snapshot, leaf.snapshot);
    assert.equal(repository.run(["show", "main:primary.txt"]), "primary\n");
  });

  test("dirty targetless pre-delivery Verification survives a later delivery note", async () => {
    const repository = repositoryWithMain();
    const contract = accepted(
      await Keis.of(await Repo.at({ path: repository.path })).bind({
        terms: document("exit 0"),
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
    const history = await contract.history();
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
          terms: document().replace("# Library verbs", `# ${title}`),
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
        '  input_file=$(mktemp "$CONFIRMED_MARKER.XXXXXXXX") || exit; cat > "$input_file"',
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
    assert.deepEqual(result.placement, {
      kind: "execution-stopped",
      reason: "cancelled",
      diagnostic: "cancel after physical publication",
    });
  });
});
