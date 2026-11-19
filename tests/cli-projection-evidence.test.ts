import {
  acceptedReceipt,
  contractCatalog,
  contractDetail,
  contractReport,
  contractSummary,
  kanshiReport,
  runCli,
} from "./support/cli-fixtures.js";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import test from "node:test";
import { namedValueLines } from "../src/cli/render/value.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { renderContractCatalogue } from "../src/cli/render/catalog.js";
import { gateRequirementFacts } from "../src/cli/render/contract-observation.js";
import { requirementLines } from "../src/cli/render/receipt.js";
import { modelOutputSchemas as mcpOutputSchemas } from "../src/library/model-tools.js";
import { verifyOutcomeSchema } from "../src/library/contract-outcomes.js";
import { akumaObservationSchema } from "../src/akuma/selection-observation.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { renderContractHistory } from "../src/cli/render/contract-history.js";
import { renderSettingsText } from "../src/cli/render/settings.js";
import { renderBindDraftReceipt } from "../src/cli/render/refusal.js";
import {
  changeId,
  contractId,
  gate,
  requirementId,
  snapshotId,
} from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";
import type { ContractHistory } from "../src/library/contract-types.js";
import type { ContractSummary } from "../src/index.js";
import type { Settings } from "../src/settings.js";

test("model status retains native current work, turn coordinates and reported changes", () => {
  const value = akumaObservationSchema.parse({
    kind: "akuma", id: "aku/worker/12345678", life: "running", cwd: "/work", provider: "fixture",
    work: {
      kind: "open", turn: { sequence: 1, bodySequence: 1 },
      activeTools: [{ id: 2, turnSequence: 1, toolId: "read" }], latestActivity: 3,
      summary: { id: 2, text: "read source.ts" }, pending: [{ id: 3, tellId: "next" }],
      outcome: { historyId: "turn/1", activityId: 4, verdict: "answered" },
    },
    changes: [{ path: "source.ts", diffstat: { added: 2, removed: 1 } }],
    moreChanges: true, outsideChanges: 1,
  });
  const projected = JSON.parse(JSON.stringify(value));
  assert.deepEqual(projected.changes, value.changes);
  assert.equal(projected.moreChanges, true);
  assert.equal(projected.outsideChanges, 1);
  assert.equal(projected.kind, "akuma");
  assert.deepEqual(projected.work, value.work);
  assert.deepEqual(mcpOutputSchemas.status.parse(projected), projected);
});

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

test("settings text retains shadow provenance and exact configuration names", () => {
  const entries = {
    local: { source: "project" as const, shadows: true as const, value: { env: { LONG_VALUE: "false" } } },
  };
  const value: Settings = {
    scopes: {
      user: { kind: "read", path: "/user/settings.json" },
      project: { kind: "read", path: "/repo/settings.json" },
    },
    namespaces: { providers: { kind: "read", entries } },
    namespace: () => ({ kind: "read", entries }),
  };
  assert.equal(
    renderSettingsText(value),
    [
      "settings",
      "  user  read  /user/settings.json",
      "  project  read  /repo/settings.json",
      "  namespace  providers  read",
      "    entry  local · project · shadows user",
      "      value  object (1)",
      "        env  object (1)",
      '          LONG_VALUE  "false"',
    ].join("\n"),
  );
});

