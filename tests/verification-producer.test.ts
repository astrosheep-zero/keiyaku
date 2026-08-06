import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { produceVerification, type ProduceVerificationInput } from "../src/verification/producer.js";
import { resolveVerificationPlan, type VerificationDeclaration } from "../src/verification/plan.js";

const candidateTree = "a".repeat(40);

function declaration(script: string, executor: VerificationDeclaration["executor"] = "bash"): VerificationDeclaration {
  return { executor, script };
}

function command(program: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`;
}

function input(root: string, declarations: readonly VerificationDeclaration[], overrides: Partial<ProduceVerificationInput> = {}): ProduceVerificationInput {
  return {
    candidateTree,
    declarations,
    cwd: root,
    timeoutMs: 2_000,
    stdoutLimitBytes: 1_024,
    stderrLimitBytes: 1_024,
    ...overrides,
  };
}

async function inTemporaryDirectory(action: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-verification-"));
  try {
    await action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("producer executes every invocation and returns a terminal summary", async () => {
  await inTemporaryDirectory(async (root) => {
    const counter = join(root, "runs");
    const plan = [declaration(command(`require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x")`))];
    const first = await produceVerification(input(root, plan));
    const second = await produceVerification(input(root, plan));

    assert.equal(first.kind, "terminal");
    assert.equal(second.kind, "terminal");
    if (first.kind !== "terminal" || second.kind !== "terminal") return;
    assert.equal(first.verdict, "satisfied");
    assert.equal(first.summary, "verification satisfied");
    assert.equal(second.summary, "verification satisfied");
    assert.equal(readFileSync(counter, "utf8"), "xx");
  });
});

test("producer returns an unsatisfied verdict, timeout, unknown-exit, and spawn-error without persistence", async () => {
  await inTemporaryDirectory(async (root) => {
    const failed = await produceVerification(input(root, [declaration("false")]));
    assert.equal(failed.kind, "terminal");
    if (failed.kind === "terminal") assert.equal(failed.verdict, "unsatisfied");

    const timeout = await produceVerification(input(root, [declaration("sleep 1")], { timeoutMs: 25 }));
    assert.equal(timeout.kind, "timeout");

    const unknownExit = await produceVerification(input(root, [declaration("kill -TERM $$")]));
    assert.equal(unknownExit.kind, "unknown-exit");

    const spawnError = await produceVerification(input(root, [declaration("true", "zsh")], { env: { PATH: root } }));
    assert.equal(spawnError.kind, "spawn-error");
  });
});

test("plan resolves executor argv", () => {
  const declarations = [declaration("printf ok"), declaration("Write-Output ok", "pwsh")];
  const plan = resolveVerificationPlan(declarations);
  assert.deepEqual(plan.map((step) => step.argv), [
    ["bash", "-c", "printf ok"],
    ["pwsh", "-Command", "Write-Output ok"],
  ]);
});
