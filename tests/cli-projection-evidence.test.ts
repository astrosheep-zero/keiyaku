import assert from "node:assert/strict";
import test from "node:test";
import { namedValueLines } from "../src/cli/render/value.js";
import { renderObservation } from "../src/cli/render/board.js";
import { renderRefusalFacts, renderConflictMaterialized } from "../src/cli/render/refusal.js";
import { gateFact } from "../src/cli/render/contract-observation.js";
import {
  actorId,
  changeId,
  contractId,
  documentKey,
  entryUlid,
  snapshotId,
} from "../src/core/facts/types.js";
import type { ContractHistory, Fact } from "../src/library/contract-types.js";
import { renderText } from "../src/cli/render/text.js";

test("opaque text retains exact keys, types, empty collections, and array member boundaries", () => {
  assert.equal(
    namedValueLines("value", {
      camelCase: "false",
      camel_case: false,
      "camel case": null,
      emptyText: "",
      emptyList: [],
      emptyObject: {},
      rows: [{ x: 1 }, { x: "1" }],
      whitespace: "a\n\tb  c",
    }).join("\n"),
    [
      "value  object (8)",
      '  camelCase  "false"',
      "  camel_case  false",
      '  "camel case"  null',
      '  emptyText  ""',
      "  emptyList  list (0)",
      "  emptyObject  object (0)",
      "  rows  list (2)",
      '    "0"  object (1)',
      "      x  1",
      '    "1"  object (1)',
      '      x  "1"',
      '  whitespace  "a\\n\\tb  c"',
    ].join("\n"),
  );
});

