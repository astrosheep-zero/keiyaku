import assert from "node:assert/strict";
import test from "node:test";
import { ProviderEventSchema, type ProviderEvent } from "@getpaseo/plugin/server/provider";
import { historySchema, type History, type Row } from "../plugins/paseo/plugin/server/keiyaku.js";
import { createMirror } from "../plugins/paseo/plugin/server/mirror.js";

const at = "2026-10-15T00:00:00.000Z";
/**
 * One complete bounded window, exactly as the stream reports each frame. The
 * mirror's input is the producer's own row shape, so these fixtures hand the
 * mirror the identity fields the installed projection reports of its vintage.
 */
function window(rows: Row[]): History {
  return historySchema.parse({ rows, omitted: 0, hasEarlier: false, hasLater: false, historyLost: false,
    lowestRetained: rows[0]?.sequence ?? null, highest: Math.max(0, ...rows.map((row) => row.sequence)) });
}
const turn = (sequence: number, turnSequence = sequence): Row => ({ kind: "turn", sequence, turnSequence, at });
const failed = (sequence: number, turnSequence: number): Row => ({ kind: "outcome", sequence, turnSequence, at,
  outcome: { kind: "failed", diagnostic: "turn failed" } });
const read = { kind: "read", path: "same.ts", offset: 2, limit: 4 } as const;
const tool = (sequence: number, state: Extract<Row, { kind: "tool" }>["state"], toolId?: string, turnSequence = 1): Row =>
  ({ kind: "tool", sequence, turnSequence, at, name: "read", call: read, state,
    ...(toolId === undefined ? {} : { toolId }) });

function collect(): Readonly<{ events: ProviderEvent[]; mirror: ReturnType<typeof createMirror> }> {
  const events: ProviderEvent[] = [];
  const mirror = createMirror("session", (event) => { ProviderEventSchema.parse(event); events.push(event); });
  return { events, mirror };
}
const items = (events: ProviderEvent[]) => events.flatMap((event) => event.type === "timeline.item" ? [event.item] : []);

test("actual producer ids keep identical overlapping tool calls distinct across completion order and Turn scope", () => {
  const { events, mirror } = collect();
  mirror.publish(window([turn(1), tool(2, "active", "a"), tool(3, "active", "b")]));
  mirror.publish(window([turn(1), tool(2, "active", "a"), tool(4, { status: "error", message: "permission denied" }, "b")]));
  mirror.publish(window([turn(1), tool(2, { status: "ok", message: "same content" }, "a"),
    tool(4, { status: "error", message: "permission denied" }, "b")]));
  // An identical window republishes nothing, however often it is observed.
  mirror.publish(window([turn(1), tool(2, { status: "ok", message: "same content" }, "a"),
    tool(4, { status: "error", message: "permission denied" }, "b")]));
  mirror.publish(window([turn(1), tool(2, { status: "ok", message: "same content" }, "a"),
    tool(4, { status: "error", message: "permission denied" }, "b"), failed(6, 1), turn(7),
    tool(8, "active", "a", 7)]));
  const calls = items(events).flatMap((item) => item.type === "tool_call" ? [item] : []);
  assert.deepEqual(calls.map((item) => [item.callId, item.status]), [
    ["tool/1/a", "running"], ["tool/1/b", "running"], ["tool/1/b", "failed"],
    ["tool/1/a", "completed"], ["tool/7/a", "running"],
  ]);
  assert.deepEqual(calls[2]?.error, { status: "error", message: "permission denied" });
  assert.deepEqual(calls[3]?.detail, { type: "read", filePath: "same.ts", offset: 2, limit: 4, content: "same content" });
});

test("a producer without tool identity reports observation instead of guessing a pairing", () => {
  const { events, mirror } = collect();
  mirror.publish(window([turn(1), tool(2, "active"), tool(3, { status: "ok", message: "settled" })]));
  assert.deepEqual(items(events), [
    { type: "notification", id: "keiyaku:tool/2", level: "info",
      message: 'read: start observed. {"kind":"read","path":"same.ts","offset":2,"limit":4}' },
    { type: "tool_call", id: "keiyaku:tool/record/3", callId: "tool/record/3", name: "read", status: "completed",
      detail: { type: "read", filePath: "same.ts", offset: 2, limit: 4, content: "settled" },
      metadata: { turnSequence: 1, sequence: 3, call: read, state: { status: "ok", message: "settled" } },
      error: null },
  ]);
  assert.deepEqual(items(events).map((_, index) => events.filter((event) => event.type === "timeline.item")[index]?.timestamp),
    [at, at], "a record without producer identity keeps the producer's own timestamp");
});

test("generic invocation previews, truncation, exact results and thought output survive the decoder", () => {
  const { events, mirror } = collect();
  const invocation = { kind: "other" as const, display: "fetch", input: { json: '{"url":"https://example.com"}', truncated: true } };
  mirror.publish(window([turn(1),
    { kind: "thought", sequence: 2, turnSequence: 1, at, text: "checking source", truncated: true },
    { kind: "tool", sequence: 3, turnSequence: 1, at, name: "fetch", toolId: "fetch", call: invocation,
      state: { status: "ok", message: "bounded response" }, truncated: true },
    { kind: "note", sequence: 4, turnSequence: 1, at, text: "compacted context" },
  ]));
  const observed = items(events);
  assert.deepEqual(observed[0], { type: "reasoning", id: "keiyaku:thought/2", text: "checking source" });
  const call = observed[1];
  assert.ok(call?.type === "tool_call");
  assert.deepEqual(call.detail, { type: "unknown", input: invocation, output: { status: "ok", message: "bounded response" } });
  assert.equal(call.metadata?.truncated, true);
  assert.deepEqual(call.metadata?.call, invocation);
  assert.deepEqual(observed[2], { type: "notification", id: "keiyaku:note/4", level: "info", message: "compacted context" });
});

