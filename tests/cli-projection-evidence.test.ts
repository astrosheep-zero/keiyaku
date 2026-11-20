import {
  contractDetail,
  runCli,
} from "./support/cli-fixtures.js";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import test from "node:test";
import { namedValueLines } from "../src/cli/render/value.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { gateRequirementFacts } from "../src/cli/render/contract-observation.js";
import { requirementLines } from "../src/cli/render/receipt.js";
import { modelOutputSchemas as mcpOutputSchemas } from "../src/library/model-tools.js";
import { verifyOutcomeSchema } from "../src/library/contract-outcomes.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { renderContractHistory } from "../src/cli/render/contract-history.js";
import {
  contractId,
  gate,
  requirementId,
  snapshotId,
} from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";
import type { ContractHistory } from "../src/library/contract-types.js";

test("spawn preserves a definition failure instead of reporting a missing Akuma", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-cli-definition-");
  const home = join(root, "home");
  const definitions = join(home, "akumas");
  mkdirSync(definitions, { recursive: true });
  const invalidPath = join(definitions, "broken.md");
  writeFileSync(invalidPath, "---\nprovider: false\n---\n");
  const runtime = { cwd: root, environment: { KEIYAKU_HOME: home } };
  const missing = await runCli(["spawn", "missing", "go"], runtime);
  assert.equal(missing.exit, 1);
  assert.match(missing.stdout, /reason  Akuma not found · missing/u);
  assert.match(missing.stdout, /available  keiyaku ls aku\//u);
  const missingJson = await runCli(["spawn", "missing", "go", "--json"], runtime);
  assert.equal(missingJson.exit, 1);
  assert.deepEqual(JSON.parse(missingJson.stdout), {
    kind: "refused",
    diagnostic: "Akuma not found",
    akumaName: "missing",
    searched: [join(realpathSync(root), ".keiyaku", "akumas", "missing.md"), join(definitions, "missing.md")],
    available: "keiyaku ls aku/",
    next: { verb: "ls", input: { selector: "aku/" } },
  });
  const invalid = await runCli(["spawn", "broken", "go"], runtime);
  assert.equal(invalid.exit, 1);
  assert.match(invalid.stdout, /reason  is invalid: Akuma provider must be a nonblank string · broken/u);
  assert.ok(invalid.stdout.includes(`searched  ${invalidPath}`));
  const json = await runCli(["spawn", "broken", "go", "--json"], runtime);
  assert.equal(json.exit, 1);
  assert.deepEqual(JSON.parse(json.stdout), {
    kind: "refused",
    diagnostic: "is invalid: Akuma provider must be a nonblank string",
    akumaName: "broken",
    searched: [invalidPath],
  });
});

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

test("selected Contract status preserves every supplied requirement and workspace fact across phases", () => {
  const path = `/repo/${"long-directory/".repeat(10)}`;
  const at = "2026-08-12T00:00:00.000Z";
  const failed = { kind: "attested", verdict: "unsatisfied", summary: "Second check failed", at } as const;
  const report = contractDetail({
    delivery: { candidate: snapshotId("a".repeat(40)), integration: snapshotId("b".repeat(40)) },
    gates: [{ gate: "verified", current: "unsatisfied", requirements: [
      { index: 1, requirement: requirementId("check-pass"), current: { kind: "attested", verdict: "satisfied", summary: "First check passed", at } },
      { index: 2, requirement: requirementId("check-fail"), current: failed },
      { index: 3, requirement: requirementId("check-missing"), current: { kind: "missing" } },
      { index: 4, requirement: requirementId("check-stale"), current: { kind: "stale", priorVerdict: "satisfied", reason: {
        kind: "snapshot-changed", previousSnapshot: snapshotId("c".repeat(40)), currentSnapshot: snapshotId("d".repeat(40)),
      } } },
    ] }],
    after: [{ contractId: contractId("kei/prerequisite"), state: "abandoned" }],
    workspace: { kind: "unavailable", path },
    issue: { kind: "unavailable", diagnostic: "checkout read failed" },
    associations: [
      { kind: "unavailable", source: "holder", diagnostic: "holder read failed" },
      { akumaId: parseAkumaId("aku/worker/11112222").id },
    ],
  });
  const expectedFacts = [
    "holder  unavailable · holder read failed",
    "candidate  aaaaaaa",
    "integration result  bbbbbbb",
    "verification 1 · current · satisfied",
    "verification 2 · current · unsatisfied",
    "verification 3 · missing",
    "verification 4 · stale · snapshot changed ccccccc -> ddddddd",
    "blocked by  kei/prerequisite · abandoned",
    `worktree  ${path}`,
    "workspace  unavailable",
    "checkout unavailable · checkout read failed",
    "akuma  aku/worker/11112222",
    "verification 1 summary\n    First check passed",
    "verification 2 summary\n    Second check failed",
  ];
  for (const phase of ["bound", "claimed", "abandoned"] as const) {
    const text = renderKanshiText({ ...report, phase }, { columns: 80, color: false });
    let previous = -1;
    for (const fact of expectedFacts) {
      const position = text.indexOf(fact);
      assert.ok(position > previous, `${phase} retains ordered fact: ${fact}`);
      assert.equal(text.split(fact).length - 1, 1, `${fact} appears once`);
      previous = position;
    }
    assert.equal(JSON.parse(JSON.stringify({ ...report, phase })).workspace.path, path);
  }
});

