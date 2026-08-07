import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskCreationDocument, parseTaskDocument, serializeTaskDocument, TaskAuthorityCorruptionError } from "../src/task/document.js";
import { deriveLocalStem, formatTaskId, parseTaskId } from "../src/task/identity.js";

test("task identity normalizes titles, caps local IDs, and supports nested namespaces", () => {
  assert.equal(deriveLocalStem("  Ship Native Task!  "), "ship-native-task");
  assert.ok(Buffer.byteLength(deriveLocalStem("very ".repeat(30))) <= 48);
  const id = formatTaskId({ namespace: ["contract", "internal"], localId: "ship-native-task" });
  assert.equal(id, "task/contract/internal/ship-native-task");
  assert.deepEqual(parseTaskId(id), { namespace: ["contract", "internal"], localId: "ship-native-task" });
});

test("creation and authority documents preserve an opaque nonblank contract association", () => {
  const creation = parseTaskCreationDocument("---\ntitle: Native task\ncontractId: 'external system #42'\n---\nBody\n");
  assert.equal(creation.contractId, "external system #42");
  const coordinate = { namespace: ["nested"], localId: "native-task" } as const;
  const document = { ...creation, id: formatTaskId(coordinate), coordinate, state: "open" as const };
  assert.deepEqual(parseTaskDocument(serializeTaskDocument(document), coordinate), document);
  assert.throws(() => parseTaskCreationDocument("---\ntitle: Bad\ncontractId: '   '\n---\n"), /nonblank string/u);
});

test("task authority is closed and the path owns identity", () => {
  const coordinate = { namespace: [], localId: "expected" } as const;
  const bytes = Buffer.from("---\nid: task/other\ntitle: Wrong\nstate: open\npriority: 2\nneeds: []\nparent: null\nsupersedes: []\nrelates: []\ncontractId: null\n---\n");
  assert.throws(() => parseTaskDocument(bytes, coordinate), TaskAuthorityCorruptionError);
  assert.throws(() => parseTaskCreationDocument("---\ntitle: Bad\nid: task/bad\n---\n"), /unknown task front matter key/u);
});
