import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  const state = present(await bound.kei.state());
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
  return { repository, keiyaku: bound.kei, state };
}

function assertRuntimeStop(value: unknown): void {
  assert.ok(value !== null && typeof value === "object" && "kind" in value);
  assert.equal(value.kind, "environment-hook-failure");
  assert.ok("name" in value);
  assert.equal(value.name, "reject-candidate");
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
      accepted(reviewed.value);
      const attestation = present(await keiyaku.state()).attestations.at(-1);
      assert.ok(attestation);
      assert.equal(attestation.actor, actor);
      assert.equal(Object.hasOwn(attestation, "actor"), actor !== undefined);
      assert.deepEqual(present(await keiyaku.state()).attestations.at(-1), attestation);
    }
    const history = await keiyaku.history({ full: true });
    assert.ok(history.kind === "contract");
    assert.match(renderContractHistory(history, { full: true }), / · operator/u);
    assert.match(renderContractHistory(history, { full: true }), / · default-actor/u);
  });

});

describe("contract-lifecycle verification blocking", { concurrency: 3 }, () => {
  test("ungated failing Verification never runs and claim proceeds", async () => {
    const { keiyaku } = await bindAndCommit({ gates: [], verification: "exit 1" });
    const delivered = accepted(await keiyaku.deliver());

    assert.equal(delivered.placement?.kind, "placed");
    const state = present(await keiyaku.state());
    assert.deepEqual(state.attestations, []);
    assert.equal(state.terminal?.kind, "claimed");
  });

  test("ungated Verification never attempts scratch setup that would stop execution", async () => {
    const { keiyaku } = await bindAndCommit({ gates: [], verification: "exit 0", runtimeStop: true });
    const delivered = accepted(await keiyaku.deliver());

    assert.equal(delivered.placement?.kind, "placed");
    const state = present(await keiyaku.state());
    assert.deepEqual(state.attestations, []);
    assert.equal(state.terminal?.kind, "claimed");
  });

  test("reviewed is independent of a failing Verification", async () => {
    const { keiyaku, state } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 1" });
    const delivered = accepted(await keiyaku.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.placement;
    assert.ok(placement?.kind === "gates-unsatisfied");
    assert.deepEqual(
      placement.unmet.map(({ gate }) => gate),
      ["reviewed"],
    );
    assert.equal(placement.unmet[0]?.state, "missing");
    assert.equal(delivered.contractId, state.id);
    assert.equal(present(await keiyaku.state()).terminal, null);

    const reviewed = accepted(await keiyaku.review({ verdict: "satisfied", summary: "Lifecycle review passed" }));
    assert.equal(reviewed.kind, "accepted");
    assert.equal(present(await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("a targeted Contract with unmet gates stops before placement", async () => {
    const { keiyaku } = await bindAndCommit({
      gates: ["reviewed"],
      verification: "exit 0",
      target: "refs/heads/main",
    });
    const delivered = accepted(await keiyaku.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.placement;
    assert.ok(placement?.kind === "gates-unsatisfied");
    assert.deepEqual(placement.unmet.map(({ gate }) => gate), ["reviewed"]);
  });

  test("verified blocks an unsatisfied Verification", async () => {
    const { keiyaku, state } = await bindAndCommit({ gates: ["verified"], verification: "exit 1" });
    const verified: VerifyOutcome = await keiyaku.verify();
    const check = accepted(verified).checks[0];
    assert.ok(check?.kind === "terminal");
    assert.equal(check.verdict, "unsatisfied");
    assert.equal(check.admission, undefined);
    const delivered = accepted(await keiyaku.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.placement;
    assert.ok(placement?.kind === "gates-unsatisfied");
    assert.deepEqual(
      placement.unmet.map((report) => report.gate),
      ["verified"],
    );
    assert.equal(state.id, delivered.contractId);
    assert.equal(present(await keiyaku.state()).terminal, null);
  });

  test("delivery leaves missing evidence pending and explicit verify reports its setup stop", async () => {
    const { keiyaku } = await bindAndCommit({ gates: ["verified"], verification: "exit 0", runtimeStop: true });
    const delivered = accepted(await keiyaku.deliver());

    assert.equal(delivered.admission, undefined);
    assert.ok(delivered.placement?.kind === "gates-unsatisfied");
    assert.equal(delivered.placement.unmet[0]?.state, "missing");
    const verified = accepted(await keiyaku.verify());
    assertRuntimeStop(verified.checks[0]);
    assert.deepEqual(present(await keiyaku.state()).attestations, []);
    assert.equal(present(await keiyaku.state()).terminal, null);
  });

  test("pre-delivery verification captures the snapshot the later delivery and review place", async () => {
    const { keiyaku } = await bindAndCommit({ gates: ["reviewed", "verified"], verification: "exit 0" });
    const verified = accepted(await keiyaku.verify());
    const check = verified.checks[0];
    assert.ok(check?.kind === "terminal");
    assert.equal(check.verdict, "satisfied");
    assert.equal(check.admission, undefined);
    assert.equal(present(await keiyaku.state()).attestations.length, 1);
    assert.equal(present(await keiyaku.state()).delivery, null);
    assert.equal(verified.placement?.kind, "delivery-missing");
    const delivered = accepted(await keiyaku.deliver());

    assert.equal(delivered.admission, undefined);
    assert.equal(delivered.integration, verified.snapshot);
    assert.ok(delivered.placement?.kind === "gates-unsatisfied");
    assert.equal(delivered.placement.unmet.some(({ gate }) => gate === "verified"), false);
    const reviewed = accepted(await keiyaku.review({ verdict: "satisfied", summary: "Lifecycle review passed" }));

    assert.ok(reviewed.placement?.kind === "placed");
    assert.equal(reviewed.placement.integration, verified.snapshot);
    assert.equal(present(await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("a terminal acceptance reports the retired appointed worktree", async () => {
    const { repository, keiyaku, state } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 0" });
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    const delivered = accepted(await keiyaku.deliver());
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.ok(existsSync(worktree), "an active Contract retires nothing");
    const reviewed = accepted(await keiyaku.review({ verdict: "satisfied", summary: "Lifecycle review passed" }));
    assert.ok(reviewed.kind === "accepted", JSON.stringify(reviewed));
    assert.equal(reviewed.placement?.kind, "placed");
    assert.equal(existsSync(worktree), false);
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
      assert.ok(existsSync(worktree));
      const retained = abandoned.issues?.find((effect) => effect.kind === "worktree-retained");
      assert.equal(retained?.kind, "worktree-retained");
      assert.equal(retained?.path, worktree);
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
    assert.equal(delivered.admission, "reused");
    assert.deepEqual(present(await keiyaku.state()).attestations, before);
    const observed = await Keis.of(await Repo.at({ path: repository.path })).observe({
      id: keiyaku.toJSON().contract,
    });
    assert.ok(observed.kind === "present");
    assert.equal(
      observed.row.gates?.some(({ gate }) => gate === "verified"),
      false,
    );
    const audited = await keiyaku.previewDelivery();
    assert.ok(audited.kind === "ready");
    assert.equal(audited.unmetGates?.some(({ gate }) => gate === "verified"), false);
    assert.equal(audited.previousContentId, undefined);
    const reviewed = accepted(await keiyaku.review({ verdict: "satisfied", summary: "Lifecycle review passed" }));
    assert.equal(reviewed.placement?.kind, "placed");
    assert.equal(present(await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("repeated unsatisfied Verification under verified keeps placement blocked", async () => {
    const verified = await bindAndCommit({ gates: ["verified"], verification: "exit 1" });
    await verified.keiyaku.deliver();
    const first = accepted(await verified.keiyaku.verify());
    const repeated = accepted(await verified.keiyaku.verify());
    const firstCheck = first.checks[0];
    const repeatedCheck = repeated.checks[0];
    assert.ok(firstCheck?.kind === "terminal" && repeatedCheck?.kind === "terminal");
    assert.equal(firstCheck.admission, undefined);
    assert.equal(repeatedCheck.verdict, "unsatisfied");
    assert.equal(repeatedCheck.admission, "reused");
    const blocked = accepted(await verified.keiyaku.deliver());

    assert.ok(blocked.placement?.kind === "gates-unsatisfied");
    assert.equal(blocked.placement.unmet[0]?.state, "unsatisfied");
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
    const firstEntry = present(await keiyaku.state()).delivery!.entry;
    assert.equal(first.admission, undefined);

    const firstVerification = accepted(await keiyaku.verify());
    assertRuntimeStop(firstVerification.checks[0]);
    assert.equal(present(await keiyaku.state()).terminal, null);

    const reused = accepted(await keiyaku.deliver());
    assert.equal(reused.admission, "reused");
    assert.equal(present(await keiyaku.state()).delivery?.entry, firstEntry);
    assert.deepEqual(reused.integration, first.integration);
    assert.equal(reused.previousContentId, undefined);


    writeFileSync(join(worktree, "candidate.txt"), "replacement\n");
    writeFileSync(join(worktree, ".keiyaku", "settings.json"), "{}\n");
    repository.run(["-C", worktree, "add", "candidate.txt", ".keiyaku/settings.json"]);
    repository.run(["-C", worktree, "commit", "--quiet", "-m", "replacement"]);

    const replaced = accepted(await keiyaku.deliver());
    assert.equal(replaced.admission, undefined);
    const current = present(await keiyaku.state());
    assert.notEqual(current.delivery?.entry, firstEntry);
    assert.notEqual(current.delivery?.data.tenderSnapshot, first.candidate);
    const integration = current.delivery?.data.integration;
    assert.ok(integration);
    assert.notEqual(integration.changeId, first.contentId);
    assert.equal(replaced.previousContentId, first.contentId);

    assert.deepEqual(current.attestations, []);
    const verified = accepted(await keiyaku.verify());
    assert.equal(verified.snapshot, integration.snapshot);
    assert.ok(verified.checks[0]?.kind === "terminal");
    assert.equal(verified.checks[0].verdict, "satisfied");
    assert.equal(current.terminal, null);
  });

  test("unfinished candidate reuse refuses unauthorized dirty content", async () => {
    const { repository, keiyaku, state } = await bindAndCommit({
      gates: ["verified"],
      verification: "exit 0",
      runtimeStop: true,
    });
    accepted(await keiyaku.deliver());
    const firstEntry = present(await keiyaku.state()).delivery!.entry;
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    writeFileSync(join(worktree, "candidate.txt"), "dirty replacement\n");

    const refused = await keiyaku.deliver();
    assert.equal(refused.kind, "refused");
    assert.ok(refused.kind === "refused");
    assert.equal(refused.reason.kind, "dirty-workspace");
    assert.equal(present(await keiyaku.state()).delivery?.entry, firstEntry);
  });

  test("an unchanged native delivery continues without a new delivery fact", async () => {
    const { keiyaku } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 0" });
    const first = accepted(await keiyaku.deliver());
    const firstEntry = present(await keiyaku.state()).delivery!.entry;
    assert.equal(first.admission, undefined);

    const second = accepted(await keiyaku.deliver());
    assert.equal(second.admission, "reused");
    assert.equal(present(await keiyaku.state()).delivery?.entry, firstEntry);
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
  const state = present(await bound.kei.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(join(worktree, changedPath), "candidate\n");
  repository.run(["-C", worktree, "add", changedPath]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await bound.kei.deliver();
  return { repository, state, worktree };
}

describe("dirty target checkout placement", () => {
  test("an overlapping uncommitted edit never vetoes acceptance, and reconcile carries the checkout forward", async () => {
    const { repository, state, worktree } = await targetedCheckoutBinding({ "target.txt": "base\n" }, "target.txt");
    writeFileSync(join(repository.path, "target.txt"), "local work in progress\n");

    const reviewed = (
      await cliJsonAt<ReviewOutcome>(repository.path, ["review", state.id, "--satisfied", "--summary", "ok"])
    ).value;
    assert.ok(reviewed.kind === "accepted", JSON.stringify(reviewed));
    if (reviewed.kind !== "accepted") throw new Error("review was refused");
    const text = renderAccepted("review", reviewed, { columns: repository.path.length + 100, color: false }, { verdict: "satisfied" });
    assert.match(text, /^✓ review satisfied  /mu);
    assert.match(text, /^✓ accepted$/mu);
    assert.equal(existsSync(worktree), false);
    assert.doesNotMatch(text, /target-checkout-retained/u);
    assert.ok(text.split("\n").includes(`! lag  checkout behind  ${repository.path}  · refs/heads/main`), text);
    // Force wrapping independently of the host's temporary-directory length.
    const lines = renderAccepted("review", reviewed, { columns: 25, color: false }, { verdict: "satisfied" }).split("\n");
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
    assert.ok(reconciled.kind === "world");
    assert.ok(reconciled.contracts?.some((contract) => contract.effects?.some((effect) =>
      effect.kind === "target-checkout" && effect.path === repository.path && effect.target === "refs/heads/main")));
    const reconcileText = renderReconcile(reconciled, { columns: 40, color: false });
    assert.match(reconcileText.replace(/\s+/gu, " "), /target checkout/u);
    assert.ok(reconcileText.includes(repository.path));
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
      reviewed.issues?.some((issue) => issue.kind === "target-checkout-retained") ?? false,
      false,
    );
    assert.doesNotMatch(renderAccepted("review", reviewed, { columns: 100, color: false }, { verdict: "satisfied" }), /checkout behind/u);
    assert.equal(readFileSync(join(repository.path, "other.txt"), "utf8"), "unrelated local work\n");
    assert.equal(readFileSync(join(repository.path, "target.txt"), "utf8"), "candidate\n");
  });
});