test("opaque strings and keys escape format characters without collapsing distinct values", () => {
  for (const value of [
    "a\u200db",
    "a\ufffdb",
    "\ud83d\udc69\u200d\ud83d\udcbb",
    "\u{e0001}",
    "\u2028\u2029",
    "\u007f",
    "\n\t",
  ]) {
    const line = namedValueLines("value", value)[0]!;
    assert.equal(JSON.parse(line.slice("value  ".length)), value);
    assert.doesNotMatch(line, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  }
  assert.notEqual(namedValueLines("value", "a\u200db")[0], namedValueLines("value", "a\ufffdb")[0]);
  assert.equal(namedValueLines("a\u200db", "x")[0], '"a\\u200db"  "x"');
});

test("observation preserves outer ownership and does not assert success", () => {
  const result = {
    kind: "observation" as const,
    command: "reconcile",
    report: { kind: "failed", contracts: [] },
    lag: [],
  };
  assert.equal(
    renderObservation(result),
    [
      "observation  reconcile",
      "  report  object (2)",
      '    kind  "failed"',
      "    contracts  list (0)",
      "  lag  list (0)",
    ].join("\n"),
  );
  assert.equal(result.report.kind, "failed");
});

test("all four gate bracket states keep the declared gate identity", () => {
  assert.deepEqual(
    [
      gateFact({ gate: "reviewed", current: { kind: "attested", verdict: "satisfied", at: "2026-08-01T00:00:00Z" } }),
      gateFact({ gate: "verified", current: { kind: "attested", verdict: "unsatisfied", at: "2026-08-01T00:00:00Z" } }),
      gateFact({ gate: "security", current: { kind: "stale", priorVerdict: "satisfied" } }),
      gateFact({ gate: "customGate", current: { kind: "missing" } }),
    ],
    ["[✓] reviewed", "[✗] verified", "[~] security (stale)", "[ ] customGate"],
  );
});

test("dirty refusal describes available capture without asserting a current unmerged index", () => {
  const refusal = {
    kind: "dirty-workspace" as const,
    contractId: contractId("kei/dirty"),
    staged: [],
    unstaged: ["file.txt"],
    untracked: [],
    submodules: [],
    shortStat: { filesChanged: 1, insertions: 1, deletions: 0 },
  };
  const output = renderRefusalFacts(refusal, "  ", 120);
  assert.deepEqual(output.slice(-3), [
    "  option  --include-dirty · captures complete non-ignored worktree bytes",
    "  capture index  private · real index unchanged, including any unmerged entries",
    "  staging  not required for --include-dirty",
  ]);
  assert.doesNotMatch(output.join("\n"), /index  unmerged entries remain/u);
  const blocked = renderRefusalFacts({ ...refusal, option: { flag: "--include-dirty", available: false } }, "  ", 120);
  assert.equal(blocked.at(-1), "  option  --include-dirty · unavailable with submodule changes");
  assert.doesNotMatch(blocked.join("\n"), /captures complete/u);
});

test("materialized conflict keeps copyable handoff and target coordinates", () => {
  const base = snapshotId("a".repeat(40));
  const target = snapshotId("b".repeat(40));
  const output = renderConflictMaterialized(
    {
      kind: "integration-conflict-materialized",
      handoffBase: base,
      targetHead: target,
      workspace: { kind: "worktree", path: "/repo/.keiyaku/wt/example" },
      conflictPaths: ["file.txt"],
      recovery: {
        continue: "deliver --include-dirty",
        materialize: "deliver --materialize-conflict --include-dirty",
        staging: "not-required",
      },
    },
    { columns: 30, color: false },
  );
  assert.ok(output.split("\n").includes(`  target  ${target}`));
  assert.ok(output.split("\n").includes(`  handoff base  ${base}`));
  assert.ok(output.split("\n").includes("  deliver  deliver --include-dirty · reads worktree bytes, not index"));
  assert.doesNotMatch(output, /-C |--cwd |please|next/u);
});

test("Contract history keeps event evidence and commit labels without exposing document blobs", () => {
  const id = contractId("kei/history");
  const at = "2026-08-12T00:00:00.000Z";
  const terms = {
    document: { key: documentKey("private-document-blob"), bytes: "private document bytes" },
    segments: [],
    gates: [],
    after: [],
  };
  const base = { v: 1 as const, contract: id, at, actor: actorId("reviewer") };
  const entries = [0, 1, 2].map((value) => entryUlid("0".repeat(25) + value));
  const facts: Fact[] = [
    {
      ...base,
      kind: "bind",
      entry: entries[0]!,
      data: { coordinates: { start: snapshotId("start"), target: "refs/heads/main", workspace: "worktree" }, terms },
    },
    { ...base, kind: "amend", entry: entries[1]!, data: terms },
    {
      ...base,
      kind: "deliver",
      entry: entries[2]!,
      data: {
        tenderSnapshot: snapshotId("tender"),
        integration: {
          predecessor: snapshotId("predecessor"),
          snapshot: snapshotId("integration"),
          changeId: changeId("content-id"),
        },
        method: "squash",
        policy: { requireBranchesToBeUpToDate: false },
      },
    },
  ];
  const history: ContractHistory = {
    id,
    state: snapshotId("private-state"),
    events: facts.map((fact) => ({ source: "journal", fact })),
  };
  const output = renderText({ kind: "contract-history", history });
  assert.equal(
    output,
    [
      "history  kei/history · 3 journal · 0 dispatch",
      "",
      `${at} bind · ${entries[0]} · reviewer`,
      "  start commit  start",
      "  target  refs/heads/main",
      "  workspace  worktree",
      "  gates  0",
      "  after  0",
      `${at} amend · ${entries[1]} · reviewer`,
      "  gates  0",
      "  after  0",
      `${at} deliver · ${entries[2]} · reviewer`,
      "  tender commit  tender",
      "  predecessor commit  predecessor",
      "  integration commit  integration",
      "  content identity (not commit)  content-id",
      "  method  squash",
      "  require-branches-to-be-up-to-date  false",
    ].join("\n"),
  );
  assert.doesNotMatch(output, /private-|\bdocument\b|^\s+(?:snapshot|change) |next|then|please|key=/mu);
  assert.equal(JSON.parse(JSON.stringify(history)).events[0].fact.data.terms.document.key, "private-document-blob");
});
