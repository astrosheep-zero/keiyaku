import assert from "node:assert/strict";
import test from "node:test";
import {
  completeTaskDocument,
  parseTaskCreationDocument,
  parseTaskDocument,
  serializeTaskDocument,
  TaskAuthorityCorruptionError,
} from "../src/task/document.js";
import { deriveLocalStem, formatTaskId, parseTaskId, taskAuthorityRelativePath } from "../src/task/identity.js";

test("task identity normalizes titles, caps local IDs, and supports nested namespaces", () => {
  assert.equal(deriveLocalStem("  Ship Native Task!  "), "ship-native-task");
  assert.ok(Buffer.byteLength(deriveLocalStem("very ".repeat(30))) <= 48);
  const id = formatTaskId({ namespace: ["contract", "internal"], localId: "ship-native-task" });
  assert.equal(id, "task/contract/internal/ship-native-task");
  assert.deepEqual(parseTaskId(id), { namespace: ["contract", "internal"], localId: "ship-native-task" });
  assert.equal(taskAuthorityRelativePath(id), ".keiyaku/tasks/contract/internal/ship-native-task.md");
});

test("delivery completion changes only Task state and preserves canonical content", () => {
  const coordinate = { namespace: ["contract", "internal"], localId: "complete-me" } as const;
  const document = {
    ...parseTaskCreationDocument([
      "---",
      "title: Complete me",
      "state: in_progress",
      "priority: 1",
      "note: Preserve this note",
      "---",
      "Body with trailing whitespace.  ",
      "",
    ].join("\n")),
    id: formatTaskId(coordinate),
    createdAt: "2026-08-07T01:02:03.004Z",
    updatedAt: "2026-08-08T02:03:04.005Z",
  };
  const before = serializeTaskDocument(document);
  const completed = completeTaskDocument(before, coordinate);

  assert.equal(
    Buffer.from(completed).toString("utf8"),
    Buffer.from(before).toString("utf8").replace("state: in_progress\n", "state: done\n"),
  );
  assert.deepEqual(parseTaskDocument(completed, coordinate), { ...document, state: "done" });
  assert.throws(() => completeTaskDocument(completed, coordinate), /terminal state: done/u);
});

test("creation and authority documents contain no Contract association", () => {
  const creation = parseTaskCreationDocument("---\ntitle: Native task\nstate: in_progress\nnote: Initial note\n---\nBody\n");
  assert.equal(creation.state, "in_progress");
  assert.equal(creation.note, "Initial note");
  const coordinate = { namespace: ["nested"], localId: "native-task" } as const;
  const document = { ...creation, id: formatTaskId(coordinate), createdAt: "2026-08-07T01:02:03.004Z", updatedAt: "2026-08-07T02:03:04.005Z" };
  assert.deepEqual(parseTaskDocument(serializeTaskDocument(document), coordinate), document);
  const defaults = parseTaskCreationDocument("---\ntitle: Defaults\n---\n");
  assert.deepEqual({ state: defaults.state, note: defaults.note }, { state: "open", note: "" });
  assert.throws(() => parseTaskCreationDocument("---\ntitle: Bad\ncontractId: null\n---\n"), /unknown task front matter key/u);
  assert.throws(() => parseTaskCreationDocument("---\ntitle: Bad\ncreatedAt: 2026-08-07T01:02:03.004Z\n---\n"), /unknown task front matter key/u);
});

test("task authority is closed and the path owns identity", () => {
  const coordinate = { namespace: [], localId: "expected" } as const;
  const bytes = Buffer.from("---\nid: task/other\ntitle: Wrong\nstate: open\npriority: 2\nneeds: []\nparent: null\nsupersedes: []\nrelates: []\nnote: ''\ncreatedAt: 2026-08-07T01:02:03.004Z\nupdatedAt: 2026-08-07T01:02:03.004Z\n---\n");
  assert.throws(() => parseTaskDocument(bytes, coordinate), TaskAuthorityCorruptionError);
  assert.throws(() => parseTaskCreationDocument("---\ntitle: Bad\nid: task/bad\n---\n"), /unknown task front matter key/u);
});

test("stored task timestamps are canonical and modification never precedes creation", () => {
  const coordinate = { namespace: [], localId: "timestamped" } as const;
  const document = {
    ...parseTaskCreationDocument("---\ntitle: Timestamped\n---\n"), id: formatTaskId(coordinate),
    createdAt: "2026-08-07T01:02:03.004Z", updatedAt: "2026-08-07T01:02:03.004Z",
  };
  const noncanonical = Buffer.from(serializeTaskDocument(document)).toString("utf8").replace("2026-08-07T01:02:03.004Z", "2026-08-07T01:02:03Z");
  assert.throws(() => parseTaskDocument(Buffer.from(noncanonical), coordinate), /canonical UTC ISO timestamp/u);
  assert.throws(
    () => parseTaskDocument(serializeTaskDocument({ ...document, updatedAt: "2026-08-07T01:02:03.003Z" }), coordinate),
    /must not precede/u,
  );
});
