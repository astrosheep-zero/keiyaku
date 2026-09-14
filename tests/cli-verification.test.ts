import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { invoke as invokeRaw } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { renderText } from "../src/cli/render/text.js";
import { writeExecutionProgress } from "../src/cli/runtime.js";
import { startContractExecution, type ExecutionEvent } from "../src/library/execution.js";
import type { ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { makeGitRepository, observeContract } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

function executable(argv: readonly string[]) {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

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
    progress: (events: AsyncIterable<ExecutionEvent>) => writeExecutionProgress(events, stream),
  };
}

async function bindAndDeliver(script: string, gates: readonly string[] = ["verified"]) {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  raw.run(["checkout", "--quiet", "-b", "candidate"]);
  writeFileSync(resolve(raw.path, "candidate.txt"), "candidate\n");
  raw.run(["add", "candidate.txt"]);
  raw.run(["commit", "--quiet", "-m", "candidate"]);
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
  const output = progressOutput();
  const result = await invokeRaw(executable(["-C", raw.path, "deliver", bound.contract]), {
    environment: { KEIYAKU_ACTOR_ID: "cli-verification-test" },
    progress: output.progress,
  });
  output.stream.destroy();
  return { raw, id: bound.contract as ContractId, result, progress: output.text() };
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
  assert.match(progress, /● declaration 1\/1/u);
  assert.match(progress, /delivery-live-output/u);
  assert.match(progress, /✓ declaration 1\/1/u);
});

test("review prints Verification progress when target movement requires reintegration", async () => {
  const { raw, id } = await bindAndDeliver("printf 'review-live-output\\n'", ["verified", "reviewed"]);
  raw.run(["checkout", "--quiet", "main"]);
  writeFileSync(resolve(raw.path, "target.txt"), "target changed\n");
  raw.run(["add", "target.txt"]);
  raw.run(["commit", "--quiet", "-m", "advance target"]);
  const output = progressOutput();
  try {
    const result = await invokeRaw(executable(["-C", raw.path, "review", id, "--satisfied", "--summary", "Reviewed"]), {
      environment: { KEIYAKU_ACTOR_ID: "cli-review-test" },
      progress: output.progress,
    });
    assert.ok("kind" in result && result.kind === "accepted");
    assert.match(output.text(), /● declaration 1\/1/u);
    assert.match(output.text(), /review-live-output/u);
    assert.match(output.text(), /✓ declaration 1\/1/u);
    assert.equal((await observeContract(await repositoryAt(raw.path), id)).state?.terminal?.kind, "claimed");
  } finally {
    output.stream.destroy();
  }
});

test("audit renders the Verification summary from its CLI result", async () => {
  const pending = await bindAndDeliver("printf 'verification diagnostic\\n' >&2; exit 1");
  const audit = (await invokeRaw(executable(["-C", pending.raw.path, "audit", pending.id]), {
    environment: { KEIYAKU_ACTOR_ID: "cli-audit-test" },
  })) as unknown as { kind: string; report: { verification: { kind: string; summary?: string } } };
  assert.equal(audit.kind, "accepted");
  assert.equal(audit.report.verification.kind, "unsatisfied");
  assert.match(audit.report.verification.summary ?? "", /verification diagnostic/u);
  assert.match(renderText(audit as never, { columns: 400, color: false }), /verification diagnostic/u);
});

test("CLI progress waits for a slow destination and leaves it open after draining", async () => {
  let release!: () => void;
  let started!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    started = resolve;
  });
  const chunks: string[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      if (chunks.length === 1) {
        release = callback;
        started();
      } else callback();
    },
  });
  async function* events(): AsyncIterable<ExecutionEvent> {
    for (let count = 1; count <= 100; count++) yield { kind: "progress-dropped", count };
  }
  const writing = writeExecutionProgress(events(), stream);
  try {
    await firstWrite;
    await setImmediate();
    assert.equal(stream.writableLength, Buffer.byteLength(chunks[0]!));
  } finally {
    release();
    await writing;
    stream.destroy();
  }
  assert.equal(chunks.length, 100);
  assert.equal(stream.writableEnded, false);
  assert.match(chunks.at(-1)!, /progress dropped 100 events/u);
});

test("closing or failing CLI progress output does not cancel the operation", async (t) => {
  for (const failure of [undefined, new Error("output failed")]) {
    await t.test(failure === undefined ? "closed" : "failed", async () => {
      let complete!: (value: string) => void;
      const completion = new Promise<string>((resolve) => {
        complete = resolve;
      });
      const execution = startContractExecution(async (observe) => {
        observe({ kind: "progress-dropped", count: 1 });
        return await completion;
      });
      const stream = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          callback();
          void setImmediate().then(() => this.destroy(failure));
        },
      });
      try {
        await assert.rejects(
          writeExecutionProgress(execution.progress, stream),
          failure ?? { code: "ERR_STREAM_PREMATURE_CLOSE" },
        );
      } finally {
        complete("complete");
        stream.destroy();
      }
      assert.equal(await execution.result, "complete");
    });
  }
});
