import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { VerificationDeclaration } from "../src/verification/types.js";
import { produceVerification, type ProduceVerificationInput } from "../src/verification/producer.js";

function declaration(script: string, executor: VerificationDeclaration["executor"] = "bash"): VerificationDeclaration {
  return { executor, script };
}

function command(program: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`;
}

function input(root: string, declarations: readonly VerificationDeclaration[], overrides: Partial<ProduceVerificationInput> = {}): ProduceVerificationInput {
  return {
    declarations,
    cwd: root,
    timeoutMs: 2_000,
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

test("producer runs every declaration after a nonzero exit and returns only its terminal result", async () => {
  await inTemporaryDirectory(async (root) => {
    const counter = join(root, "runs");
    const declarations = [
      declaration(`${command(`require("node:fs").appendFileSync(${JSON.stringify(counter)}, "1")`)}; false`),
      declaration(command(`require("node:fs").appendFileSync(${JSON.stringify(counter)}, "2")`)),
    ];
    const outcome = await produceVerification(input(root, declarations));

    assert.deepEqual(outcome, {
      kind: "terminal",
      verdict: "unsatisfied",
      summary: "[1 bash exit 1]",
    });
    assert.equal(readFileSync(counter, "utf8"), "12");
  });
});

test("producer gives each declaration only the remaining invocation budget", async (t) => {
  const now = t.mock.method(Object.getPrototypeOf(performance), "now", (() => {
    const values = [0, 0, 40];
    return () => values.shift() ?? 40;
  })());
  const timeouts: number[] = [];
  t.mock.method(globalThis, "setTimeout", ((_callback: () => void, milliseconds?: number) => {
    timeouts.push(milliseconds ?? 0);
    return undefined;
  }) as typeof setTimeout);

  const outcome = await produceVerification(input("/tmp", [declaration("true"), declaration("true")], { timeoutMs: 100 }));

  assert.deepEqual(outcome, { kind: "terminal", verdict: "satisfied" });
  assert.deepEqual(timeouts, [100, 60]);
  now.mock.restore();
});

test("producer does not spawn a declaration after the invocation budget is exhausted", async (t) => {
  await inTemporaryDirectory(async (root) => {
    const secondStarted = join(root, "second-started");
    const now = t.mock.method(Object.getPrototypeOf(performance), "now", (() => {
      const values = [0, 0, 100];
      return () => values.shift() ?? 100;
    })());
    const timeouts: number[] = [];
    t.mock.method(globalThis, "setTimeout", ((_callback: () => void, milliseconds?: number) => {
      timeouts.push(milliseconds ?? 0);
      return undefined;
    }) as typeof setTimeout);

    const outcome = await produceVerification(input(root, [
      declaration("true"),
      declaration(command(`require("node:fs").writeFileSync(${JSON.stringify(secondStarted)}, "started")`)),
    ], { timeoutMs: 100 }));

    assert.deepEqual(outcome, { kind: "timeout" });
    assert.deepEqual(timeouts, [100]);
    assert.equal(existsSync(secondStarted), false);
    now.mock.restore();
  });
});

test("producer returns an unsatisfied verdict, timeout, unknown-exit, and spawn-error without persistence", async () => {
  await inTemporaryDirectory(async (root) => {
    const failed = await produceVerification(input(root, [declaration("false")]));
    assert.deepEqual(failed, {
      kind: "terminal",
      verdict: "unsatisfied",
      summary: "[1 bash exit 1]",
    });

    const timeout = await produceVerification(input(root, [declaration("sleep 1")], { timeoutMs: 25 }));
    assert.deepEqual(timeout, { kind: "timeout" });

    const unknownExit = await produceVerification(input(root, [declaration("kill -TERM $$")]));
    assert.deepEqual(unknownExit, { kind: "unknown-exit" });

    const spawnError = await produceVerification(input(root, [declaration("true", "zsh")], { env: { PATH: root } }));
    assert.equal(spawnError.kind, "spawn-error");
    if (spawnError.kind !== "spawn-error") return;
    assert.match(spawnError.diagnostic, /spawn zsh ENOENT/);
  });
});

test("producer preserves ordered terminal diagnostics within one 32 KiB summary", async () => {
  await inTemporaryDirectory(async (root) => {
    const outcome = await produceVerification(input(root, [
      declaration('printf "first-out"; printf "%*s" 12000 "" | tr " " a; printf "%*s" 12000 "" | tr " " b >&2; false'),
      declaration('printf "%*s" 12000 "" | tr " " x; printf "%*s" 12000 "" | tr " " y >&2'),
    ]));

    assert.equal(outcome.kind, "terminal");
    if (outcome.kind !== "terminal") return;
    assert.equal(outcome.verdict, "unsatisfied");
    assert.notEqual(outcome.summary, undefined);
    const summary = outcome.summary!;
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

    const outcome = await produceVerification(input(root, [
      declaration("printf bash", "bash"),
      declaration("printf zsh", "zsh"),
      declaration("Write-Output pwsh", "pwsh"),
    ], {
      env: {
        ...process.env,
        CAPTURE_FILE: capture,
        PATH: `${root}:${process.env.PATH ?? ""}`,
      },
    }));

    assert.deepEqual(outcome, { kind: "terminal", verdict: "satisfied" });
    assert.equal(readFileSync(capture, "utf8"), [
      "bash:<-c><printf bash>",
      "zsh:<-c><printf zsh>",
      "pwsh:<-Command><Write-Output pwsh>",
      "",
    ].join("\n"));
  });
});
