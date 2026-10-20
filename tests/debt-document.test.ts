import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDebtCreationDocument,
  parseDebtDocument,
  serializeDebtDocument,
  DebtAuthorityCorruptionError,
  debtStateSchema,
} from "../src/debt/document.js";
import {
  deriveLocalStem,
  formatDebtId,
  parseDebtId,
  physicalDebtSegment,
  DEBT_LOCAL_ID_BYTES,
} from "../src/debt/identity.js";

test("debt identity normalizes titles, fits new stems by whole words, and supports nested namespaces", () => {
  assert.equal(deriveLocalStem("  Ship Native Debt!  "), "ship-native-debt");
  assert.equal(deriveLocalStem("Ship review.v2 notes"), "ship-review.v2-notes");
  assert.equal(deriveLocalStem("one two three four five six seven eight nine ten"), "one-two-three-four-five-six");
  assert.equal(
    deriveLocalStem("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"),
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
  );
  const id = formatDebtId({ namespace: ["contract", "internal"], localId: "ship-native-debt" });
  assert.equal(id, "debt/contract/internal/ship-native-debt");
  assert.deepEqual(parseDebtId(id), { namespace: ["contract", "internal"], localId: "ship-native-debt" });
  const dotted = formatDebtId({ namespace: ["kei", "tell.ask"], localId: "ship-review.v2-notes" });
  assert.equal(dotted, "debt/kei/tell.ask/ship-review.v2-notes");
  assert.deepEqual(parseDebtId(dotted), { namespace: ["kei", "tell.ask"], localId: "ship-review.v2-notes" });
  assert.throws(() => parseDebtId("debt/foo..bar"), /noncanonical segment/u);
});

test("debt physical local-ID budget fits authority and lock components", () => {
  assert.equal(DEBT_LOCAL_ID_BYTES, 240);
  assert.equal(physicalDebtSegment("a".repeat(DEBT_LOCAL_ID_BYTES)), "a".repeat(DEBT_LOCAL_ID_BYTES));
  assert.throws(
    () => physicalDebtSegment("a".repeat(DEBT_LOCAL_ID_BYTES + 1)),
    /debt identity cannot fit the physical filename budget/u,
  );
});

test("optional createdBy is stored before timestamps and rejects blank values", () => {
  const coordinate = { namespace: [], localId: "authored" } as const;
  const document = {
    ...parseDebtCreationDocument("---\ntitle: Authored\n---\n"),
    id: formatDebtId(coordinate),
    createdBy: "aku/worker/deadbeef",
    createdAt: "2026-08-07T01:02:03.004Z",
    updatedAt: "2026-08-07T02:03:04.005Z",
  };
  const bytes = serializeDebtDocument(document);
  const text = Buffer.from(bytes).toString("utf8");
  assert.match(text, /note: ""\ncreatedBy: aku\/worker\/deadbeef\ncreatedAt: /u);
  assert.deepEqual(parseDebtDocument(bytes, coordinate), document);
  const blank = text.replace("aku/worker/deadbeef", "  ");
  assert.throws(() => parseDebtDocument(Buffer.from(blank), coordinate), /createdBy must be a nonblank string/u);
  assert.throws(
    () =>
      parseDebtDocument(
        Buffer.from(text.replace("createdBy: aku/worker/deadbeef\n", "latestActor: someone\n")),
        coordinate,
      ),
    /unknown debt front matter key/u,
  );
});

test("debt authority is closed and the path owns identity", () => {
  const coordinate = { namespace: [], localId: "expected" } as const;
  const bytes = Buffer.from(
    "---\nid: debt/other\ntitle: Wrong\nstate: open\npriority: 2\nneeds: []\nparent: null\nsupersedes: []\nrelates: []\nnote: ''\ncreatedAt: 2026-08-07T01:02:03.004Z\nupdatedAt: 2026-08-07T01:02:03.004Z\n---\n",
  );
  assert.throws(() => parseDebtDocument(bytes, coordinate), DebtAuthorityCorruptionError);
  assert.throws(
    () => parseDebtCreationDocument("---\ntitle: Bad\nid: debt/bad\n---\n"),
    /unknown debt front matter key/u,
  );
});

test("Debt states are a closed ledger vocabulary and corrupt state names remain visible", () => {
  assert.deepEqual(debtStateSchema.options, ["open", "done", "drop"]);
  const coordinate = { namespace: [], localId: "state" } as const;
  const document = {
    ...parseDebtCreationDocument("---\ntitle: State\n---\n"),
    id: formatDebtId(coordinate),
    createdAt: "2026-08-07T01:02:03.004Z",
    updatedAt: "2026-08-07T01:02:03.004Z",
  };
  const invalid = Buffer.from(serializeDebtDocument(document))
    .toString("utf8")
    .replace("state: open", "state: unknown");
  assert.throws(
    () => parseDebtDocument(Buffer.from(invalid), coordinate),
    (error: unknown) => {
      assert.ok(error instanceof DebtAuthorityCorruptionError);
      assert.equal(error.coordinate, document.id);
      assert.match(error.message, /debt state is invalid: unknown/u);
      return true;
    },
  );
});

test("stored debt timestamps are canonical and modification never precedes creation", () => {
  const coordinate = { namespace: [], localId: "timestamped" } as const;
  const document = {
    ...parseDebtCreationDocument("---\ntitle: Timestamped\n---\n"),
    id: formatDebtId(coordinate),
    createdAt: "2026-08-07T01:02:03.004Z",
    updatedAt: "2026-08-07T01:02:03.004Z",
  };
  const noncanonical = Buffer.from(serializeDebtDocument(document))
    .toString("utf8")
    .replace("2026-08-07T01:02:03.004Z", "2026-08-07T01:02:03Z");
  assert.throws(() => parseDebtDocument(Buffer.from(noncanonical), coordinate), /canonical UTC ISO timestamp/u);
  assert.throws(
    () => parseDebtDocument(serializeDebtDocument({ ...document, updatedAt: "2026-08-07T01:02:03.003Z" }), coordinate),
    /must not precede/u,
  );
});
