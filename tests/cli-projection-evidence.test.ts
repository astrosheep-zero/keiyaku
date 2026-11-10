import {
  acceptedReceipt,
  contractCatalog,
  contractDetail,
  contractReport,
  contractSummary,
  kanshiReport,
  runCli,
} from "./support/cli-fixtures.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import test from "node:test";
import { namedValueLines } from "../src/cli/render/value.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { renderContractCatalogue } from "../src/cli/render/catalog.js";
import { renderDeliveryPreview } from "../src/cli/render/delivery-preview.js";
import { renderContractHistory } from "../src/cli/render/contract-history.js";
import { renderSettingsText } from "../src/cli/render/settings.js";
import { renderBindDraftReceipt, renderRefusalFacts } from "../src/cli/render/refusal.js";
import { entityLines, displayColumns, plumbFacts } from "../src/cli/render/terminal.js";
import {
  changeId,
  contractId,
  entryUlid,
  gate,
  requirementId,
  snapshotId,
} from "../src/core/facts/types.js";
import type { ContractHistory } from "../src/library/contract-types.js";
import type { ContractSummary } from "../src/index.js";
import type { Settings } from "../src/settings.js";
import {
  activityAkumaRow,
  akumaWorldReport,
  completedTool,
  openAkumaSnapshot,
  reportedFileChange,
  snapshotRow,
} from "./support/kanshi-activity.js";

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

test("narrow entities retain deliberate layout and compact facts never split a path", () => {
  assert.deepEqual(
    entityLines({
      mark: "●",
      identity: "kei/long-complete-identity",
      state: "bound · 1h",
      title: "Example contract",
      facts: ["candidate  none"],
      context: { columns: 24, color: false },
    }),
    ["● bound · 1h", "  kei/long-complete-identity", "  Example contract", "  candidate  none"],
  );
  const path = `/repo/${"long-directory/".repeat(10)}`;
  assert.deepEqual(plumbFacts(["candidate  none", "target  main", `worktree  ${path}`], 80), [
    "  candidate  none · target  main",
    `  worktree  ${path}`,
  ]);
});

test("dirty refusal describes available capture without asserting a current unmerged index", () => {
  const refusal = { kind: "dirty-workspace" as const, paths: ["file.txt"] };
  const output = renderRefusalFacts({ ...refusal, option: { flag: "--include-dirty", available: true } }, "  ", 120);
  assert.deepEqual(output.slice(-3), [
    "  option  --include-dirty · captures complete non-ignored worktree bytes",
    "  capture index  private · real index unchanged, including any unmerged entries",
    "  staging  not required for --include-dirty",
  ]);
  assert.doesNotMatch(output.join("\n"), /index  unmerged entries remain/u);
  const review = renderRefusalFacts({ kind: "dirty-submodules", paths: ["vendor"] }, "  ", 120);
  assert.ok(review.includes("  reason  submodule changes cannot be captured for review"));
  assert.ok(review.includes("    vendor"));
  const blocked = renderRefusalFacts({ ...refusal, option: { flag: "--include-dirty", available: false } }, "  ", 120);
  assert.equal(blocked.at(-1), "  option  --include-dirty · unavailable with submodule changes");
  assert.doesNotMatch(blocked.join("\n"), /captures complete/u);
});

test("integration refusal keeps its reason distinct from the target coordinate", () => {
  const target = snapshotId("c".repeat(40));
  const lines = renderRefusalFacts(
    { kind: "integration-conflict", targetHead: target, conflictPaths: ["file.txt"] },
    "  ",
    120,
  );
  assert.deepEqual(lines, [
    "  reason  integration conflict",
    `  target  ${target}`,
    "  conflicts",
    "    file.txt",
    "  option  materialize  deliver --materialize-conflict --include-dirty",
    "  option  deliver  deliver --include-dirty",
  ]);
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
  const id = entryUlid("0".repeat(26));
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
        document: "exact historical terms",
      },
      {
        kind: "attestation",
        id: entryUlid("0".repeat(25) + "1"),
        at,
        gate: gate("verified"),
        requirement: requirementId("verification:sha256:original-check"),
        verdict: "satisfied",
        subject: "4".repeat(40),
      },
    ],
  };
  const ordinary = renderContractHistory(history);
  assert.match(ordinary, /bound to main @ start/u);
  assert.match(ordinary, /verification verification:sha256:original-check · subject 4{40}/u);
  assert.doesNotMatch(ordinary, /exact historical terms/u);
  const full = renderContractHistory(history, { full: true });
  assert.match(full, /exact historical terms/u);
  assert.match(full, /subject  4{40}/u);
  assert.equal(JSON.parse(JSON.stringify(history)).events[0].document, "exact historical terms");
});