const run = { kind: "run", command: "npm test" } as const;
const patch = "@@ -1,2 +1,2 @@\n-const answer = 1;\n+const answer = 2;\n";
const callsOf = (events: ProviderEvent[]) =>
  items(events).flatMap((item) => item.type === "tool_call" ? [item] : []);

test("a result's own output is displayed and an honestly empty one is never replaced by its diagnostic", () => {
  const { events, mirror } = collect();
  mirror.publish(window([turn(1),
    { kind: "tool", sequence: 2, turnSequence: 1, at, name: "bash", toolId: "a", call: run,
      state: { status: "ok", message: "legacy diagnostic", output: "3 passing\n", exitCode: 0 } },
    { kind: "tool", sequence: 3, turnSequence: 1, at, name: "bash", toolId: "b", call: run,
      state: { status: "ok", message: "legacy diagnostic", exitCode: 0 } },
    { kind: "tool", sequence: 4, turnSequence: 1, at, name: "read", toolId: "c",
      call: { kind: "read", path: "src/a.ts" }, state: { status: "ok", message: "stale diagnostic", output: "" } },
    { kind: "tool", sequence: 5, turnSequence: 1, at, name: "grep", toolId: "d",
      call: { kind: "search", query: "needle" }, state: { status: "ok", output: "src/a.ts:1:needle" } },
    { kind: "tool", sequence: 6, turnSequence: 1, at, name: "bash", toolId: "e", call: run,
      state: { status: "ok" } },
  ]));
  assert.deepEqual(callsOf(events).map((call) => call.detail), [
    { type: "shell", command: "npm test", output: "3 passing\n", exitCode: 0 },
    { type: "shell", command: "npm test", output: "legacy diagnostic", exitCode: 0 },
    { type: "read", filePath: "src/a.ts", content: "" },
    { type: "search", query: "needle", content: "src/a.ts:1:needle" },
    { type: "shell", command: "npm test" },
  ], "a record written before the output field still falls back to its diagnostic");
});

test("one observed file patch is a native edit detail", () => {
  const { events, mirror } = collect();
  mirror.publish(window([turn(1),
    { kind: "tool", sequence: 2, turnSequence: 1, at, name: "edit", toolId: "a",
      call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts", diffstat: { added: 1, removed: 1 }, patch }] },
      state: { status: "ok", output: "edited src/a.ts" } },
    // An empty patch is present, not absent, so it stays a diff rather than
    // collapsing into the diagnostic fallback the producer never wrote.
    { kind: "tool", sequence: 3, turnSequence: 1, at, name: "edit", toolId: "b",
      call: { kind: "fileChange", changes: [{ op: "update", path: "src/b.ts", patch: "" }] },
      state: { status: "ok", output: "edited src/b.ts" } },
  ]));
  assert.deepEqual(callsOf(events).map((call) => call.detail), [
    { type: "edit", filePath: "src/a.ts", unifiedDiff: patch },
    { type: "edit", filePath: "src/b.ts", unifiedDiff: "" },
  ]);
  assert.deepEqual(callsOf(events).map((call) => call.status), ["completed", "completed"]);
});

test("multi-file changes and a missing patch keep every file in the fallback detail", () => {
  const { events, mirror } = collect();
  const changes = [
    { op: "update" as const, path: "src/a.ts", patch },
    { op: "add" as const, path: "src/b.ts", patch: "@@ -0,0 +1 @@\n+export {};\n" },
  ];
  mirror.publish(window([turn(1),
    { kind: "tool", sequence: 2, turnSequence: 1, at, name: "apply_patch", toolId: "a",
      call: { kind: "fileChange", changes }, state: { status: "ok", output: "applied 2 files" } },
    { kind: "tool", sequence: 3, turnSequence: 1, at, name: "edit", toolId: "b",
      call: { kind: "fileChange", changes: [{ op: "update", path: "src/c.ts" }] },
      state: { status: "error", message: "no patch reported", output: "partial" } },
  ]));
  assert.deepEqual(callsOf(events).map((call) => call.detail), [
    { type: "unknown", input: { kind: "fileChange", changes }, output: { status: "ok", output: "applied 2 files" } },
    { type: "unknown", input: { kind: "fileChange", changes: [{ op: "update", path: "src/c.ts" }] },
      output: { status: "error", message: "no patch reported", output: "partial" } },
  ], "no single file stands in for the whole operation");
  assert.deepEqual(callsOf(events).map((call) => call.status), ["completed", "failed"]);
});

test("a producer's own truncation marker stays in the displayed text, not only in metadata", () => {
  const { events, mirror } = collect();
  const marked = "line\n…[truncated]";
  mirror.publish(window([turn(1),
    { kind: "tool", sequence: 2, turnSequence: 1, at, name: "bash", toolId: "a", call: run,
      state: { status: "ok", output: marked }, truncated: true },
    { kind: "tool", sequence: 3, turnSequence: 1, at, name: "edit", toolId: "b",
      call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts", patch: `${patch}…[truncated]` }] },
      state: { status: "ok", output: marked }, truncated: true },
  ]));
  assert.deepEqual(callsOf(events).map((call) => call.detail), [
    { type: "shell", command: "npm test", output: marked },
    { type: "edit", filePath: "src/a.ts", unifiedDiff: `${patch}…[truncated]` },
  ], "the marker travels with the text it truncates");
  assert.deepEqual(callsOf(events).map((call) => call.metadata?.truncated), [true, true]);
});
