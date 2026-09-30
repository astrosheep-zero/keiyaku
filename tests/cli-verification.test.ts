import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { invoke as invokeRaw } from "../src/cli/invoke.js";
import type { InvocationResult } from "../src/cli/result.js";
import { renderDiffstat } from "../src/cli/render/akuma-tool.js";
import { renderText } from "../src/cli/render/text.js";
import { writeExecutionProgress } from "../src/cli/runtime.js";
import { Keiyaku, Repo, type ExecutionObservation } from "../src/index.js";
import { accepted } from "./support/library-verbs.js";
import type { ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { appointedWorktreePath, makeGitRepository, observeContract } from "./support/git.js";
import { executable } from "./support/cli-fixtures.js";
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

function progressOutput() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    text: () => text,
    progress: () => writeExecutionProgress(stream),
  };
}

async function bindCandidate(script: string, gates: readonly string[] = ["verified"]) {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  mkdirSync(resolve(raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(
    resolve(raw.path, ".keiyaku", "settings.json"),
    JSON.stringify({ gates: { default: { kind: "bundle", gates } } }),
  );
  const bound = (await invokeRaw(executable(["-C", raw.path, "bind", "--target", "refs/heads/main", "-"]), {
    environment: {},
    readStdin: async () => markdown(script),
  })) as unknown as { kind: string; contract: string };
  assert.equal(bound.kind, "accepted");
  const id = bound.contract as ContractId;
  const repository = await repositoryAt(raw.path);
  const worktree = await appointedWorktreePath(repository, id);
  writeFileSync(resolve(worktree, "candidate.txt"), "candidate\n");
  raw.run(["-C", worktree, "add", "candidate.txt"]);
  raw.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  return { raw, id, worktree };
}

async function bindAndDeliver(script: string, gates: readonly string[] = ["verified"]) {
  const { raw, id } = await bindCandidate(script, gates);
  const output = progressOutput();
  const result = await invokeRaw(executable(["-C", raw.path, "deliver", id]), {
    environment: { KEIYAKU_ACTOR_ID: "cli-verification-test" },
    progress: output.progress,
  });
  output.stream.destroy();
  return { raw, id, result, progress: output.text() };
}

test("deliver adapts a successful Verification result through the CLI", async () => {
  const { raw, id, result, progress } = await bindAndDeliver("printf 'delivery-live-output\\n'");
  const delivered = result as unknown as { kind: string; facts: readonly { kind: string }[] };
  assert.equal(delivered.kind, "accepted");
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver", "attestation", "claimed"],
  );
  const repository = await repositoryAt(raw.path);
  assert.equal((await observeContract(repository, id)).state?.terminal?.kind, "claimed");
  assert.doesNotMatch(progress, /●/u, "non-TTY progress never prints a phase start");
  assert.match(progress, /delivery-live-output/u);
  assert.match(progress, /✓ declaration 1\/1/u);
});

test("a blocked deliver names the verified snapshot and the accepting review lands it", async () => {
  const { raw, id, worktree } = await bindCandidate("printf 'verified-output\\n'", ["reviewed"]);

  const blocked = await invokeRaw(executable(["-C", raw.path, "deliver", id]), { environment: {} });
  const blockedText = renderText(blocked as unknown as InvocationResult, { columns: 200, color: false });
  const standalone = /^  integration result  ([0-9a-f]+) · verification satisfied$/mu.exec(blockedText);
  assert.ok(standalone, blockedText);
  assert.doesNotMatch(blockedText, /verification reused/u, "a fresh run carries no qualifier");
  assert.equal((blockedText.match(/integration result/gu) ?? []).length, 1, "no second row repeats the subject");

  const reviewed = await invokeRaw(
    executable(["-C", raw.path, "review", id, "--satisfied", "--summary", "accepted"]),
    { environment: {} },
  );
  const reviewedText = renderText(reviewed as unknown as InvocationResult, { columns: 200, color: false });
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
  const text = renderText(result as unknown as InvocationResult, { columns: 200, color: false });
  assert.ok(text.split("\n").includes(`  changes  1 file · ${renderDiffstat({ added: 1, removed: 0 })}`));
  assert.equal((text.match(/^  changes /gmu) ?? []).length, 1, "one bounded changes row");
});

test("audit reports reuse on a second unchanged verification", async () => {
  const { raw, id } = await bindAndDeliver("false");
  const first = await invokeRaw(executable(["-C", raw.path, "audit", id]), { environment: {} });
  const second = await invokeRaw(executable(["-C", raw.path, "audit", id]), { environment: {} });
  assert.ok("kind" in first && first.kind === "accepted");
  assert.equal((first as { facts: readonly unknown[] }).facts.length, 1);
  assert.ok("kind" in second && second.kind === "accepted");
  assert.equal((second as { facts: readonly unknown[] }).facts.length, 0);
  const secondReport = (second as unknown as { report: { verification: { kind: string; [key: string]: unknown } } })
    .report;
  assert.equal(secondReport.verification.kind, "reused");
  const repository = await repositoryAt(raw.path);
  const state = (await observeContract(repository, id)).state!;
  assert.equal(state.attestations.filter((fact) => fact.data.gate === "verified").length, 2);
});

test("concurrent unchanged audits admit one attestation and reuse the loser", async () => {
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
  const bound = (await invokeRaw(executable(["-C", raw.path, "bind", "--target", "refs/heads/main", "-"]), {
    environment: {},
    readStdin: async () => markdown("false"),
  })) as unknown as { kind: string; contract: string };
  assert.equal(bound.kind, "accepted");
  const id = bound.contract as ContractId;
  const [first, second] = await Promise.all([
    invokeRaw(executable(["-C", raw.path, "audit", id]), { environment: {} }),
    invokeRaw(executable(["-C", raw.path, "audit", id]), { environment: {} }),
  ]);
  assert.ok("kind" in first && first.kind === "accepted");
  assert.ok("kind" in second && second.kind === "accepted");
  assert.equal(
    (first as { facts: readonly unknown[] }).facts.length + (second as { facts: readonly unknown[] }).facts.length,
    1,
  );
  const reused = [first, second].filter(
    (result) =>
      "kind" in result &&
      result.kind === "accepted" &&
      (result as unknown as { report: { verification: { kind: string } } }).report.verification.kind === "reused",
  );
  assert.equal(reused.length, 1);
  const repository = await repositoryAt(raw.path);
  const state = (await observeContract(repository, id)).state!;
  assert.equal(state.attestations.filter((fact) => fact.data.gate === "verified").length, 1);
});

test("audit admits a new attestation after the candidate changes", async () => {
  const { raw, id } = await bindAndDeliver("false");
  const first = await invokeRaw(executable(["-C", raw.path, "audit", id]), { environment: {} });
  assert.ok("kind" in first && first.kind === "accepted");
  const repository = await repositoryAt(raw.path);
  const state = (await observeContract(repository, id)).state!;
  const worktree = await appointedWorktreePath(repository, id);
  writeFileSync(resolve(worktree, "candidate.txt"), "changed\n");
  raw.run(["-C", worktree, "add", "candidate.txt"]);
  raw.run(["-C", worktree, "commit", "--quiet", "-m", "changed"]);
  const second = await invokeRaw(executable(["-C", raw.path, "audit", id]), { environment: {} });
  assert.ok("kind" in second && second.kind === "accepted");
  assert.equal((second as { facts: readonly unknown[] }).facts.length, 1);
  const after = (await observeContract(repository, id)).state!;
  assert.equal(after.attestations.filter((fact) => fact.data.gate === "verified").length, 3);
  assert.notEqual(after.attestations.at(-1)?.data.subject, state.attestations.at(-1)?.data.subject);
});

test("closing or failing CLI progress output does not cancel the operation", async (t) => {
  for (const failure of [undefined, new Error("output failed")]) {
    await t.test(failure === undefined ? "closed" : "failed", async () => {
      const { promise: completion, resolve: complete } = promiseBarrier<string>();
      const { raw, id } = await bindCandidate("printf 'callback output\n'", ["reviewed"]);
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