const verifiedSummary = (): ContractSummary =>
  contractSummary({
    gates: [{ name: gate("verified"), verdict: "satisfied" }],
  });

const verifiedGate = {
  gate: gate("verified"),
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
  current: { kind: "stale" as const, priorVerdict: "satisfied" as const },
  requirements: [
    {
      requirement: requirementId("check-original"),
      index: 1,
      current: { kind: "stale" as const, priorVerdict: "satisfied" as const },
    },
  ],
};

test("catalogue retains acceptance progress while terminal Kanshi cards foreground the settled outcome", () => {
  const row = verifiedSummary();
  const catalog = contractCatalog([row]);
  const catalogText = renderContractCatalogue(catalog);
  assert.match(catalogText, /\[✓\] verification/u);
  assert.doesNotMatch(catalogText, /candidate|integration result/u);

  const report = kanshiReport({ kind: "present", rows: [row] });
  const selected = contractReport(contractDetail({ phase: "claimed", gates: [verifiedGate] }));
  assert.doesNotMatch(renderKanshiText(selected, { columns: 80, color: false }), /verification|candidate/u);

  const bareSelected = renderKanshiText(contractReport(contractDetail({ phase: "claimed" })), {
    columns: 80,
    color: false,
  });
  assert.doesNotMatch(bareSelected, /candidate|verification|integration result/u);
  const world = renderKanshiText(report, { columns: 80, color: false });
  assert.match(world, /\[✓\] verification/u);
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
  assert.match(catalogText, /\[✓\] verification/u);
  const selected = renderKanshiText(contractReport(detail), { columns: 120, color: false });
  assert.equal((selected.match(/^  integration result  4444444$/gmu) ?? []).length, 1);
  assert.match(selected, /✓ verification 1/u);
  assert.doesNotMatch(selected, /predecessor|verification satisfied · on 4444444/u);
  const world = renderKanshiText(kanshiReport({ kind: "present", rows: [summary] }), {
    columns: 120,
    color: false,
  });
  assert.doesNotMatch(world, /integration result|verification satisfied/u);
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
  assert.match(catalogText, /\[✓\] delivery  \[ \] verification/u);
  const selected = renderKanshiText(contractReport(detail), { columns: 120, color: false });
  assert.match(selected, /(?:^|\n)  integration result  4444444$/mu);
  assert.match(selected, /(?:^|\n)  ! verification 1 · stale$/mu);
  assert.doesNotMatch(selected, /integration result  4444444 · verification satisfied/u);
  const world = renderKanshiText(kanshiReport({ kind: "present", rows: [summary] }), {
    columns: 120,
    color: false,
  });
  assert.doesNotMatch(world, /integration result|verification satisfied/u);
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
  const output = renderDeliveryPreview(auditOutcome, { columns: 80, color: false });
  assert.equal(
    output,
    [
      "✓ deliver --dry-run  kei/audit",
      `  candidate  prepared  ${"a".repeat(7)}`,
      `  integration result  ${"c".repeat(7)}`,
      `  content identity  ${"d".repeat(7)}`,
      "  1 file changed, 2 insertions(+), 3 deletions(-)",
      `  ${path}`,
    ].join("\n"),
  );
  assert.doesNotMatch(output, /private-head|^[{[]|^✓ (?:candidate|verification|target)|next|then|please|key=/mu);
});

test("World roster keeps concrete activity evidence without duplicating snapshot sections", () => {
  const command = "keiyaku audit kei/reuse-snapshot-activity-rendering";
  const snapshot = openAkumaSnapshot(
    [snapshotRow(completedTool(5, "bash", { kind: "run", command }))],
    [reportedFileChange("src/cli/render/kanshi-akuma.ts")],
  );
  const report = akumaWorldReport([activityAkumaRow("aku/worker/ffff0001", "running", snapshot)]);
  const text = renderKanshiText(report, { columns: 120, color: false });
  assert.match(text, /run +\$ keiyaku audit kei\/reuse-snapshot-activity-rendering/u);
  assert.doesNotMatch(text, /activity "|\bdocument\b|please|next|then/u);
  assert.doesNotMatch(text, /──|debts \d|changes \d|came back|STILL RUNNING|killed/u);
  for (const line of renderKanshiText(report, { columns: 60, color: false }).split("\n"))
    assert.ok(displayColumns(line) <= 60, line);
});
