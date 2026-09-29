import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test, { describe } from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import type { InvocationResult } from "../src/cli/result.js";
import { renderText } from "../src/cli/render/text.js";
import { externalRequestCommandsFor } from "../src/akuma-body.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { World } from "../src/world.js";
import { appointedWorktreePath, cachedRepositoryAt, withGitShim } from "./support/git.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

/** A committed candidate whose configured scratch setup always fails, producing a Verification runtime stop. */
function runtimeStopSettings(): string {
  return JSON.stringify({
    worktree: {
      create: [{ name: "reject-candidate", argv: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 5_000 }],
    },
  });
}

async function bindAndCommit(options: { gates: readonly string[]; verification: string; runtimeStop?: boolean; target?: string }) {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(options.verification),
    workspace: "worktree",
    gates: options.gates,
    ...(options.target === undefined ? {} : { target: options.target }),
  });
  const state = await bound.keiyaku.state();
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
  return { repository, keiyaku: bound.keiyaku, state };
}

function assertRuntimeStop(value: unknown): void {
  assert.ok(value !== undefined && typeof value === "object" && "failure" in value);
  assert.equal((value as { failure: unknown }).failure, "environment-failure");
}

/**
 * The production parent-Body contract port, reached through the same entrypoint composition the
 * spawned Body uses. Importing the module must compose commands without launching a Body.
 */
async function forwardedDeliverChannel(repositoryRoot: string) {
  const world = await World.at(repositoryRoot);
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "worker", draw: () => "f0d0a001" });
  const { commands } = await externalRequestCommandsFor({ paths: allocated.paths }, {});
  const command = commands["contract.deliver"];
  if (command === undefined || command.completion !== "service")
    throw new Error("contract.deliver is not a service request command");
  return async (contractId: string, overwrite: boolean) => {
    const request = command.resolve({
      repoRoot: repositoryRoot,
      contractId,
      includeDirty: false,
      materializeConflict: false,
      overwrite,
    });
    assert.ok(request !== null, "forwarded deliver payload is rejected by its owner");
    const served = await request.execute({
      id: randomUUID(),
      admittedAt: "2026-09-28T10:00:00.000Z",
      requester: allocated.id,
      signal: new AbortController().signal,
      admissionOpen: () => true,
    });
    const service = JSON.parse(served.serviceJson) as { kind?: unknown; deliveryFactId?: unknown };
    assert.equal(service.kind, "accepted-reference", served.serviceJson);
    assert.ok(typeof service.deliveryFactId === "string", served.serviceJson);
    return { result: served.result, deliveryFactId: service.deliveryFactId };
  };
}

function acceptedDeliveryValue(result: unknown): Record<string, unknown> {
  assert.ok(result !== null && typeof result === "object");
  const record = result as { kind?: unknown; value?: unknown };
  assert.equal(record.kind, "accepted", JSON.stringify(result));
  assert.ok(record.value !== null && typeof record.value === "object");
  return record.value as Record<string, unknown>;
}

