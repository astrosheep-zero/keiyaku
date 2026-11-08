import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test, { describe } from "node:test";
import { Keis, Repo } from "../src/index.js";
import type { ReviewOutcome, VerifyOutcome } from "../src/index.js";
import { renderAccepted } from "../src/cli/render/contract.js";
import { renderContractHistory } from "../src/cli/render/contract-history.js";
import { renderReconcile } from "../src/cli/render/reconcile.js";
import type { ReconcileCompletion, RepoReconcileReport } from "../src/library/reconcile.js";
import { cliJson } from "./support/cli-fixtures.js";
import { appointedWorktreePath, cachedRepositoryAt, withGitShim } from "./support/git.js";
import { document, repositoryWithMain, present, accepted } from "./support/library-verbs.js";

/** A committed candidate whose configured scratch setup always fails, producing a Verification runtime stop. */
function runtimeStopSettings(): string {
  return JSON.stringify({
    worktree: {
      create: [{ name: "reject-candidate", argv: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 5_000 }],
    },
  });
}

async function bindAndCommit(options: {
  gates: readonly string[];
  verification: string;
  runtimeStop?: boolean;
  target?: string;
}) {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      markdown: document(options.verification),
      workspace: "worktree",
      gates: options.gates,
      // These lifecycle fixtures are targetless unless a case names a target.
      target: options.target ?? null,
    }),
  );
  const state = present(await bound.value.kei.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  const paths = ["candidate.txt"];
  if (options.runtimeStop === true) {
    mkdirSync(join(worktree, ".keiyaku"), { recursive: true });
    writeFileSync(join(worktree, ".keiyaku", "settings.json"), runtimeStopSettings());
    paths.push(".keiyaku/settings.json");
  }
  repository.run(["-C", worktree, "add", ...paths]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  return { repository, keiyaku: bound.value.kei, state };
}

function assertNoVerification(value: { completion?: object | undefined; verification?: unknown }): void {
  assert.equal(Object.hasOwn(value, "verification"), false);
  assert.equal(Object.hasOwn(value.completion ?? {}, "verification"), false);
}

function assertRuntimeStop(value: unknown): void {
  assert.ok(
    value !== null && typeof value === "object" && "kind" in value && value.kind === "stopped" && "stop" in value,
  );
  assert.equal((value.stop as { failure: unknown }).failure, "environment-failure");
}

describe("review actor testimony", () => {
  test("local CLI review records actor testimony with and without an enclosing Akuma identity", async () => {
    const { repository, keiyaku, state } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 0" });
    for (const { flags, environment, actor } of [
      { flags: ["--actor", "operator"], environment: { KEIYAKU_ACTOR_ID: "default-actor" }, actor: "operator" },
      { flags: [], environment: { KEIYAKU_ACTOR_ID: "default-actor" }, actor: "default-actor" },
      { flags: [], environment: {}, actor: undefined },
      {
        flags: [],
        environment: { KEIYAKU_ACTOR_ID: "aku/worker/f0d0a002", KEIYAKU_ACTOR_WORLD: repository.path },
        actor: "aku/worker/f0d0a002",
      },
    ]) {
      const reviewed = await cliJson<ReviewOutcome>(
        ["-C", repository.path, "review", state.id, "--satisfied", "--summary", "ok", ...flags],
        { environment },
      );
      assert.equal(reviewed.exit, 0, reviewed.stderr);
      const result = accepted(reviewed.value);
      const attestation = result.facts.find((fact) => fact.kind === "attestation" && fact.data.gate === "reviewed");
      assert.ok(attestation);
      assert.equal(attestation.actor, actor);
      assert.equal(Object.hasOwn(attestation, "actor"), actor !== undefined);
      assert.deepEqual(present(await keiyaku.state()).attestations.at(-1), attestation);
    }
    const history = present(await keiyaku.history());
    assert.match(renderContractHistory(history, { full: true }), / · operator/u);
    assert.match(renderContractHistory(history, { full: true }), / · default-actor/u);
  });

});

describe("contract-lifecycle verification blocking", { concurrency: 3 }, () => {
  test("ungated failing Verification never runs and claim proceeds", async () => {
    const { keiyaku } = await bindAndCommit({ gates: [], verification: "exit 1" });
    const delivered = accepted(await keiyaku.deliver());
    assertNoVerification(delivered.value);
    assert.deepEqual(
      delivered.facts.map((fact) => fact.kind),
      ["deliver", "claimed"],
    );
    const state = present(await keiyaku.state());
    assert.deepEqual(state.attestations, []);
    assert.equal(state.terminal?.kind, "claimed");
  });

  test("ungated Verification never attempts scratch setup that would stop execution", async () => {
    const { keiyaku } = await bindAndCommit({ gates: [], verification: "exit 0", runtimeStop: true });
    const delivered = accepted(await keiyaku.deliver());
    assertNoVerification(delivered.value);
    assert.deepEqual(
      delivered.facts.map((fact) => fact.kind),
      ["deliver", "claimed"],
    );
    const state = present(await keiyaku.state());
    assert.deepEqual(state.attestations, []);
    assert.equal(state.terminal?.kind, "claimed");
  });

  test("reviewed is independent of a failing Verification", async () => {
    const { keiyaku, state } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 1" });
    const delivered = accepted(await keiyaku.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.value.placement;
    assert.ok(placement !== undefined && "refusal" in placement);
    assert.equal(placement.refusal.kind, "gates-unsatisfied");
    if (placement.refusal.kind === "gates-unsatisfied") {
      assert.deepEqual(
        placement.refusal.unmet.map(({ gate }) => gate),
        ["reviewed"],
      );
      assert.equal(placement.refusal.unmet[0]?.requirements[0]?.current.kind, "missing");
      assert.equal(placement.refusal.contractId, state.id);
    }
    assert.equal(present(await keiyaku.state()).terminal, null);

    const reviewed = accepted(await keiyaku.review({ verdict: "satisfied" }));
    assert.equal(reviewed.kind, "accepted");
    assert.equal(present(await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("a refused placement on a targeted Contract names the reference it attempted", async () => {
    const { keiyaku } = await bindAndCommit({
      gates: ["reviewed"],
      verification: "exit 0",
      target: "refs/heads/main",
    });
    const delivered = accepted(await keiyaku.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.value.placement;
    assert.ok(placement !== undefined && "refusal" in placement);
    assert.equal(placement.refusal.kind, "gates-unsatisfied");
    if (placement.refusal.kind === "gates-unsatisfied") assert.equal(placement.refusal.target, "refs/heads/main");
  });

  test("verified blocks an unsatisfied Verification", async () => {
    const { keiyaku, state } = await bindAndCommit({ gates: ["verified"], verification: "exit 1" });
    const verified: VerifyOutcome = await keiyaku.verify();
    const check = accepted(verified).value.checks[0];
    assert.ok(check?.kind === "terminal");
    assert.equal(check.verdict, "unsatisfied");
    assert.equal(check.admission.kind, "admitted");
    const delivered = accepted(await keiyaku.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.value.placement;
    assert.ok(placement !== undefined && "refusal" in placement);
    assert.equal(placement.refusal.kind, "gates-unsatisfied");
    if (placement.refusal.kind === "gates-unsatisfied") {
      assert.deepEqual(
        placement.refusal.unmet.map((report) => report.gate),
        ["verified"],
      );
      assert.equal(state.id, placement.refusal.contractId);
    }
    assert.equal(present(await keiyaku.state()).terminal, null);
  });

  test("delivery leaves missing evidence pending and explicit verify reports its setup stop", async () => {
    const { keiyaku } = await bindAndCommit({ gates: ["verified"], verification: "exit 0", runtimeStop: true });
    const delivered = accepted(await keiyaku.deliver());
    assertNoVerification(delivered.value);
    assert.deepEqual(
      delivered.facts.map(({ kind }) => kind),
      ["deliver"],
    );
    assert.equal(delivered.value.gates?.[0]?.requirements[0]?.current.kind, "missing");
    const verified = accepted(await keiyaku.verify());
    assertRuntimeStop(verified.value.checks[0]);
    assert.deepEqual(verified.facts, []);
    assert.deepEqual(present(await keiyaku.state()).attestations, []);
    assert.equal(present(await keiyaku.state()).terminal, null);
  });

  test("pre-delivery verification captures the snapshot the later delivery and review place", async () => {
    const { keiyaku } = await bindAndCommit({ gates: ["reviewed", "verified"], verification: "exit 0" });
    const verified = accepted(await keiyaku.verify());
    const check = verified.value.checks[0];
    assert.ok(check?.kind === "terminal");
    assert.equal(check.verdict, "satisfied");
    assert.equal(check.admission.kind, "admitted");
    assert.deepEqual(
      verified.facts.map(({ kind }) => kind),
      ["attestation"],
    );
    assert.equal(present(await keiyaku.state()).delivery, null);
    assert.equal(verified.value.completion, undefined);
    const delivered = accepted(await keiyaku.deliver());
    assertNoVerification(delivered.value);
    assert.deepEqual(
      delivered.facts.map(({ kind }) => kind),
      ["deliver"],
    );
    assert.equal(delivered.value.integration.snapshot, check.snapshot);
    assert.equal(delivered.value.gates?.find(({ gate }) => gate === "verified")?.satisfied, true);
    assert.equal(
      delivered.effects.some((effect) => effect.kind === "worktree-retired"),
      false,
    );
    const reviewed = accepted(await keiyaku.review({ verdict: "satisfied" }));
    assertNoVerification(reviewed.value);
    assert.equal(reviewed.value.completion?.integration, check.snapshot);
    assert.equal(present(await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("a terminal acceptance reports the retired appointed worktree", async () => {
    const { repository, keiyaku, state } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 0" });
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    const delivered = accepted(await keiyaku.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.equal(
      delivered.effects.some((effect) => effect.kind === "worktree-retired"),
      false,
      "an active Contract retires nothing",
    );
    const reviewed = accepted(await keiyaku.review({ verdict: "satisfied" }));
    assert.ok(reviewed.kind === "accepted", JSON.stringify(reviewed));
    assert.deepEqual(
      reviewed.effects.find((effect) => effect.kind === "worktree-retired"),
      { kind: "worktree-retired", contract: state.id, name: basename(worktree) },
    );
    assert.equal(present(await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("a terminal removal failure surfaces as retained residue instead of an obituary", async () => {
    const { repository, keiyaku, state } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 0" });
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    const marker = join(repository.path, ".git", "remove-failed-once");
    const shim = [
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ] && [ ! -e "$KEIYAKU_REMOVE_MARKER" ]; then',
      '  : > "$KEIYAKU_REMOVE_MARKER"',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n");
    await withGitShim(shim, { KEIYAKU_REMOVE_MARKER: marker }, async (gitPath) => {
      const delivered = accepted(await keiyaku.deliver());
      assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
      const abandoned = await Keis.of(await Repo.at({ path: repository.path, gitPath }))
        .kei({ id: state.id })
        .abandon();
      assert.ok(abandoned.kind === "accepted", JSON.stringify(abandoned));
      assert.equal(
        abandoned.effects.some((effect) => effect.kind === "worktree-retired"),
        false,
      );
      assert.deepEqual(
        abandoned.effects.find((effect) => effect.kind === "worktree-retained"),
        { kind: "worktree-retained", contract: state.id, path: worktree },
      );
      assert.ok(abandoned.effects.some((effect) => effect.kind === "reconciliation-lag"));
    });
  });

  test("removing verified leaves old testimony in history without exposing it on completion", async () => {
    const { repository, keiyaku } = await bindAndCommit({ gates: ["reviewed", "verified"], verification: "exit 0" });
    accepted(await keiyaku.verify());
    await keiyaku.deliver();
    const before = present(await keiyaku.state()).attestations;
    assert.equal(before.length, 1);
    await keiyaku.amend({ gates: ["reviewed"] });
    const delivered = accepted(await keiyaku.deliver());
    assertNoVerification(delivered.value);
    assert.deepEqual(present(await keiyaku.state()).attestations, before);
    const observed = await Keis.of(await Repo.at({ path: repository.path })).observe({
      id: keiyaku.toJSON().contract,
    });
    assert.ok(observed.kind === "present");
    assert.equal(
      observed.row.gates.reports.some(({ gate }) => gate === "verified"),
      false,
    );
    const audited = accepted(await keiyaku.previewDelivery());
    assert.deepEqual(audited.value.verification, { kind: "undeclared" });
    assert.equal(audited.value.delivery?.relation, "identical");
    const reviewed = accepted(await keiyaku.review({ verdict: "satisfied" }));
    assertNoVerification(reviewed.value);
    assert.equal(present(await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("repeated unsatisfied Verification under verified keeps placement blocked", async () => {
    const verified = await bindAndCommit({ gates: ["verified"], verification: "exit 1" });
    await verified.keiyaku.deliver();
    const first = accepted(await verified.keiyaku.verify());
    const repeated = accepted(await verified.keiyaku.verify());
    const firstCheck = first.value.checks[0];
    const repeatedCheck = repeated.value.checks[0];
    assert.ok(firstCheck?.kind === "terminal" && repeatedCheck?.kind === "terminal");
    assert.ok(firstCheck.admission.kind !== "stopped");
    assert.equal(repeatedCheck.verdict, "unsatisfied");
    assert.deepEqual(repeatedCheck.admission, { kind: "reused", entry: firstCheck.admission.entry });
    const blocked = accepted(await verified.keiyaku.deliver());
    assertNoVerification(blocked.value);
    assert.equal(blocked.value.gates?.[0]?.requirements[0]?.current.kind, "attested");
    assert.equal(present(await verified.keiyaku.state()).terminal, null);
  });

  test("native delivery replaces changed unfinished content without running Verification", async () => {
    const { repository, keiyaku, state } = await bindAndCommit({
      gates: ["reviewed", "verified"],
      verification:
        "node -e \"if (require('node:fs').readFileSync('candidate.txt', 'utf8') !== 'replacement\\\\n') process.exit(1)\"",
      runtimeStop: true,
    });
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    const first = accepted(await keiyaku.deliver());
    const firstFact = first.facts.find((fact) => fact.kind === "deliver");
    assert.ok(firstFact);
    assert.deepEqual(first.value.leading, { kind: "admitted-now", fact: firstFact.entry });
    assertNoVerification(first.value);
    const firstVerification = accepted(await keiyaku.verify());
    assertRuntimeStop(firstVerification.value.checks[0]);
    assert.equal(present(await keiyaku.state()).terminal, null);

    const reused = accepted(await keiyaku.deliver());
    assert.deepEqual(reused.value.leading, { kind: "already-admitted", fact: firstFact.entry });
    assert.deepEqual(reused.value.integration, first.value.integration);
    assert.equal(reused.value.contentChange, undefined);
    assertNoVerification(reused.value);
    assert.deepEqual(reused.facts.filter((fact) => fact.kind === "deliver"), []);

    writeFileSync(join(worktree, "candidate.txt"), "replacement\n");
    writeFileSync(join(worktree, ".keiyaku", "settings.json"), "{}\n");
    repository.run(["-C", worktree, "add", "candidate.txt", ".keiyaku/settings.json"]);
    repository.run(["-C", worktree, "commit", "--quiet", "-m", "replacement"]);

    const replaced = accepted(await keiyaku.deliver());
    const replacedFacts = replaced.facts.filter((fact) => fact.kind === "deliver");
    assert.equal(replacedFacts.length, 1);
    assert.notEqual(replaced.value.leading.fact, firstFact.entry);
    assert.deepEqual(replaced.value.leading, { kind: "admitted-now", fact: replacedFacts[0]!.entry });
    const current = present(await keiyaku.state());
    assert.equal(current.delivery?.entry, replaced.value.leading.fact);
    assert.notEqual(current.delivery?.data.tenderSnapshot, first.value.tenderSnapshot);
    const integration = current.delivery?.data.integration;
    assert.ok(integration);
    assert.notEqual(integration.changeId, first.value.integration.changeId);
    assert.deepEqual(replaced.value.contentChange, {
      kind: "candidate-content-changed",
      previousChange: first.value.integration.changeId,
      currentChange: integration.changeId,
    });
    assertNoVerification(replaced.value);
    assert.deepEqual(current.attestations, []);
    const verified = accepted(await keiyaku.verify());
    assert.equal(verified.value.snapshot, integration.snapshot);
    assert.ok(verified.value.checks[0]?.kind === "terminal");
    assert.equal(verified.value.checks[0].verdict, "satisfied");
    const text = renderAccepted(replaced);
    assert.match(text, /candidate-content-changed/u);
    assert.ok(text.includes(`previous ${first.value.integration.changeId.slice(0, 7)}`), text);
    assert.ok(text.includes(`current ${integration.changeId.slice(0, 7)}`), text);
    assert.equal(current.terminal, null);
  });

  test("unfinished candidate reuse refuses unauthorized dirty content", async () => {
    const { repository, keiyaku, state } = await bindAndCommit({
      gates: ["verified"],
      verification: "exit 0",
      runtimeStop: true,
    });
    const first = accepted(await keiyaku.deliver());
    assertNoVerification(first.value);
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    writeFileSync(join(worktree, "candidate.txt"), "dirty replacement\n");

    const refused = await keiyaku.deliver();
    assert.equal(refused.kind, "refused");
    assert.ok(refused.kind === "refused");
    assert.equal(refused.refusal.kind, "dirty-workspace");
    assert.equal(present(await keiyaku.state()).delivery?.entry, first.value.leading.fact);
  });

  test("an unchanged native delivery continues without a new delivery fact", async () => {
    const { keiyaku } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 0" });
    const first = accepted(await keiyaku.deliver());
    const firstFact = first.facts.find((fact) => fact.kind === "deliver");
    assert.ok(firstFact);
    assert.deepEqual(first.value.leading, { kind: "admitted-now", fact: firstFact.entry });

    const second = accepted(await keiyaku.deliver());
    assert.deepEqual(second.value.leading, { kind: "already-admitted", fact: firstFact.entry });
    assert.deepEqual(second.facts.filter((fact) => fact.kind === "deliver"), []);
  });
});

function cliJsonAt<Value>(cwd: string, argv: readonly string[]) {
  return cliJson<Value>(["-C", cwd, ...argv], { environment: {}, readStdin: async () => "" });
}

/** A committed candidate that changes one path of a target checkout whose other tracked files stay clean. */
async function targetedCheckoutBinding(files: Readonly<Record<string, string>>, changedPath: string) {
  const repository = repositoryWithMain({ files });
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      markdown: document(),
      workspace: "worktree",
      gates: ["reviewed"],
      target: "refs/heads/main",
    }),
  );
  const state = present(await bound.value.kei.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(join(worktree, changedPath), "candidate\n");
  repository.run(["-C", worktree, "add", changedPath]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await bound.value.kei.deliver();
  return { repository, state, worktree };
}

describe("dirty target checkout placement", () => {
  test("an overlapping uncommitted edit never vetoes acceptance, and reconcile carries the checkout forward", async () => {
    const { repository, state } = await targetedCheckoutBinding({ "target.txt": "base\n" }, "target.txt");
    writeFileSync(join(repository.path, "target.txt"), "local work in progress\n");

    const reviewed = (
      await cliJsonAt<ReviewOutcome>(repository.path, ["review", state.id, "--satisfied", "--summary", "ok"])
    ).value;
    assert.ok(reviewed.kind === "accepted", JSON.stringify(reviewed));
    if (reviewed.kind !== "accepted") throw new Error("review was refused");
    const text = renderAccepted(reviewed, { columns: repository.path.length + 100, color: false });
    assert.match(text, /^✓ review satisfied  /mu);
    assert.match(text, /^✓ accepted$/mu);
    assert.match(text, /^  worktree  .+ retired$/mu);
    assert.doesNotMatch(text, /target-checkout-retained/u);
    assert.ok(text.split("\n").includes(`! lag  checkout behind  ${repository.path}  · refs/heads/main`), text);
    // Force wrapping independently of the host's temporary-directory length.
    const lines = renderAccepted(reviewed, { columns: 25, color: false }).split("\n");
    const lagStart = lines.indexOf("! lag  checkout behind");
    assert.notEqual(lagStart, -1, text);
    assert.deepEqual(lines.slice(lagStart, lagStart + 3), [
      "! lag  checkout behind",
      `  ${repository.path}`,
      "  · refs/heads/main",
    ]);
    const landed = repository.run(["rev-parse", "refs/heads/main"]).trim();
    assert.equal(readFileSync(join(repository.path, "target.txt"), "utf8"), "local work in progress\n");

    repository.run(["-C", repository.path, "checkout", "--", "target.txt"]);
    const reconciled = (await cliJsonAt<ReconcileCompletion | RepoReconcileReport>(repository.path, ["reconcile"]))
      .value;
    const reconcileLines = renderReconcile(reconciled, { columns: 40, color: false }).split("\n");
    const recoveredStart = reconcileLines.indexOf("  effect  target-checkout  recovered");
    assert.notEqual(recoveredStart, -1, renderReconcile(reconciled));
    assert.equal(reconcileLines[recoveredStart + 1], `  ${repository.path}`);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), landed);
    assert.equal(readFileSync(join(repository.path, "target.txt"), "utf8"), "candidate\n");
  });

  test("an uncommitted edit outside the movement follows silently", async () => {
    const { repository, state } = await targetedCheckoutBinding(
      { "target.txt": "base\n", "other.txt": "base\n" },
      "target.txt",
    );
    writeFileSync(join(repository.path, "other.txt"), "unrelated local work\n");

    const reviewed = (
      await cliJsonAt<ReviewOutcome>(repository.path, ["review", state.id, "--satisfied", "--summary", "ok"])
    ).value;
    assert.ok(reviewed.kind === "accepted", JSON.stringify(reviewed));
    if (reviewed.kind !== "accepted") throw new Error("review was refused");
    assert.equal(
      (reviewed.effects as readonly { kind: string }[]).some((effect) => effect.kind === "checkout-retained"),
      false,
    );
    assert.doesNotMatch(renderAccepted(reviewed, { columns: 100, color: false }), /checkout behind/u);
    assert.equal(readFileSync(join(repository.path, "other.txt"), "utf8"), "unrelated local work\n");
    assert.equal(readFileSync(join(repository.path, "target.txt"), "utf8"), "candidate\n");
  });
});
