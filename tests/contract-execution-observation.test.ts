import assert from "node:assert/strict";
import test from "node:test";
import { startContractExecution } from "../src/library/execution.js";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("contract execution starts eagerly and completes without a progress subscription", async () => {
  let started = false;
  const execution = startContractExecution(async () => {
    started = true;
    return "complete";
  });

  await Promise.resolve();
  assert.equal(started, true);
  assert.equal(await execution.result, "complete");
});

test("leaving the only progress subscription does not cancel an execution", async () => {
  const completion = deferred<string>();
  const execution = startContractExecution(async (observe) => {
    observe({ kind: "progress-dropped", count: 1 });
    return await completion.promise;
  });
  const iterator = execution.progress[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), { done: false, value: { kind: "progress-dropped", count: 1 } });
  await iterator.return?.();
  completion.resolve("complete");
  assert.equal(await execution.result, "complete");
});

test("contract execution reports bounded-progress overflow without changing the final result", async () => {
  const completion = deferred<string>();
  const execution = startContractExecution(async (observe) => {
    for (let count = 1; count <= 300; count += 1) observe({ kind: "progress-dropped", count });
    return await completion.promise;
  });
  const iterator = execution.progress[Symbol.asyncIterator]();
  const first = await iterator.next();

  assert.equal(first.done, false);
  assert.equal(first.value?.kind, "progress-dropped");
  assert.ok(first.value !== undefined && first.value.count > 1);
  completion.resolve("complete");
  assert.equal(await execution.result, "complete");
});

test("a rejected result closes observation and a second subscription is refused", async () => {
  const execution = startContractExecution(async () => {
    throw new TypeError("expected rejection");
  });
  const first = execution.progress[Symbol.asyncIterator]();

  assert.throws(() => execution.progress[Symbol.asyncIterator](), /one subscription/u);
  await assert.rejects(execution.result, /expected rejection/u);
  assert.deepEqual(await first.next(), { done: true, value: undefined });
});
