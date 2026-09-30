import assert from "node:assert/strict";
import test from "node:test";
import { InvocationAccumulator } from "../src/library/outcome.js";
import { bind, commitCandidate, acceptedDelivery, repositoryWithMain } from "./support/library-verbs.js";
import { deferred } from "./support/process.js";
import type { ExecutionObservation } from "../src/index.js";

test("callback observations preserve order and transported gaps without subscription state", () => {
  const observed: ExecutionObservation[] = [];
  const progress = new InvocationAccumulator((event) => { observed.push(event); });
  for (const count of [1, 300, 2]) progress.observe({ kind: "progress-dropped", count });
  assert.deepEqual(observed, [1, 300, 2].map((count) => ({ kind: "progress-dropped", count })));
});

test("synchronous and asynchronous observer failures cannot change delivery admission or completion", async () => {
  for (const observer of [() => { throw new TypeError("observer failure"); }, async () => { throw new TypeError("observer rejection"); }]) {
    const repository = repositoryWithMain();
    const contract = await bind(repository);
    commitCandidate(repository);
    const outcome = acceptedDelivery(await contract.deliver({}, { observe: observer }));
    assert.ok(outcome.facts.some((fact) => fact.kind === "deliver"));
    assert.equal(outcome.value.leading.kind, "admitted-now");
  }
});

test("slow observers and callers that stop observing never delay or cancel delivery", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  commitCandidate(repository);
  const barrier = deferred<void>();
  let seen = 0;
  try {
    const outcome = acceptedDelivery(await contract.deliver({}, { observe: () => {
      seen += 1;
      return barrier.promise;
    } }));
    assert.ok(seen > 0);
    assert.ok(outcome.facts.some((fact) => fact.kind === "deliver"));
  } finally { barrier.resolve(); }
});