describe("contract-lifecycle verification blocking", { concurrency: 3 }, () => {
  test("no gate does not make a failing Verification an implicit blocker", async () => {
    const { keiyaku } = await bindAndCommit({ gates: [], verification: "exit 1" });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.deepEqual(delivered.value.completion?.verification, { mode: "ran", verdict: "unsatisfied" });
    assert.equal((await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("no gate does not make a stopped Verification an implicit blocker and retains its typed stop", async () => {
    const { keiyaku } = await bindAndCommit({ gates: [], verification: "exit 0", runtimeStop: true });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assertRuntimeStop(delivered.value.verification);
    assert.equal(delivered.value.completion?.verification, undefined);
    assert.equal((await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("reviewed is independent of a failing Verification", async () => {
    const { keiyaku, state } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 1" });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.value.placement;
    assert.ok(placement !== undefined && "refusal" in placement);
    assert.deepEqual(placement.refusal, {
      kind: "gates-unsatisfied",
      contractId: state.id,
      unmet: [{ gate: "reviewed", current: { kind: "missing" } }],
    });
    assert.equal((await keiyaku.state()).terminal, null);

    const reviewed = await keiyaku.review({ verdict: "satisfied" });
    assert.equal(reviewed.kind, "accepted");
    assert.equal((await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("a refused placement on a targeted Contract names the reference it attempted", async () => {
    const { keiyaku } = await bindAndCommit({
      gates: ["reviewed"],
      verification: "exit 0",
      target: "refs/heads/main",
    });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.value.placement;
    assert.ok(placement !== undefined && "refusal" in placement);
    assert.equal(placement.refusal.kind, "gates-unsatisfied");
    if (placement.refusal.kind === "gates-unsatisfied") assert.equal(placement.refusal.target, "refs/heads/main");
  });

  test("verified blocks an unsatisfied Verification", async () => {
    const { keiyaku, state } = await bindAndCommit({ gates: ["verified"], verification: "exit 1" });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.value.placement;
    assert.ok(placement !== undefined && "refusal" in placement);
    assert.equal(placement.refusal.kind, "gates-unsatisfied");
    if (placement.refusal.kind === "gates-unsatisfied") {
      assert.deepEqual(placement.refusal.unmet.map((report) => report.gate), ["verified"]);
      assert.equal(state.id, placement.refusal.contractId);
    }
    assert.equal((await keiyaku.state()).terminal, null);
  });

  test("verified blocks a stopped Verification with its own typed stop", async () => {
    const { keiyaku } = await bindAndCommit({ gates: ["verified"], verification: "exit 0", runtimeStop: true });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assertRuntimeStop(delivered.value.verification);
    assert.equal((await keiyaku.state()).terminal, null);
  });

  test("an unaffected deliver names the verified snapshot the later placement lands", async () => {
    const { keiyaku } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 0" });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.equal(delivered.value.completion, undefined);
    assert.equal(delivered.retiredWorktree, undefined, "an active Contract retires nothing");
    assert.equal((await keiyaku.state()).terminal, null);
    const subject = delivered.value.verificationSubject;
    assert.deepEqual(subject, {
      snapshot: (await keiyaku.state()).currentIntegration?.snapshot,
      mode: "ran",
      verdict: "satisfied",
    });

    const reviewed = await keiyaku.review({ verdict: "satisfied" });
    assert.ok(reviewed.kind === "accepted", JSON.stringify(reviewed));
    assert.equal(reviewed.value.completion?.integration, subject?.snapshot, "the placement names the same id");
  });

  test("a terminal acceptance reports the retired appointed worktree", async () => {
    const { repository, keiyaku, state } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 0" });
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.equal(delivered.retiredWorktree, undefined, "an active Contract retires nothing");
    const reviewed = await keiyaku.review({ verdict: "satisfied" });
    assert.ok(reviewed.kind === "accepted", JSON.stringify(reviewed));
    assert.equal(reviewed.retiredWorktree, basename(worktree));
    assert.equal((await keiyaku.state()).terminal?.kind, "claimed");
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
      const delivered = await keiyaku.deliver();
      assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
      const abandoned = await Keiyaku.with()
        .select({ repo: await Repo.at({ path: repository.path, gitPath }), id: state.id })
        .abandon();
      assert.ok(abandoned.kind === "accepted", JSON.stringify(abandoned));
      assert.equal(abandoned.retiredWorktree, undefined);
      assert.equal(abandoned.retainedWorktree, worktree);
      assert.ok(abandoned.lags.some((lag) => lag.kind === "worktree-retained"));
    });
  });

  test("a reused unsatisfied Verification blocks only when verified is selected", async () => {
    const reviewed = await bindAndCommit({ gates: ["reviewed"], verification: "exit 1" });
    await reviewed.keiyaku.deliver();
    const reused = await reviewed.keiyaku.deliver();
    assert.ok(reused.kind === "accepted", JSON.stringify(reused));
    assert.equal(reused.value.verificationReuse?.verdict, "unsatisfied");
    assert.equal((await reviewed.keiyaku.state()).terminal, null);

    const satisfiedReview = await reviewed.keiyaku.review({ verdict: "satisfied" });
    assert.equal(satisfiedReview.kind, "accepted");
    assert.equal((await reviewed.keiyaku.state()).terminal?.kind, "claimed");

    const verified = await bindAndCommit({ gates: ["verified"], verification: "exit 1" });
    await verified.keiyaku.deliver();
    const blocked = await verified.keiyaku.deliver();
    assert.ok(blocked.kind === "accepted", JSON.stringify(blocked));
    assert.equal(blocked.value.verificationReuse?.verdict, "unsatisfied");
    assert.equal((await verified.keiyaku.state()).terminal, null);
  });

  test("a forwarded deliver carries overwrite through the parent Body port", async () => {
    const { repository, keiyaku, state } = await bindAndCommit({
      gates: ["verified"],
      verification: "exit 0",
      runtimeStop: true,
    });
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    const deliver = await forwardedDeliverChannel(repository.path);

    const first = await deliver(state.id, false);
    const firstValue = acceptedDeliveryValue(first.result);
    assertRuntimeStop(firstValue.verification);
    assert.equal((await keiyaku.state()).terminal, null, "the stopped Verification keeps the Contract nonterminal");

    writeFileSync(join(worktree, "candidate.txt"), "replacement\n");
    repository.run(["-C", worktree, "add", "candidate.txt"]);
    repository.run(["-C", worktree, "commit", "--quiet", "-m", "replacement"]);

    const reused = await deliver(state.id, false);
    assert.equal(reused.deliveryFactId, first.deliveryFactId, "overwrite=false reuses the admitted candidate");
    const reusedValue = acceptedDeliveryValue(reused.result);
    assert.deepEqual(reusedValue.leading, { kind: "already-admitted", fact: first.deliveryFactId });
    assert.deepEqual(reusedValue.integration, firstValue.integration, "overwrite=false keeps the old tender bytes");

    const replaced = await deliver(state.id, true);
    assert.notEqual(replaced.deliveryFactId, first.deliveryFactId, "overwrite=true admits a new deliver fact");
    const replacedValue = acceptedDeliveryValue(replaced.result);
    assert.notDeepEqual(replacedValue.integration, firstValue.integration, "overwrite=true captures the new bytes");
    assert.equal((await keiyaku.state()).terminal, null);
  });
});

function executable(argv: readonly string[]) {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

async function cliResult(cwd: string, argv: readonly string[]): Promise<InvocationResult> {
  return (await invoke(executable(["-C", cwd, ...argv]), {
    environment: {},
    readStdin: async () => "",
  })) as InvocationResult;
}

/** A committed candidate that changes one path of a target checkout whose other tracked files stay clean. */
async function targetedCheckoutBinding(files: Readonly<Record<string, string>>, changedPath: string) {
  const repository = repositoryWithMain({ files });
  const bound = await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    gates: ["reviewed"],
    target: "refs/heads/main",
  });
  const state = await bound.keiyaku.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(join(worktree, changedPath), "candidate\n");
  repository.run(["-C", worktree, "add", changedPath]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await bound.keiyaku.deliver();
  return { repository, state, worktree };
}

describe("dirty target checkout placement", { concurrency: 2 }, () => {
  test("an overlapping uncommitted edit never vetoes acceptance, and reconcile carries the checkout forward", async () => {
    const { repository, state } = await targetedCheckoutBinding({ "target.txt": "base\n" }, "target.txt");
    writeFileSync(join(repository.path, "target.txt"), "local work in progress\n");

    const reviewed = await cliResult(repository.path, ["review", state.id, "--satisfied", "--summary", "ok"]);
    assert.ok(reviewed.kind === "accepted", JSON.stringify(reviewed));
    const text = renderText(reviewed);
    assert.match(text, /^✓ review satisfied  /mu);
    assert.match(text, /^✓ accepted$/mu);
    assert.match(text, /^  worktree  .+ retired$/mu);
    assert.doesNotMatch(text, /target-checkout-retained/u);
    const lines = text.split("\n");
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
    const reconciled = await cliResult(repository.path, ["reconcile"]);
    assert.ok(reconciled.kind === "reconcile", JSON.stringify(reconciled));
    const reconcileLines = renderText(reconciled).split("\n");
    const recoveredStart = reconcileLines.indexOf("  effect  target-checkout  recovered");
    assert.notEqual(recoveredStart, -1, renderText(reconciled));
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

    const reviewed = await cliResult(repository.path, ["review", state.id, "--satisfied", "--summary", "ok"]);
    assert.ok(reviewed.kind === "accepted", JSON.stringify(reviewed));
    assert.equal(reviewed.retainedCheckouts, undefined);
    assert.doesNotMatch(renderText(reviewed), /checkout behind/u);
    assert.equal(readFileSync(join(repository.path, "other.txt"), "utf8"), "unrelated local work\n");
    assert.equal(readFileSync(join(repository.path, "target.txt"), "utf8"), "candidate\n");
  });
});
