import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { createExecutionProgressRenderer } from "../src/cli/render/execution-progress.js";
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

test("completed phases retain native check, hook, timing and failure facts", async () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  const renderer = createExecutionProgressRenderer({ stream, context });
  renderer.observe(event({ ...coordinate, kind: "phase", phase: "setup", state: "started", name: "install dependencies" }));
  renderer.observe(event({ ...coordinate, kind: "phase", phase: "setup", state: "finished",
    name: "install dependencies", elapsedMs: 42_000, outcome: "exit 7" }));
  renderer.observe(event({ ...coordinate, kind: "phase", phase: "declaration", state: "finished",
    elapsedMs: 1_000, outcome: "exit 0" }));
  renderer.observe(event({ ...coordinate, kind: "phase", phase: "cleanup", state: "finished" }));
  await renderer.finish();
  assert.equal(text, "× setup · check 2/3 · install dependencies · 42s · exit 7\n✓ declaration 2/3 · 1s\n? cleanup · check 2/3\n");
});

test("phase blocks and hook names remain terminal-safe factual output", async () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  const renderer = createExecutionProgressRenderer({ stream, context });
  renderer.observe(event({ ...coordinate, kind: "output", phase: "declaration", stream: "stderr", text: "error\u001b[2K" }));
  renderer.observe(event({ ...coordinate, kind: "output", phase: "declaration", stream: "stdout", text: "first line\nsecond line" }));
  renderer.observe(event({ ...coordinate, kind: "phase", phase: "cleanup", state: "finished", name: "hook\u001b[2K", outcome: "exit 7\r" }));
  await renderer.finish();
  assert.match(text, /^stdout\n  first line\n  second line\nstderr\n/u);
  assert.doesNotMatch(text, /[\u001b\r]/u);
  assert.match(text, /cleanup · check 2\/3 · hook/u);
});