test("Contract history renders semantic evidence and explicitly requested historical terms", () => {
  const contract = contractId("kei/history");
  const at = "2026-08-12T00:00:00.000Z";
  const id = "1";
  const history: Extract<ContractHistory, { kind: "contract" }> = {
    kind: "contract",
    contractId: contract,
    events: [
      {
        kind: "bind",
        id,
        at,
        start: snapshotId("start"),
        target: "refs/heads/main",
        gates: [],
        after: [],
        document: "exact historical terms",
      },
      {
        kind: "attestation",
        id: "2",
        at,
        gate: gate("verified"),
        requirement: requirementId("verification:sha256:original-check"),
        verdict: "satisfied",
        subject: dependencyKeySet([{ kind: "snapshot", value: snapshotId("4".repeat(40)) }]),
      },
    ],
  };
  const ordinary = renderContractHistory(history);
  assert.match(ordinary, /bound to main @ start/u);
  assert.match(ordinary, /verification verification:sha256:original-check · subject snapshot 4444444/u);
  assert.doesNotMatch(ordinary, /exact historical terms/u);
  const full = history.events.map(event => {
    assert.notEqual(event.kind, "dispatch");
    if (event.kind === "dispatch") throw new Error("expected journal record");
    return renderContractHistory({ kind: "contract-exact", contractId: contract, event });
  }).join("\n");
  assert.match(full, /exact historical terms/u);
  assert.match(full, /subject  snapshot 4444444/u);
  assert.equal(JSON.parse(JSON.stringify(history)).events[0].document, "exact historical terms");
});

test("stale snapshot evidence keeps native identities across observations, receipts, JSON and MCP", () => {
  const reason = {
    kind: "snapshot-changed" as const,
    previousSnapshot: snapshotId("abcdef01" + "1".repeat(32)),
    currentSnapshot: snapshotId("abcdef02" + "2".repeat(32)),
  };
  const current = { kind: "stale", priorVerdict: "satisfied", reason } as const;
  const requirement = requirementId("verification:sha256:historical-check");
  assert.deepEqual(gateRequirementFacts({
    gate: "verified", current: "stale", requirements: [{ requirement, index: 2, current }],
  }), ["verification 2 · stale · snapshot changed abcdef01 -> abcdef02"]);
  const problem = { gate: "verified", requirement, state: "stale" as const, reason };
  const receipt = requirementLines([problem]).join("\n");
  assert.ok(receipt.includes(`requirement  verification:sha256:historical-check`), "unmapped historical requirements keep a stable coordinate");
  assert.match(receipt, /^  gate {2}verified$/mu);
  assert.match(receipt, /^  state {2}stale$/mu);
  assert.match(receipt, /^  stale reason {2}snapshot changed$/mu);
  assert.ok(receipt.includes(`previous snapshot  ${reason.previousSnapshot}`));
  assert.ok(receipt.includes(`current snapshot  ${reason.currentSnapshot}`));
  const value = {
    kind: "accepted" as const, contractId: contractId("kei/snapshot-reason"),
    snapshot: reason.previousSnapshot, checks: [],
    placement: { kind: "gates-unsatisfied" as const, unmet: [problem] },
  };
  assert.deepEqual(verifyOutcomeSchema.parse(value), value);
  const projected = JSON.parse(JSON.stringify(value));
  assert.deepEqual(mcpOutputSchemas.verify.parse(projected), projected);
  assert.deepEqual((projected as typeof value).placement.unmet[0]?.reason, reason);
});
