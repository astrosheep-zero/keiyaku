import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { Keis, Settings } from "../src/index.js";
import { cachedRepoAt } from "./support/git.js";
import { commitCandidate, document, repositoryWithMain, present, accepted } from "./support/library-verbs.js";

// Each case owns a separate repository and scoped fault injection, never a process-wide mock.
describe("contract-completion isolated repositories", { concurrency: 4 }, () => {
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
});