test("selected Contract status preserves every supplied requirement and workspace fact across phases", () => {
  const path = `/repo/${"long-directory/".repeat(10)}`;
  const at = "2026-08-12T00:00:00.000Z";
  const failed = { kind: "attested", verdict: "unsatisfied", summary: "Second check failed", at } as const;
  const report = contractDetail({
    holder: { kind: "unavailable" },
    delivery: { candidate: snapshotId("a".repeat(40)), integration: snapshotId("b".repeat(40)) },
    gates: [{ gate: "verified", satisfied: false, current: failed, requirements: [
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
    roster: [{ id: "aku/worker/11112222" }],
  });
  const expectedFacts = [
    "holder  unavailable",
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

const recoveryContext = { columns: 120, color: false, recoveryCoordinates: { cwd: "/repo", repo: "../selected repo" } };

test("dirty refusal names its native cause and the available capture call without tutorials", () => {
  const contract = contractId("kei/dirty-refusal");
  const output = renderVerb("deliver", { contract: "@dirty-refusal" }, { kind: "returned", value: {
    kind: "refused", contractId: contract, reason: { kind: "dirty-workspace", paths: ["file.txt"] },
  } }, recoveryContext);
  assert.match(output, /^deliver refused {2}kei\/dirty-refusal$/mu);
  assert.match(output, /^  reason {2}dirty workspace$/mu);
  assert.match(output, /^  path {2}file\.txt$/mu);
  assert.ok(output.split("\n").includes(
    "  available  keiyaku -C /repo --repo '../selected repo' deliver kei/dirty-refusal --include-dirty",
  ));
  assert.doesNotMatch(output, /capture index|staging|unmerged entries remain|captures complete/u);
  const review = renderVerb("review", { contract, verdict: "satisfied", summary: "review" },
    { kind: "returned", value: {
      kind: "refused", contractId: contract, reason: { kind: "dirty-submodules", paths: ["vendor"] },
    } }, { columns: 120, color: false });
  assert.match(review, /^  reason {2}dirty submodules$/mu);
  assert.match(review, /^  path {2}vendor$/mu);
  assert.doesNotMatch(review, /include-dirty|captures complete/u);
  const blocked = renderVerb("deliver", { contract }, { kind: "returned", value: {
    kind: "refused", contractId: contract,
    reason: { kind: "dirty-workspace", paths: ["file.txt"], submodules: ["vendor"] },
  } }, { columns: 120, color: false });
  assert.match(blocked, /^  capture {2}unavailable with submodule changes$/mu);
  assert.doesNotMatch(blocked, /captures complete|--include-dirty/u);
});

test("integration refusal keeps its reason distinct from the target coordinate", () => {
  const target = snapshotId("c".repeat(40));
  const contract = contractId("kei/integration-refusal");
  const text = renderVerb("deliver", { contract }, { kind: "returned", value: {
    kind: "refused", contractId: contract,
    reason: { kind: "integration-conflict", targetHead: target, conflictPaths: ["file.txt"] },
  } }, recoveryContext);
  assert.match(text, /^  reason {2}integration conflict$/mu);
  assert.match(text, new RegExp(`^  target head {2}${target}$`, "mu"));
  assert.match(text, /^  conflict {2}file\.txt$/mu);
  assert.deepEqual(text.split("\n").filter((line) => line.startsWith("  available  ")), [
    `  available  keiyaku -C /repo --repo '../selected repo' deliver ${contract} --materialize-conflict --include-dirty`,
  ]);
  const preview = renderVerb("deliver", { contract, dryRun: true }, { kind: "returned", value: {
    kind: "blocked", contractId: contract,
    reason: { kind: "integration-conflict", targetHead: target, conflictPaths: ["file.txt"] },
  } }, recoveryContext);
  assert.match(preview, /^  reason {2}integration conflict$/mu);
  assert.doesNotMatch(preview, /^  available  /mu);
});

test("bind draft facts preserve optional evidence without a separate text dialect", () => {
  const path = "/tmp/long draft directory/input.md";
  assert.equal(renderBindDraftReceipt({ path, warning: "disk full" }), `  draft  ${path}\n! draft warning  disk full`);
  assert.equal(renderBindDraftReceipt({ path }), `  draft  ${path}`);
  assert.equal(renderBindDraftReceipt({ warning: "disk full" }), "! draft warning  disk full");
  assert.doesNotMatch(renderBindDraftReceipt({ warning: "disk full" }), /draft preserved|:\s|next|please/u);
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

const verifiedSummary = (): ContractSummary =>
  contractSummary({
    gates: [{ name: gate("verified"), verdict: "satisfied" }],
  });

const verifiedGate = {
  gate: gate("verified"),
  satisfied: true,
  current: { kind: "attested" as const, verdict: "satisfied" as const, at: "2026-08-12T00:00:00.000Z" },
  requirements: [
    {
      requirement: requirementId("check-original"),
      index: 1,
      current: { kind: "attested" as const, verdict: "satisfied" as const, at: "2026-08-12T00:00:00.000Z" },
    },
  ],
};

const staleGate = {
  gate: gate("verified"),
  satisfied: false,
  current: { kind: "stale" as const, priorVerdict: "satisfied" as const },
  requirements: [
    {
      requirement: requirementId("check-original"),
      index: 1,
      current: { kind: "stale" as const, priorVerdict: "satisfied" as const },
    },
  ],
};

test("catalogue and selected terminal status retain their supplied gate facts", () => {
  const row = verifiedSummary();
  const catalog = contractCatalog([row]);
  const catalogText = renderContractCatalogue(catalog);
  assert.match(catalogText, /verification satisfied/u);
  assert.doesNotMatch(catalogText, /candidate|integration result/u);

  const report = kanshiReport({ kind: "present", rows: [row] });
  const selected = contractReport(contractDetail({ phase: "claimed", gates: [verifiedGate] }));
  assert.match(renderKanshiText(selected, { columns: 80, color: false }), /verification 1 · current · satisfied/u);

  const bareSelected = renderKanshiText(contractReport(contractDetail({ phase: "claimed" })), {
    columns: 80,
    color: false,
  });
  assert.doesNotMatch(bareSelected, /candidate|verification|integration result/u);
  const world = renderKanshiText(report, { columns: 80, color: false });
  assert.match(world, /verification satisfied/u);
  assert.doesNotMatch(world, /candidate|integration result/u);
});

test("selected delivered Kanshi keeps requirement evidence separate from the integration result", () => {
  const integration = snapshotId("4".repeat(40));
  const summary = contractSummary({
    delivered: true,
    gates: [{ name: gate("verified"), verdict: "satisfied" }],
  });
  const detail = contractDetail({
    phase: "bound",
    delivery: { candidate: snapshotId("3".repeat(40)), integration },
    gates: [verifiedGate],
  });
  const catalogText = renderContractCatalogue(contractCatalog([summary]));
  assert.doesNotMatch(catalogText, /integration result|predecessor/u);
  assert.match(catalogText, /delivery present · verification satisfied/u);
  const selected = renderKanshiText(contractReport(detail), { columns: 120, color: false });
  assert.equal((selected.match(/^  integration result  4444444$/gmu) ?? []).length, 1);
  assert.match(selected, /verification 1 · current · satisfied/u);
  assert.doesNotMatch(selected, /predecessor|verification satisfied · on 4444444/u);
  const world = renderKanshiText(kanshiReport({ kind: "present", rows: [summary] }), {
    columns: 120,
    color: false,
  });
  assert.match(world, /verification satisfied/u);
  assert.doesNotMatch(world, /integration result/u);
});

test("selected delivered Kanshi keeps stale delivery verification independent", () => {
  const integration = snapshotId("4".repeat(40));
  const summary = contractSummary({
    delivered: true,
    gates: [{ name: gate("verified"), verdict: "stale" }],
  });
  const detail = contractDetail({
    phase: "bound",
    delivery: { candidate: snapshotId("3".repeat(40)), integration },
    gates: [staleGate],
  });
  const catalogText = renderContractCatalogue(contractCatalog([summary]));
  assert.doesNotMatch(catalogText, /integration result/u);
  assert.match(catalogText, /delivery present · verification stale/u);
  const selected = renderKanshiText(contractReport(detail), { columns: 120, color: false });
  assert.match(selected, /(?:^|\n)  integration result  4444444$/mu);
  assert.match(selected, /(?:^|\n)  verification 1 · stale$/mu);
  assert.doesNotMatch(selected, /integration result  4444444 · verification satisfied/u);
  const world = renderKanshiText(kanshiReport({ kind: "present", rows: [summary] }), {
    columns: 120,
    color: false,
  });
  assert.doesNotMatch(world, /integration result|verification satisfied/u);
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
    gate: "verified", satisfied: false, current, requirements: [{ requirement, index: 2, current }],
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

test("audit separates its observation outcome from complete candidate coordinates", () => {
  const path = `src/${"long-directory/".repeat(8)}file.ts`;
  const auditOutcome = acceptedReceipt("deliver-preview", {
    contractId: contractId("kei/audit"),
    candidate: snapshotId("a".repeat(40)),
    integration: snapshotId("c".repeat(40)),
    contentId: changeId("d".repeat(40)),
    scope: { filesChanged: 1, insertions: 2, deletions: 3, paths: [path] },
  });
  const output = renderVerb("deliver", { contract: "kei/audit", dryRun: true },
    { kind: "returned", value: auditOutcome }, { columns: 80, color: false });
  assert.equal(
    output,
    [
      "deliver --dry-run accepted  kei/audit",
      `  candidate  ${auditOutcome.candidate}`,
      `  integration result  ${auditOutcome.integration}`,
      `  content identity  ${auditOutcome.contentId}`,
      "  scope  1 file changed, 2 insertions(+), 3 deletions(-)",
      `  path  ${path}`,
    ].join("\n"),
  );
  assert.doesNotMatch(output, /private-head|^[{[]|next|then|please|key=/mu);
});
