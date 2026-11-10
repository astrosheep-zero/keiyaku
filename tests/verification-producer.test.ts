import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { VerificationDeclaration } from "../src/verification/declaration.js";
import { executeVerification, type ExecuteVerificationInput } from "../src/verification/execution.js";
import { verificationObservationSchema, type VerificationObservation } from "../src/verification/observation.js";
import type { MaterializedScratchCandidate } from "../src/git/scratch.js";
import { settings } from "../src/settings.js";
import { contractId, snapshotId } from "../src/core/facts/types.js";

function declaration(
  script: string,
  executor: VerificationDeclaration["executor"] = "bash",
  timeoutMs?: number,
): VerificationDeclaration {
  return { executor, script, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function command(program: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`;
}

function input(
  root: string,
  selected: VerificationDeclaration,
  overrides: Partial<ExecuteVerificationInput> = {},
): ExecuteVerificationInput {
  const scratch: MaterializedScratchCandidate = { cwd: root, dispose: async () => null };
  return {
    repository: {} as ExecuteVerificationInput["repository"],
    candidate: snapshotId("snapshot"),
    contractId: contractId("kei/producer"),
    declaration: selected,
    index: 1,
    total: 1,
    requirement: "opaque requirement",
    materializeScratchCandidate: async () => scratch,
    projectSettings: async () => await settings({ root }),
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

test("a selected declaration timeout is terminally unsatisfied with its display index", async () => {
  await inTemporaryDirectory(async (root) => {
    const result = await executeVerification(input(root, declaration("sleep 1", "bash", 25), { index: 2, total: 3 }));
    assert.deepEqual(result, {
      outcome: {
        kind: "terminal",
        verdict: "unsatisfied",
        summary: "[2 bash timeout after 25ms]",
      },
    });
  });
});

test("caller cancellation is nonterminal and awaits scene retirement", async () => {
  await inTemporaryDirectory(async (root) => {
    const started = join(root, "started");
    const controller = new AbortController();
    let retained: boolean | undefined;
    const outcome = executeVerification(
      input(
        root,
        declaration(`${command(`require("node:fs").writeFileSync(${JSON.stringify(started)}, "started")`)}; sleep 30`),
        {
          signal: controller.signal,
          materializeScratchCandidate: async () => ({
            cwd: root,
            dispose: async (retain) => {
              retained = retain;
              return null;
            },
          }),
        },
      ),
    );
    const deadline = performance.now() + 15_000;
    while (!existsSync(started)) {
      if (performance.now() >= deadline) throw new Error("Verification declaration did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    assert.deepEqual(await outcome, { outcome: { kind: "cancelled" } });
    assert.equal(retained, false);
  });
});

test("execution returns an unsatisfied verdict, unknown-exit, and spawn-error without persistence", async () => {
  await inTemporaryDirectory(async (root) => {
    const failed = await executeVerification(input(root, declaration("false")));
    assert.deepEqual(failed, {
      outcome: { kind: "terminal", verdict: "unsatisfied", summary: "[1 bash exit 1]" },
    });
    const unknownExit = await executeVerification(input(root, declaration("kill -TERM $$")));
    assert.deepEqual(unknownExit, { outcome: { kind: "unknown-exit" } });
    const missingExecutor = "keiyaku-v4-no-such-executable" as VerificationDeclaration["executor"];
    const spawnError = await executeVerification(input(root, declaration("true", missingExecutor)));
    assert.ok(spawnError.outcome.kind === "spawn-error");
    assert.match(spawnError.outcome.diagnostic, new RegExp(`spawn ${missingExecutor} ENOENT`));
  });
});

test("producer bounds a selected failure's diagnostics to 32 KiB", async () => {
  await inTemporaryDirectory(async (root) => {
    const result = await executeVerification(
      input(
        root,
        declaration(
          'printf "first-out"; printf "%*s" 24000 "" | tr " " x; printf "%*s" 24000 "" | tr " " y >&2; false',
        ),
      ),
    );
    assert.ok(result.outcome.kind === "terminal");
    assert.equal(result.outcome.verdict, "unsatisfied");
    const summary = result.outcome.summary!;
    assert.ok(Buffer.byteLength(summary) <= 32 * 1024);
    assert.match(summary, /^\[earlier output truncated\]\n/);
    assert.match(summary, /[x]+\nstderr:\n[y]+$/);
    assert.doesNotMatch(summary, /first-out/);
  });
});

test("all observations keep the selected requirement, index and captured snapshot", async () => {
  await inTemporaryDirectory(async (root) => {
    const events: VerificationObservation[] = [];
    mkdirSync(join(root, ".keiyaku"));
    writeFileSync(
      join(root, ".keiyaku/settings.json"),
      JSON.stringify({
        worktree: {
          create: [{ name: "prepare", argv: ["bash", "-c", "printf setup-output"], timeoutMs: 5_000 }],
          destroy: [{ name: "retire", argv: ["bash", "-c", "printf cleanup-output"], timeoutMs: 5_000 }],
        },
      }),
    );
    const selected = input(root, declaration('printf "declaration-output"'), {
      index: 3,
      total: 4,
      requirement: "opaque/selected",
      observe: (event) => events.push(event),
      materializeScratchCandidate: async (_repository, candidate, contract, requirement) => {
        assert.equal(candidate, selected.candidate);
        assert.equal(contract, selected.contractId);
        assert.equal(requirement, selected.requirement);
        return { cwd: root, dispose: async () => null };
      },
    });
    const result = await executeVerification(selected);
    assert.deepEqual(result.outcome, { kind: "terminal", verdict: "satisfied" });
    assert.deepEqual(
      [...new Set(events.map((event) => event.phase))],
      ["materialize", "setup", "declaration", "cleanup"],
    );
    for (const event of events) {
      assert.equal(event.requirement, selected.requirement);
      assert.equal(event.index, 3);
      assert.equal(event.total, 4);
      assert.equal(event.snapshot, selected.candidate);
      assert.equal(verificationObservationSchema.safeParse(event).success, true);
    }
    for (const phase of ["setup", "declaration", "cleanup"])
      assert.ok(events.some((event) => event.kind === "output" && event.phase === phase));
  });
});

test("verbose success remains live and observer failure cannot change execution or retirement", async () => {
  await inTemporaryDirectory(async (root) => {
    let successOutput = "";
    const result = await executeVerification(
      input(root, declaration('printf "%*s" 40000 "" | tr " " x'), {
        observe: (event) => {
          if (event.kind === "output") successOutput += event.text;
          throw new Error("observer unavailable");
        },
      }),
    );
    assert.equal(successOutput, "x".repeat(40000));
    assert.deepEqual(result.outcome, { kind: "terminal", verdict: "satisfied" });
  });
});
