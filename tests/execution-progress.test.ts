import assert from "node:assert/strict";
import test from "node:test";
import { executionProgressLines } from "../src/cli/render/execution-progress.js";
import type { ExecutionObservation } from "../src/index.js";
import { contractId, snapshotId } from "../src/core/facts/types.js";

const coordinate = {
  snapshot: snapshotId("a".repeat(40)),
  requirement: `verification:sha256:${"b".repeat(64)}`,
  index: 2,
  total: 3,
};
const context = { columns: 400, color: false };

function event(observation: Extract<ExecutionObservation, { kind: "verification" }>["observation"]): ExecutionObservation {
  return { kind: "verification", contractId: contractId("kei/compact-progress"), snapshot: coordinate.snapshot, observation };
}

test("completed phases retain check, hook, timing and failure facts without duplicating native identities", () => {
  const setup = event({ ...coordinate, kind: "phase", phase: "setup", state: "finished",
    name: "install dependencies", elapsedMs: 42_000, outcome: "exit 7" });
  assert.deepEqual(executionProgressLines(setup, context),
    ["× setup · check 2/3 · install dependencies · 42s · exit 7"]);
  const declaration = event({ ...coordinate, kind: "phase", phase: "declaration", state: "finished",
    elapsedMs: 1_000, outcome: "exit 0" });
  assert.deepEqual(executionProgressLines(declaration, context), ["✓ declaration 2/3 · 1s"]);
  assert.deepEqual(executionProgressLines(event({ ...coordinate, kind: "phase", phase: "setup", state: "started" }), context), []);
  assert.equal(JSON.parse(JSON.stringify(setup)).observation.requirement, coordinate.requirement);
  assert.equal(JSON.parse(JSON.stringify(setup)).observation.snapshot, coordinate.snapshot);
});

test("producer stdout and stderr remain distinct factual output", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    assert.deepEqual(executionProgressLines(event({ ...coordinate, kind: "output", phase: "declaration", stream,
      text: "first line\nsecond line" }), context), [stream, "  first line", "  second line"]);
  }
});
