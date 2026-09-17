import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { invoke as invokeRaw } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
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

test("closing or failing CLI progress output does not cancel the operation", async (t) => {
  for (const failure of [undefined, new Error("output failed")]) {
    await t.test(failure === undefined ? "closed" : "failed", async () => {
      const { promise: completion, resolve: complete } = promiseBarrier<string>();
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
