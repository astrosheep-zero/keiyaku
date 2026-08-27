import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskCreationDocument,
  parseTaskDocument,
  serializeTaskDocument,
  TaskAuthorityCorruptionError,
} from "../src/task/document.js";
import { deriveLocalStem, formatTaskId, parseTaskId } from "../src/task/identity.js";

test("task identity normalizes titles, fits new stems by whole words, and supports nested namespaces", () => {
  assert.equal(deriveLocalStem("  Ship Native Task!  "), "ship-native-task");
  assert.equal(deriveLocalStem("one two three four five six seven eight nine ten"), "one-two-three-four-five-six");
  assert.equal(
    deriveLocalStem("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"),
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
  );
  const id = formatTaskId({ namespace: ["contract", "internal"], localId: "ship-native-task" });
  assert.equal(id, "task/contract/internal/ship-native-task");
  assert.deepEqual(parseTaskId(id), { namespace: ["contract", "internal"], localId: "ship-native-task" });
});

test("creation and authority documents contain no Contract association", () => {
  const creation = parseTaskCreationDocument(
    "---\ntitle: Native task\nstate: in_progress\nnote: Initial note\n---\nBody\n",
  );
  assert.equal(creation.state, "in_progress");
  assert.equal(creation.note, "Initial note");
  const coordinate = { namespace: ["nested"], localId: "native-task" } as const;
  const document = {
    ...creation,
    id: formatTaskId(coordinate),
    createdAt: "2026-08-07T01:02:03.004Z",
    updatedAt: "2026-08-07T02:03:04.005Z",
  };
  assert.deepEqual(parseTaskDocument(serializeTaskDocument(document), coordinate), document);
  const defaults = parseTaskCreationDocument("---\ntitle: Defaults\n---\n");
  assert.deepEqual({ state: defaults.state, note: defaults.note }, { state: "open", note: "" });
  assert.throws(
    () => parseTaskCreationDocument("---\ntitle: Bad\ncontractId: null\n---\n"),
    /unknown task front matter key/u,
  );
  assert.throws(
    () => parseTaskCreationDocument("---\ntitle: Bad\ncreatedAt: 2026-08-07T01:02:03.004Z\n---\n"),
    /unknown task front matter key/u,
  );
  assert.throws(
    () => parseTaskCreationDocument("---\ntitle: Bad\ncreatedBy: someone\n---\n"),
    /unknown task front matter key/u,
  );
});

test("optional createdBy is stored before timestamps and rejects blank values", () => {
  const coordinate = { namespace: [], localId: "authored" } as const;
  const document = {
    ...parseTaskCreationDocument("---\ntitle: Authored\n---\n"),
    id: formatTaskId(coordinate),
    createdBy: "aku/worker/deadbeef",
    createdAt: "2026-08-07T01:02:03.004Z",
    updatedAt: "2026-08-07T02:03:04.005Z",
  };
  const bytes = serializeTaskDocument(document);
  const text = Buffer.from(bytes).toString("utf8");
  assert.match(text, /note: ""\ncreatedBy: aku\/worker\/deadbeef\ncreatedAt: /u);
  assert.deepEqual(parseTaskDocument(bytes, coordinate), document);
  const blank = text.replace("aku/worker/deadbeef", "  ");
  assert.throws(() => parseTaskDocument(Buffer.from(blank), coordinate), /createdBy must be a nonblank string/u);
  assert.throws(
    () =>
      parseTaskDocument(
        Buffer.from(text.replace("createdBy: aku/worker/deadbeef\n", "latestActor: someone\n")),
        coordinate,
      ),
    /unknown task front matter key/u,
  );
});

test("task authority is closed and the path owns identity", () => {
  const coordinate = { namespace: [], localId: "expected" } as const;
  const bytes = Buffer.from(
    "---\nid: task/other\ntitle: Wrong\nstate: open\npriority: 2\nneeds: []\nparent: null\nsupersedes: []\nrelates: []\nnote: ''\ncreatedAt: 2026-08-07T01:02:03.004Z\nupdatedAt: 2026-08-07T01:02:03.004Z\n---\n",
  );
  assert.throws(() => parseTaskDocument(bytes, coordinate), TaskAuthorityCorruptionError);
  assert.throws(
    () => parseTaskCreationDocument("---\ntitle: Bad\nid: task/bad\n---\n"),
    /unknown task front matter key/u,
  );
});

test("stored task timestamps are canonical and modification never precedes creation", () => {
  const coordinate = { namespace: [], localId: "timestamped" } as const;
  const document = {
    ...parseTaskCreationDocument("---\ntitle: Timestamped\n---\n"),
    id: formatTaskId(coordinate),
    createdAt: "2026-08-07T01:02:03.004Z",
    updatedAt: "2026-08-07T01:02:03.004Z",
  };
  const noncanonical = Buffer.from(serializeTaskDocument(document))
    .toString("utf8")
    .replace("2026-08-07T01:02:03.004Z", "2026-08-07T01:02:03Z");
  assert.throws(() => parseTaskDocument(Buffer.from(noncanonical), coordinate), /canonical UTC ISO timestamp/u);
  assert.throws(
    () => parseTaskDocument(serializeTaskDocument({ ...document, updatedAt: "2026-08-07T01:02:03.003Z" }), coordinate),
    /must not precede/u,
  );
});
