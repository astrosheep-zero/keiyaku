import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { renderDiffstat } from "../src/cli/render/akuma-tool.js";
import { renderAccepted } from "../src/cli/render/contract.js";
import { writeExecutionProgress } from "../src/cli/runtime.js";
import {
  Keiyaku,
  Repo,
  type AuditOutcome,
  type DeliverOutcome,
  type ExecutionObservation,
} from "../src/index.js";
import { accepted } from "./support/library-verbs.js";
import type { ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { appointedWorktreePath, makeGitRepository, observeContract } from "./support/git.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { contractMarkdown } from "./support/markdown.js";

function markdown(script: string): string {
  return contractMarkdown("CLI verification", {
    Context: "A CLI result exposes verification owner facts.",
    Objective: "Keep verification and audit adaptation visible.",
    Design: "Invoke the public Contract operation once.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: `### Check\nThe verification runs.\n\n## Verification\n~~~bash timeout=5m\n${script}\n~~~`,
  });
}

async function bindCandidate(script: string, gates: readonly string[] = ["verified"]) {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  mkdirSync(resolve(raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(
    resolve(raw.path, ".keiyaku", "settings.json"),
    JSON.stringify({ gates: { default: { kind: "bundle", gates } } }),
  );
  const bound = await cliJson<Readonly<{ kind: string; contract?: string }>>(
    ["-C", raw.path, "bind", "--target", "refs/heads/main", "-"],
    { environment: {}, readStdin: async () => markdown(script) },
  );
  assert.equal(bound.value.kind, "accepted");
  const id = bound.value.contract as ContractId;
  const repository = await repositoryAt(raw.path);
  const worktree = await appointedWorktreePath(repository, id);
  writeFileSync(resolve(worktree, "candidate.txt"), "candidate\n");
  raw.run(["-C", worktree, "add", "candidate.txt"]);
  raw.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  return { raw, id, worktree };
}

async function bindAndDeliver(script: string, gates: readonly string[] = ["verified"]) {
  const { raw, id } = await bindCandidate(script, gates);
  const delivered = await cliJson<DeliverOutcome>(["-C", raw.path, "deliver", id], {
    environment: { KEIYAKU_ACTOR_ID: "cli-verification-test" },
  });
  return { raw, id, result: delivered.value, stderr: delivered.stderr };
}

test("deliver adapts a successful Verification result through the CLI", async () => {
  const { raw, id, result, stderr } = await bindAndDeliver("printf 'delivery-live-output\\n'");
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("deliver was not accepted");
  assert.deepEqual(
    result.facts.map((fact) => fact.kind),
    ["deliver", "attestation", "claimed"],
  );
  const repository = await repositoryAt(raw.path);
  assert.equal((await observeContract(repository, id)).state?.terminal?.kind, "claimed");
  assert.equal(stderr, "", "JSON carries one native result and no text activity");
});

test("text deliver streams its Verification activity on stderr and keeps the receipt clean", async () => {
  const { raw, id } = await bindCandidate("printf 'delivery-live-output\\n'");
  const delivered = await runCli(["-C", raw.path, "deliver", id], {
    environment: { KEIYAKU_ACTOR_ID: "cli-verification-test" },
  });
  assert.equal(delivered.exit, 0, delivered.stderr);
  assert.doesNotMatch(delivered.stderr, /●/u, "non-TTY progress never prints a phase start");
  assert.match(delivered.stderr, /delivery-live-output/u);
  assert.match(delivered.stderr, /✓ declaration 1\/1/u);
  assert.equal(delivered.stdout.includes("delivery-live-output"), false, "live activity stays out of the receipt");
});

test("a blocked deliver names the verified snapshot and the accepting review lands it", async () => {
  const { raw, id, worktree } = await bindCandidate("printf 'verified-output\\n'", ["reviewed", "verified"]);

  const blocked = (await cliJson<DeliverOutcome>(["-C", raw.path, "deliver", id], { environment: {} })).value;
  assert.equal(blocked.kind, "accepted");
  if (blocked.kind !== "accepted") throw new Error("blocked deliver was not accepted");
  const blockedText = renderAccepted(blocked, { columns: 200, color: false });
  const standalone = /^  integration result  ([0-9a-f]+) · verification satisfied$/mu.exec(blockedText);
  assert.ok(standalone, blockedText);
  assert.doesNotMatch(blockedText, /verification reused/u, "a fresh run carries no qualifier");
  assert.equal((blockedText.match(/integration result/gu) ?? []).length, 1, "no second row repeats the subject");

  const reviewed = (await cliJson<import("../src/index.js").ReviewOutcome>(
    ["-C", raw.path, "review", id, "--satisfied", "--summary", "accepted"],
    { environment: {} },
  )).value;
  assert.equal(reviewed.kind, "accepted");
  if (reviewed.kind !== "accepted") throw new Error("review was not accepted");
  const reviewedText = renderAccepted(reviewed, { columns: 200, color: false });
  const placed = /^  integration result  ([0-9a-f]+) · verification reused satisfied$/mu.exec(reviewedText);
  assert.ok(placed, reviewedText);
  assert.equal(placed[1], standalone[1], "the landing names the id the verdict covered");
  assert.ok(
    reviewedText.split("\n").includes(`  changes  1 file · ${renderDiffstat({ added: 1, removed: 0 })}`),
    "the acceptance names the landed diff's shape",
  );
  assert.ok(reviewedText.endsWith(`  worktree  ${basename(worktree)} retired`), reviewedText);
});

test("a deliver that accepts names the landed diff's shape", async () => {
  const { result } = await bindAndDeliver("printf 'verified-output\\n'");
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("deliver was not accepted");
  const text = renderAccepted(result, { columns: 200, color: false });
  assert.ok(text.split("\n").includes(`  changes  1 file · ${renderDiffstat({ added: 1, removed: 0 })}`));
  assert.equal((text.match(/^  changes /gmu) ?? []).length, 1, "one bounded changes row");
});

test("review refreshes a moved target before an old failed verification blocks placement", async () => {
  const { raw, id, worktree } = await bindCandidate("test -f target-ready", ["reviewed", "verified"]);
  await cliJson<DeliverOutcome>(["-C", raw.path, "deliver", id], { environment: {} });
  const repository = await repositoryAt(raw.path);
  const before = (await observeContract(repository, id)).state!;
  assert.equal(before.attestations.at(-1)?.data.verdict, "unsatisfied");
  const unchanged = await cliJson(["-C", raw.path, "review", id, "--satisfied", "--summary", "reviewed"], { environment: {} });
  assert.equal(unchanged.exit, 0);
  assert.equal((await observeContract(repository, id)).state?.terminal, null);
  writeFileSync(resolve(raw.path, "target-ready"), "ready");
  raw.run(["add", "target-ready"]);
  raw.run(["commit", "--quiet", "-m", "target now supplies prerequisite"]);
  assert.equal(raw.run(["-C", worktree, "ls-files", "target-ready"]), "", "candidate is not manually rebased");
  const reviewed = await cliJson(["-C", raw.path, "review", id, "--satisfied", "--summary", "reviewed"], { environment: {} });
  assert.equal(reviewed.exit, 0);
  const after = (await observeContract(repository, id)).state!;
  assert.equal(after.terminal?.kind, "claimed");
  assert.equal(after.delivery?.entry, before.delivery?.entry, "no replacement delivery required");
  assert.equal(after.currentIntegration?.changeId, before.currentIntegration?.changeId);
  assert.notEqual(after.currentIntegration?.snapshot, before.currentIntegration?.snapshot);
  assert.equal(after.attestations.at(-1)?.data.verdict, "satisfied");
});

test("unchanged delivery retries failure once and reuses later satisfaction", async (t) => {
  const external = mkdtempSync(resolve(tmpdir(), "verification-retry-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  const runs = resolve(external, "runs");
  const ready = resolve(external, "ready");
  const { raw, id, worktree } = await bindCandidate(
    `echo run >> '${runs}'\ntest -f '${ready}'`,
    ["reviewed", "verified"],
  );
  const head = raw.run(["-C", worktree, "rev-parse", "HEAD"]);
  const deliver = async () => {
    const result = (await cliJson<DeliverOutcome>(["-C", raw.path, "deliver", id], { environment: {} })).value;
    assert.equal(result.kind, "accepted");
    return result;
  };
  const repository = await repositoryAt(raw.path);
  await deliver();
  assert.equal(readFileSync(runs, "utf8"), "run\n");
  assert.equal((await observeContract(repository, id)).state?.terminal, null);
  await deliver();
  assert.equal(readFileSync(runs, "utf8"), "run\nrun\n", "one retry per invocation, never a loop");
  assert.equal((await observeContract(repository, id)).state?.terminal, null);
  writeFileSync(ready, "ready");
  const recovered = await deliver();
  assert.equal(readFileSync(runs, "utf8"), "run\nrun\nrun\n");
  assert.ok(recovered.kind === "accepted" && recovered.facts.some(
    (fact) => fact.kind === "attestation" && fact.data.verdict === "satisfied",
  ));
  await deliver();
  assert.equal(readFileSync(runs, "utf8"), "run\nrun\nrun\n", "satisfaction skips execution");
  assert.equal(raw.run(["-C", worktree, "rev-parse", "HEAD"]), head, "retry never changes the work");
  const reviewed = await cliJson(["-C", raw.path, "review", id, "--satisfied", "--summary", "reviewed"], { environment: {} });
  assert.equal(reviewed.exit, 0);
  assert.equal((await observeContract(repository, id)).state?.terminal?.kind, "claimed");
});

test("audit reports execution even when an unchanged verdict is deduplicated", async () => {
  const { raw, id } = await bindAndDeliver("printf 'audit-executed\\n'; false");
  const first = (await cliJson<AuditOutcome>(["-C", raw.path, "audit", id], { environment: {} })).value;
  const second = (await cliJson<AuditOutcome>(["-C", raw.path, "audit", id], { environment: {} })).value;
  assert.equal(first.kind, "accepted");
  if (first.kind !== "accepted") throw new Error("first audit was not accepted");
  assert.equal(first.facts.length, 1);
  assert.equal(second.kind, "accepted");
  if (second.kind !== "accepted") throw new Error("second audit was not accepted");
  assert.equal(second.facts.length, 0);
  assert.equal(second.value.verification.kind, "unsatisfied");
  if (second.value.verification.kind !== "unsatisfied") throw new Error("audit did not report execution");
  assert.equal(second.value.verification.passed, 0);
  assert.equal(second.value.verification.total, 1);
  assert.match(second.value.verification.summary ?? "", /audit-executed/u);
  const repository = await repositoryAt(raw.path);
  const state = (await observeContract(repository, id)).state!;
  assert.equal(state.attestations.filter((fact) => fact.data.gate === "verified").length, 2);
});

test("concurrent unchanged audits admit one attestation but both report execution", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  raw.run(["checkout", "--quiet", "-b", "candidate"]);
  writeFileSync(resolve(raw.path, "candidate.txt"), "candidate\n");
  raw.run(["add", "candidate.txt"]);
  raw.run(["commit", "--quiet", "-m", "candidate"]);
  mkdirSync(resolve(raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(
    resolve(raw.path, ".keiyaku", "settings.json"),
    JSON.stringify({ gates: { default: { kind: "bundle", gates: ["verified"] } } }),
  );
  const bound = await cliJson<Readonly<{ kind: string; contract?: string }>>(
    ["-C", raw.path, "bind", "--target", "refs/heads/main", "-"],
    { environment: {}, readStdin: async () => markdown("false") },
  );
  assert.equal(bound.value.kind, "accepted");
  const id = bound.value.contract as ContractId;
  // Two concurrent audits cannot share the global stdout capture; exercise the same public operation directly.
  const native = Keiyaku.with().select({ repo: await Repo.at({ path: raw.path }), id });
  const [first, second] = await Promise.all([native.audit(), native.audit()]);
  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "accepted");
  if (first.kind !== "accepted" || second.kind !== "accepted") throw new Error("audit was not accepted");
  assert.equal(first.facts.length + second.facts.length, 1);
  assert.equal(first.value.verification.kind, "unsatisfied");
  assert.equal(second.value.verification.kind, "unsatisfied");
  const repository = await repositoryAt(raw.path);
  const state = (await observeContract(repository, id)).state!;
  assert.equal(state.attestations.filter((fact) => fact.data.gate === "verified").length, 1);
});

test("audit admits a new attestation after the candidate changes", async () => {
  const { raw, id } = await bindAndDeliver("false");
  const first = (await cliJson<AuditOutcome>(["-C", raw.path, "audit", id], { environment: {} })).value;
  assert.equal(first.kind, "accepted");
  const repository = await repositoryAt(raw.path);
  const state = (await observeContract(repository, id)).state!;
  const worktree = await appointedWorktreePath(repository, id);
  writeFileSync(resolve(worktree, "candidate.txt"), "changed\n");
  raw.run(["-C", worktree, "add", "candidate.txt"]);
  raw.run(["-C", worktree, "commit", "--quiet", "-m", "changed"]);
  const second = (await cliJson<AuditOutcome>(["-C", raw.path, "audit", id], { environment: {} })).value;
  assert.equal(second.kind, "accepted");
  if (second.kind !== "accepted") throw new Error("second audit was not accepted");
  assert.equal(second.facts.length, 1);
  const after = (await observeContract(repository, id)).state!;
  assert.equal(after.attestations.filter((fact) => fact.data.gate === "verified").length, 3);
  assert.notEqual(after.attestations.at(-1)?.data.subject, state.attestations.at(-1)?.data.subject);
});

test("closing or failing CLI progress output does not cancel the operation", async (t) => {
  for (const failure of [undefined, new Error("output failed")]) {
    await t.test(failure === undefined ? "closed" : "failed", async () => {
      const { promise: completion, resolve: complete } = promiseBarrier<string>();
      const { raw, id } = await bindCandidate("printf 'callback output\n'", ["reviewed", "verified"]);
      const native = Keiyaku.with().select({ repo: await Repo.at({ path: raw.path }), id });
      const stream = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          callback();
          void setImmediate().then(() => this.destroy(failure));
        },
      });
      const progress = await writeExecutionProgress(stream);
      const pending = native.deliver({}, { observe: (event: ExecutionObservation) => {
        progress.observe(event);
        return completion.then(() => undefined);
      } });
      try {
        const result = accepted(await pending);
        assert.ok(result.facts.some((fact) => fact.kind === "deliver"));
        await assert.rejects(progress.finish(), failure ?? { code: "ERR_STREAM_PREMATURE_CLOSE" });
      } finally {
        complete("complete");
        stream.destroy();
      }
    });
  }
});
