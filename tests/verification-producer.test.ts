import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { VerificationDeclaration } from "../src/verification/declaration.js";
import { executeVerification, type ExecuteVerificationInput } from "../src/verification/execution.js";
import type { MaterializedScratchCandidate } from "../src/git/scratch.js";
import { settings } from "../src/settings.js";

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

function input(root: string, declarations: readonly VerificationDeclaration[], overrides: Partial<ExecuteVerificationInput> = {}): ExecuteVerificationInput {
  const scratch: MaterializedScratchCandidate = { cwd: root, dispose: () => null };
  return {
    repository: {} as ExecuteVerificationInput["repository"],
    candidate: "snapshot" as ExecuteVerificationInput["candidate"],
    declarations,
    environment: process.env,
    materializeScratchCandidate: () => scratch,
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

test("execution runs every declaration after a nonzero exit and returns only its terminal result", async () => {
  await inTemporaryDirectory(async (root) => {
    const counter = join(root, "runs");
    const declarations = [
      declaration(`${command(`require("node:fs").appendFileSync(${JSON.stringify(counter)}, "1")`)}; false`),
      declaration(command(`require("node:fs").appendFileSync(${JSON.stringify(counter)}, "2")`)),
    ];
    const outcome = await executeVerification(input(root, declarations));

    assert.deepEqual(outcome, {
      outcome: { kind: "terminal", verdict: "unsatisfied", summary: "[1 bash exit 1]" },
    });
    assert.equal(readFileSync(counter, "utf8"), "12");
  });
});

test("producer leaves an omitted declaration unbounded", async (t) => {
  const timeouts: number[] = [];
  t.mock.method(globalThis, "setTimeout", ((_callback: () => void, milliseconds?: number) => {
    timeouts.push(milliseconds ?? 0);
    return undefined;
  }) as typeof setTimeout);

  const outcome = await executeVerification(input("/tmp", [declaration("true")]));

  assert.deepEqual(outcome, { outcome: { kind: "terminal", verdict: "satisfied" } });
  assert.deepEqual(timeouts, []);
});

test("a declaration timeout is terminally unsatisfied and later declarations still run", async () => {
  await inTemporaryDirectory(async (root) => {
    const secondStarted = join(root, "second-started");
    const outcome = await executeVerification(input(root, [
      declaration("sleep 1", "bash", 25),
      declaration(command(`require("node:fs").writeFileSync(${JSON.stringify(secondStarted)}, "started")`)),
    ]));

    assert.deepEqual(outcome, {
      outcome: { kind: "terminal", verdict: "unsatisfied", summary: "[1 bash timeout after 25ms]" },
    });
    assert.equal(existsSync(secondStarted), true);
  });
});

test("caller cancellation is nonterminal and stops later declarations", async () => {
  await inTemporaryDirectory(async (root) => {
    const started = join(root, "started");
    const later = join(root, "later");
    const controller = new AbortController();
    const outcome = executeVerification(input(root, [
      declaration(`${command(`require("node:fs").writeFileSync(${JSON.stringify(started)}, "started")`)}; sleep 30`),
      declaration(command(`require("node:fs").writeFileSync(${JSON.stringify(later)}, "later")`)),
    ], { signal: controller.signal }));
    const deadline = performance.now() + 2_000;
    while (!existsSync(started)) {
      if (performance.now() >= deadline) throw new Error("Verification declaration did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();

    assert.deepEqual(await outcome, { outcome: { kind: "cancelled" } });
    assert.equal(existsSync(later), false);
  });
});

test("execution returns an unsatisfied verdict, unknown-exit, and spawn-error without persistence", async () => {
  await inTemporaryDirectory(async (root) => {
    const failed = await executeVerification(input(root, [declaration("false")]));
    assert.deepEqual(failed, {
      outcome: { kind: "terminal", verdict: "unsatisfied", summary: "[1 bash exit 1]" },
    });

    const unknownExit = await executeVerification(input(root, [declaration("kill -TERM $$")]));
    assert.deepEqual(unknownExit, { outcome: { kind: "unknown-exit" } });

    const spawnError = await executeVerification(input(root, [declaration("true", "zsh")], { environment: { PATH: root } }));
    assert.equal(spawnError.outcome.kind, "spawn-error");
    if (spawnError.outcome.kind !== "spawn-error") return;
    assert.match(spawnError.outcome.diagnostic, /spawn zsh ENOENT/);
  });
});

test("producer preserves ordered terminal diagnostics within one 32 KiB summary", async () => {
  await inTemporaryDirectory(async (root) => {
    const outcome = await executeVerification(input(root, [
      declaration('printf "first-out"; printf "%*s" 12000 "" | tr " " a; printf "%*s" 12000 "" | tr " " b >&2; false'),
      declaration('printf "%*s" 12000 "" | tr " " x; printf "%*s" 12000 "" | tr " " y >&2'),
    ]));

    assert.equal(outcome.outcome.kind, "terminal");
    if (outcome.outcome.kind !== "terminal") return;
    assert.equal(outcome.outcome.verdict, "unsatisfied");
    assert.notEqual(outcome.outcome.summary, undefined);
    const summary = outcome.outcome.summary!;
    assert.ok(Buffer.byteLength(summary) <= 32 * 1024);
    assert.match(summary, /^\[earlier output truncated\]\n/);
    assert.match(summary, /\[2 bash exit 0\]/);
    assert.match(summary, /stdout:\n[x]+\nstderr:\n[y]+$/);
    assert.doesNotMatch(summary, /first-out/);
  });
});

test("producer invokes bash, zsh, and pwsh with their declared script argument", async () => {
  await inTemporaryDirectory(async (root) => {
    const capture = join(root, "argv");
    for (const executor of ["bash", "zsh", "pwsh"] as const) {
      const executable = join(root, executor);
      writeFileSync(executable, [
        "#!/bin/sh",
        `printf '${executor}:' >> \"$CAPTURE_FILE\"`,
        'for argument in "$@"; do',
        '  printf "<%s>" "$argument" >> "$CAPTURE_FILE"',
        "done",
        'printf "\\n" >> "$CAPTURE_FILE"',
      ].join("\n"));
      chmodSync(executable, 0o755);
    }

    const outcome = await executeVerification(input(root, [
      declaration("printf bash", "bash"),
      declaration("printf zsh", "zsh"),
      declaration("Write-Output pwsh", "pwsh"),
    ], {
      environment: {
        ...process.env,
        CAPTURE_FILE: capture,
        PATH: `${root}:${process.env.PATH ?? ""}`,
      },
    }));

    assert.deepEqual(outcome, { outcome: { kind: "terminal", verdict: "satisfied" } });
    assert.equal(readFileSync(capture, "utf8"), [
      "bash:<-c><printf bash>",
      "zsh:<-c><printf zsh>",
      "pwsh:<-Command><Write-Output pwsh>",
      "",
    ].join("\n"));
  });
});
