import assert from "node:assert/strict";
import test from "node:test";
import { changeId, contractHead, contractId, gate, snapshotId } from "../src/core/facts/types.js";
import type { InvocationResult, Lag } from "../src/cli/result.js";
import { renderCatalogText } from "../src/cli/render/catalog.js";
import {
  activityStream,
  akumaRawAnswer,
  callObservationStream,
  frameRule,
  snapshotActivityLines,
  snapshotText,
  waitObservationStream,
  waitText,
} from "../src/cli/render/akuma-activity.js";
import type { AkumaInvocationResult } from "../src/cli/commands/akuma-invoke.js";
import { parseAkumaStatus, type AkumaStatus, type OutcomeRow } from "../src/akuma/akuma.js";
import type { WaitObservedAkuma } from "../src/akuma/fleet-execution.js";
import type { DispatchAssociation } from "../src/index.js";
import { parseAkumaAlias, type AkumaAlias } from "../src/identity/selector.js";
import { renderAkuma } from "../src/cli/render/kanshi-akuma.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { displayColumns, takeDisplayColumns } from "../src/cli/render/terminal.js";
import { renderText } from "../src/cli/render/text.js";
import {
  activeTool,
  activityAkumaRow,
  akumaWorldReport,
  answeredOutcome,
  completedTool,
  idleAkumaSnapshot,
  openAkumaSnapshot,
  snapshotRow,
  AKUMA_ACTIVITY_AT,
  type ActivityToolCall,
} from "./support/kanshi-activity.js";
import type { Catalog } from "../src/library/catalog.js";
import type { ContractRow } from "../src/protocol/read/status.js";
import type { WorldRoot } from "../src/world.js";
import { renderHelp } from "../src/cli/parse.js";

const worldRoot = "/world" as WorldRoot;

/** The terminal clock a moment renders as, matching the renderer's local-time clock. */
function clockAt(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** One observed Akuma as the wait's observation seam reports it: status plus identity facts. */
function observed(
  status: AkumaStatus,
  facts: Readonly<{ alias?: AkumaAlias; contract: DispatchAssociation }> = { contract: { kind: "none" } },
): WaitObservedAkuma {
  return { status, ...facts };
}

test("CLI lag scope stays aligned with the public mutation result", () => {
  const scope: Lag["affects"] = "reconciliation";
  const placement: Lag["affects"] = "placement";
  const continuation: Lag["affects"] = "continuation";
  assert.equal(scope, "reconciliation");
  assert.equal(placement, "placement");
  assert.equal(continuation, "continuation");
});

test("Akuma call help omits the caller readonly flag", () => {
  assert.doesNotMatch(renderHelp({ kind: "akuma", action: "call" }), /--readonly/u);
});

test("catalog text renders only the selected identity layer", () => {
  assert.equal(
    renderCatalogText({
      kind: "tasks",
      root: "/world" as never,
      rows: [
        {
          id: "task/catalog-row" as never,
          title: "Catalog row",
          state: "open",
          priority: 2,
          disposition: "ready",
          updatedAt: "2026-08-12T00:00:00.000Z",
          bodyPresent: false,
        },
      ],
      hasMore: true,
    }),
    ["○ task/catalog-row · ready · P2 — Catalog row", "…"].join("\n"),
  );
  assert.equal(
    renderCatalogText({
      kind: "archetypes",
      rows: [{ name: "reviewer", model: "codex-5", description: "Read the complete change without truncation." }],
    }),
    ["available Akuma", "", "reviewer  codex-5", "  Read the complete change without truncation."].join("\n"),
  );
  assert.equal(
    renderCatalogText({
      kind: "akuma",
      root: worldRoot,
      archetype: "worker",
      observedAt: "2026-08-12T00:00:00.000Z",
      rows: [{ id: "aku/worker/deadbeef" as never, life: "unborn" }],
      searched: ["/world/.keiyaku/akuma/run"],
      hasMore: false,
    }),
    ["akuma  1 recent", "  scope  worker", "", "○ aku/worker/deadbeef · unborn"].join("\n"),
  );
});

test("root Task catalogue marks every disposition with its own state", () => {
  const cases = [
    ["ready", "○"],
    ["in_progress", "●"],
    ["blocked", "‖"],
    ["on_hold", "⧗"],
    ["done", "✓"],
    ["drop", "×"],
  ] as const;
  const catalog: Extract<Catalog, { kind: "tasks" }> = {
    kind: "tasks",
    root: worldRoot,
    hasMore: false,
    rows: cases.map(([disposition]) => ({
      id: `task/${disposition}` as never,
      title: disposition,
      priority: 1,
      state: disposition === "ready" || disposition === "blocked" ? "open" : disposition,
      disposition,
      updatedAt: "2026-08-12T00:00:00.000Z",
      bodyPresent: false,
    })),
  };
  assert.equal(
    renderCatalogText(catalog),
    cases.map(([state, mark]) => `${mark} task/${state} · ${state.replaceAll("_", " ")} · P1 — ${state}`).join("\n"),
  );
});

test("World roster names a bound Contract once without a bare unavailable parenthetical", () => {
  const snapshot = idleAkumaSnapshot([]);
  const bound = (observed: "active" | "terminal" | "missing" | "unavailable") => ({
    ...activityAkumaRow("aku/worker/11110001", "asleep", snapshot),
    contract: { id: contractId("kei/bound-contract"), observed },
  });
  const boundText = renderAkuma(akumaWorldReport([bound("terminal")]), { columns: 120, color: false }).join("\n");
  assert.match(boundText, /· kei\/bound-contract$/mu);
  assert.doesNotMatch(boundText, /bound to|unbound/u);
  assert.doesNotMatch(boundText, /->/u);
  const unresolved = renderAkuma(akumaWorldReport([bound("unavailable")]), { columns: 120, color: false }).join("\n");
  assert.match(unresolved, /· kei\/bound-contract$/mu);
  assert.doesNotMatch(unresolved, /bound to|unbound|unavailable/u);
  const missing = renderAkuma(akumaWorldReport([bound("missing")]), { columns: 120, color: false }).join("\n");
  assert.match(missing, /· kei\/bound-contract \(missing\)$/mu);
  assert.doesNotMatch(missing, /bound to|unbound/u);
  const free = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/22220002", "asleep", snapshot)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(free, /○ aku\/worker\/22220002 · asleep · 5s$/mu);
  assert.doesNotMatch(free, /bound to|unbound/u);
  assert.doesNotMatch(free, /·\s*$/mu);
});

test("World status task rows state a Contract association only when one exists", () => {
  const taskRow = {
    id: "task/standalone" as never,
    title: "Standalone task",
    state: "open" as const,
    priority: 1 as const,
    disposition: "ready" as const,
    updatedAt: "2026-01-01T09:00:00.000Z",
    bodyPresent: false,
  };
  const text = renderKanshiText(
    {
      ...akumaWorldReport([]),
      tasks: { kind: "present", value: { root: worldRoot, rows: [taskRow], hasMore: false } },
    },
    { columns: 120, color: false },
  );
  assert.match(text, /○ task\/standalone · ready · P1 · Standalone task$/mu);
  assert.doesNotMatch(text, /bound to|unbound/u);
  assert.doesNotMatch(text, /·\s*$/mu);
});

test("World roster states the activity age only when it differs from the state age", () => {
  const snapshot = idleAkumaSnapshot([]);
  const equal = activityAkumaRow("aku/worker/33330003", "asleep", snapshot);
  const equalText = renderAkuma(akumaWorldReport([equal]), { columns: 120, color: false }).join("\n");
  assert.match(equalText, /asleep · 5s/u);
  assert.doesNotMatch(equalText, /activity/u);
  const distinct = { ...equal, lastActivityAt: "2026-01-01T09:59:00.000Z" };
  const distinctText = renderAkuma(akumaWorldReport([distinct]), { columns: 120, color: false }).join("\n");
  assert.match(distinctText, /activity 1m/u);
});

test("pre-delivery review records testimony without claiming a retained candidate", () => {
  for (const verdict of ["satisfied", "unsatisfied"] as const) {
    const output = renderText({
      kind: "accepted",
      verb: "review",
      contract: contractId("kei/not-delivered"),
      head: contractHead("head"),
      facts: [],
      settlementLags: [],
      verdict,
    });
    assert.equal(output, `✓ review ${verdict}  kei/not-delivered`);
    assert.doesNotMatch(output, /candidate|not complete|placement/u);
  }
});

test("scoped Akuma catalog text preserves bounded membership and marks further rows", () => {
  const catalog: Extract<Catalog, { kind: "akuma" }> = {
    kind: "akuma",
    root: worldRoot,
    archetype: "worker",
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: Array.from({ length: 11 }, (_, index) => ({
      id: `aku/worker/${String(index).padStart(8, "0")}` as never,
      life: "unborn" as const,
    })),
    searched: [],
    hasMore: true,
  };
  const text = renderCatalogText(catalog);
  assert.match(text, /akuma  11 recent/u);
  assert.equal(text.endsWith("…"), true);
  assert.equal((text.match(/aku\/worker\//gu) ?? []).length, catalog.rows.length);
  assert.doesNotMatch(text, /aku\/\*\/\*/u);
  assert.doesNotMatch(text, /--all|next:|not shown|full|more available/u);
  assert.deepEqual(
    JSON.parse(JSON.stringify(catalog)).rows.map((row: { id: string }) => row.id),
    catalog.rows.map((row) => row.id),
  );
});

test("Akuma catalog renders future ages as now", () => {
  const futureRow = {
    id: "aku/worker/future" as never,
    archetype: "worker",
    life: "unborn" as const,
    lifeAt: "2026-08-12T00:00:01.000Z",
    lastActivityAt: null,
    pending: [],
  };
  const text = renderCatalogText({
    kind: "akuma",
    root: worldRoot,
    archetype: "worker",
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: [futureRow],
    searched: [],
    hasMore: false,
  });
  assert.match(text, /○ aku\/worker\/future · unborn · now/u);
  assert.doesNotMatch(text, /0s/u);
});

test("Contract catalog keeps domain IDs complete and makes every gate state legible", () => {
  const state = snapshotId("a".repeat(40));
  const row: ContractRow = {
    id: contractId("kei/selected-contract"),
    title: "Selected Contract",
    phase: "waiting",
    phaseAt: "2026-08-12T00:00:00.000Z",
    lastJournalAt: "2026-08-12T00:00:00.000Z",
    disposition: "active",
    workspace: "worktree",
    worktreePath: null,
    workspaceObservation: {
      kind: "clean",
      location: { kind: "worktree", path: "/tmp/wt" },
      counts: { staged: 0, unstaged: 0, untracked: 0, submodules: 0 },
      merge: null,
    },
    target: null,
    targetLag: { kind: "none" },
    delivery: null,
    targetObservation: null,
    gates: {
      satisfied: false,
      reports: [
        { gate: "reviewed", current: { kind: "attested", verdict: "satisfied", at: "2026-08-12T00:00:00.000Z" } },
        { gate: "verified", current: { kind: "attested", verdict: "unsatisfied", at: "2026-08-12T00:00:00.000Z" } },
        { gate: "security", current: { kind: "stale", priorVerdict: "satisfied" } },
        { gate: "manual", current: { kind: "missing" } },
      ],
    },
    after: [
      { contractId: contractId("kei/claimed-prerequisite"), endpoint: { kind: "claimed" } },
      { contractId: contractId("kei/active-prerequisite"), endpoint: { kind: "active", phase: "waiting" } },
      { contractId: contractId("kei/abandoned-prerequisite"), endpoint: { kind: "abandoned" } },
      { contractId: contractId("kei/missing-prerequisite"), endpoint: { kind: "missing" } },
    ],
    dependents: [{ contractId: contractId("kei/dependent-contract"), phase: "waiting" }],
  };
  const catalog: Catalog = {
    kind: "contracts",
    root: "/repo",
    state,
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: [row],
    hasMore: true,
  };
  const text = renderCatalogText(catalog);

  assert.doesNotMatch(text, /^\d+ active · \d+ candidates?$/mu);
  assert.match(text, /observed  2026-08-12T00:00:00.000Z/u);
  assert.match(text, /! kei\/selected-contract · waiting · 0s · Selected Contract/u);
  assert.match(text, /^  candidate  none\n  target  none$/mu);
  assert.doesNotMatch(text, /○ no candidate · ● candidate|satisfied  \[✗\] unsatisfied/u);
  assert.doesNotMatch(text, /worktree clean|tender |integration |merge /u);
  assert.doesNotMatch(text, new RegExp(state, "u"));
  assert.match(text, /✓ reviewed  × verified  ! security · stale  ○ manual/u);
  assert.match(text, /after  kei\/claimed-prerequisite · claimed/u);
  assert.match(text, /blocked by  kei\/active-prerequisite · waiting/u);
  assert.match(text, /blocked by  kei\/abandoned-prerequisite · abandoned/u);
  assert.match(text, /blocked by  kei\/missing-prerequisite · missing/u);
  assert.match(text, /dependents  kei\/dependent-contract \(waiting\)/u);
  assert.equal((text.match(/…/gu) ?? []).length, 1);
  assert.equal(text.endsWith("…"), true);
  assert.doesNotMatch(text, /not shown|full|next:|--all/u);

  const snap = snapshotId("b".repeat(40));
  const delivered = renderCatalogText({
    ...catalog,
    rows: [
      {
        ...row,
        phase: "tendered",
        verification: { kind: "unrecorded" },
        delivery: {
          tenderSnapshot: snap,
          integration: { predecessor: snap, snapshot: snap, changeId: changeId("chg-selected-contract") },
          method: "squash",
          policy: { requireBranchesToBeUpToDate: false },
        },
      },
    ],
  });
  assert.doesNotMatch(delivered, /^\d+ active · \d+ candidates?$/mu);
  assert.match(delivered, /^  candidate  present\n  target  none$/mu);
  assert.match(delivered, /^  verification unrecorded$/mu);
  assert.doesNotMatch(delivered, /○ no candidate · ● candidate|satisfied  \[✗\] unsatisfied/u);
  assert.doesNotMatch(delivered, /tender |integration /u);

  const expected = snapshotId("b".repeat(40));
  const observed = snapshotId("c".repeat(40));
  const moved = renderCatalogText({
    ...catalog,
    rows: [
      {
        ...row,
        target: "refs/heads/main",
        targetLag: { kind: "counted", behind: 0, subject: { kind: "worktree", path: "/repo/.keiyaku/wt/catalog" } },
        targetObservation: { head: observed, drift: true },
        phase: "tendered",
        delivery: {
          tenderSnapshot: expected,
          integration: { predecessor: expected, snapshot: expected, changeId: changeId("chg-target-moved") },
          method: "squash",
          policy: { requireBranchesToBeUpToDate: false },
        },
      },
    ],
  });
  assert.match(
    moved,
    /^  candidate  present\n  target  main @ ccccccc · behind 0\n  lag worktree  \/repo\/\.keiyaku\/wt\/catalog\n  target moved  bbbbbbb -> ccccccc$/mu,
  );

  const disappeared = renderCatalogText({
    ...catalog,
    rows: [
      {
        ...row,
        target: "refs/heads/main",
        targetLag: { kind: "unknown" },
        targetObservation: { head: null, drift: true },
        phase: "tendered",
        delivery: {
          tenderSnapshot: expected,
          integration: { predecessor: expected, snapshot: expected, changeId: changeId("chg-target-null") },
          method: "squash",
          policy: { requireBranchesToBeUpToDate: false },
        },
      },
    ],
  });
  assert.match(
    disappeared,
    /^  candidate  present\n  target  main · head absent · behind unknown\n  target moved  bbbbbbb -> absent$/mu,
  );
});

function catalogRow(verification?: ContractRow["verification"]): ContractRow {
  return {
    id: contractId("kei/verified-commit"),
    title: "Verified commit",
    phase: "claimed",
    phaseAt: "2026-08-12T00:00:00.000Z",
    lastJournalAt: "2026-08-12T00:00:00.000Z",
    disposition: "terminal",
    workspace: "worktree",
    worktreePath: null,
    workspaceObservation: { kind: "unappointed" },
    target: "refs/heads/main",
    targetLag: { kind: "none" },
    delivery: null,
    targetObservation: null,
    ...(verification === undefined ? {} : { verification }),
    gates: { satisfied: true, reports: [] },
    after: [],
    dependents: [],
  };
}

test("recorded verification names the commit the verdict covers", () => {
  const integration = snapshotId("4".repeat(40));
  const catalog: Catalog = {
    kind: "contracts",
    root: "/repo",
    state: null,
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: [
      catalogRow({ kind: "recorded", verdict: "satisfied", at: "2026-08-12T00:00:00.000Z", snapshot: integration }),
    ],
    hasMore: false,
  };
  assert.match(renderCatalogText(catalog), /^  verification satisfied · on 4444444$/mu);

  const bare = renderCatalogText({
    ...catalog,
    rows: [catalogRow({ kind: "recorded", verdict: "unsatisfied", at: "2026-08-12T00:00:00.000Z" })],
  });
  assert.match(bare, /^  verification unsatisfied$/mu);
  assert.doesNotMatch(bare, / · on /u);
});

test("every verb receipt states facts without journal rows or entry ids", () => {
  const contract = contractId("kei/receipt-vocabulary");
  const entry = "01K4AJ8F6K7JH8Y6Q5NEPRT41V";
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry, kind: "bound" as const }],
    settlementLags: [],
  };
  const receipts: readonly InvocationResult[] = [
    { ...envelope, verb: "bind", target: null, overlaps: [] },
    { ...envelope, verb: "amend", diff: "" },
    { ...envelope, verb: "arc", chapter: { seq: 2, title: "Second chapter" } },
    { ...envelope, verb: "abandon" },
    { ...envelope, verb: "deliver" },
    { ...envelope, verb: "review", verdict: "satisfied" },
  ];
  for (const receipt of receipts) {
    const text = renderText(receipt);
    assert.doesNotMatch(text, /journal/u, text);
    assert.doesNotMatch(text, new RegExp(entry, "u"), text);
  }
  assert.equal(
    renderText(receipts[2]!),
    ["✓ entered chapter 2  kei/receipt-vocabulary", "  chapter  2  ·  Second chapter"].join("\n"),
  );
});

test("observation text keeps the command and view data together", () => {
  const result: InvocationResult = { kind: "observation", command: "status", contracts: [] };
  assert.equal(renderText(result), "observation  status\n  contracts  list (0)");
});

test("world reconcile text keeps a completed report under report", () => {
  const result: InvocationResult = {
    kind: "observation",
    command: "reconcile",
    report: { kind: "completed", contracts: [] },
  };
  assert.equal(
    renderText(result),
    'observation  reconcile\n  report  object (2)\n    kind  "completed"\n    contracts  list (0)',
  );
});

test("world observation failure text is exact", () => {
  const result: InvocationResult = {
    kind: "observation",
    command: "reconcile",
    report: { kind: "world-observation-failed", diagnostic: "git failed" },
  };
  assert.equal(renderText(result), "× observation  reconcile\n  diagnostic  git failed");
});

test("Verification create action names are safe in text receipts", () => {
  const name = "prepare\nINJECT\u001b[31m";
  const result: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract: contractId("kei/hostile-create-name"),
    head: contractHead("head"),
    facts: [],
    settlementLags: [],
    verification: {
      failure: "environment-failure",
      name,
      detail: { kind: "exit", code: 17, stdout: "", stderr: "", truncated: false },
    },
  };

  const text = renderText(result, { columns: 200, color: false });
  assert.equal(text.includes('name "prepare\\nINJECT\\u001b[31m"'), true);
  assert.doesNotMatch(text, /\nINJECT/u);
  assert.doesNotMatch(text, /\u001b/u);
  const verification = result.verification;
  assert.equal(verification !== undefined && "name" in verification ? verification.name : undefined, name);
});

test("Verification cleanup action names are safe in text receipts", () => {
  const name = "destroy\rINJECT\u001b[2J";
  const result: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract: contractId("kei/hostile-cleanup-name"),
    head: contractHead("head"),
    facts: [],
    settlementLags: [],
    cleanup: [
      {
        kind: "verification-cleanup",
        contractId: contractId("kei/hostile-cleanup-name"),
        failure: { phase: "destroy", name, detail: { kind: "timeout" } },
      },
    ],
  };

  const text = renderText(result, { columns: 200, color: false });
  assert.equal(text.includes('name "destroy\\rINJECT\\u001b[2J"'), true);
  assert.doesNotMatch(text, /\rINJECT/u);
  assert.doesNotMatch(text, /\u001b/u);
  const cleanup = result.cleanup?.[0];
  assert.equal(cleanup?.kind === "verification-cleanup" ? cleanup.failure.name : undefined, name);
});

test("Verification text receipts distinguish configured action names", () => {
  const receipt = (name: string) =>
    renderText(
      {
        kind: "accepted",
        verb: "deliver",
        contract: contractId("kei/action-name-collision"),
        head: contractHead("head"),
        facts: [],
        settlementLags: [],
        verification: {
          failure: "environment-failure",
          name,
          detail: { kind: "timeout" },
        },
      },
      { columns: 200, color: false },
    );

  const newline = receipt("prepare\nx");
  const space = receipt("prepare x");
  assert.equal(newline.includes('name "prepare\\nx"'), true);
  assert.equal(space.includes('name "prepare x"'), true);
  assert.notEqual(newline, space);
});

test("amend text omits an absent Region observation", () => {
  const contract = contractId("kei/no-amend-region-observation");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "amend",
    contract,
    head: contractHead("head"),
    facts: [],
    settlementLags: [],
    diff: "",
  };
  assert.equal(renderText(result), ["✓ terms unchanged  kei/no-amend-region-observation"].join("\n"));
});

test("accepted results preserve reconciliation lag without telemetry", () => {
  const contract = contractId("kei/followed");
  const tender = snapshotId("tender");
  const head = snapshotId("head");
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("record"),
    facts: [],
    lag: [
      {
        kind: "worktree-follow-retained" as const,
        path: "/tmp/wt",
        tender,
        head,
        reason: "head-moved" as const,
        affects: "continuation",
      },
    ] as const,
    settlementLags: [],
  };
  assert.equal(
    renderText({ ...envelope, verb: "deliver" }),
    [
      "✓ deliver incomplete  kei/followed",
      "  candidate  kept",
      "! lag  worktree follow retained  ·  head moved  ·  /tmp/wt",
    ].join("\n"),
  );
  assert.deepEqual(envelope.lag[0], {
    kind: "worktree-follow-retained",
    path: "/tmp/wt",
    tender,
    head,
    reason: "head-moved",
    affects: "continuation",
  });
});

test("accepted bind receipts expose confirmed private-state seat close lag", () => {
  const contract = contractId("kei/bound");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "bind",
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "bind", kind: "bound" }],
    settlementLags: [],
    workspace: { kind: "worktree", path: "/tmp/wt" },
    target: null,
    overlaps: [],
    cleanup: [
      {
        kind: "private-state-seat-close",
        contractId: contract,
        failure: { kind: "private-state-seat-close-failed", diagnostic: "seat close failed after publication" },
      },
    ],
  };
  assert.equal(
    renderText(result),
    [
      "✓ bound  kei/bound",
      "  workspace  worktree  /tmp/wt",
      "  no target",
      "! lag  private-state-seat-close-failed",
      "diagnostic",
      "  seat close failed after publication",
      "",
    ].join("\n"),
  );
});

test("accepted bind receipts surface Region lint warnings", () => {
  const contract = contractId("kei/warned");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "bind",
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "bind", kind: "bound" }],
    settlementLags: [],
    target: null,
    overlaps: [],
    warnings: ["Region pattern 'src/a b' contains whitespace and will never match a path"],
  };
  assert.match(renderText(result), /! region warning[\s\S]*src\/a b[\s\S]*contains whitespace/u);
});

test("accepted receipts omit execution telemetry and retain recovery snapshots", () => {
  const contract = contractId("kei/unchanged-mechanics");
  const head = contractHead("journal-blob-oid");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract,
    head,
    facts: [{ contract, entry: "claim", kind: "claimed" }],
    lag: [{ kind: "unsealed-bytes", path: "/repo/.keiyaku/wt/contract", paths: [], affects: "none" }],
    settlementLags: [],
    recoverySnapshot: snapshotId("recovery"),
    leading: { kind: "already-admitted", fact: "01K4AJ8F6K7JH8Y6Q5NEPRT41V" as never },
    tenderSnapshot: snapshotId("tender-commit"),
    integration: { changeId: changeId("content-id") },
    completion: { integration: snapshotId("integration") },
  };

  const text = renderText(result);
  assert.match(text, /tender commit  tender-commit[\s\S]*content identity \(not commit\)  content-id/u);
  assert.match(text, /leading\s+already admitted/u);
  assert.doesNotMatch(text, /01K4AJ8F6K7JH8Y6Q5NEPRT41V/u);
  assert.doesNotMatch(text, /journal-blob-oid/u);
  assert.doesNotMatch(text, /ref updated|contract-file|worktree unchanged/u);
  assert.doesNotMatch(text, /ephemeral/u);
  assert.match(text, /recovery snapshot  recovery/u);
  assert.match(text, /unsealed bytes  \/repo\/\.keiyaku\/wt\/contract/u);
  assert.equal(JSON.parse(JSON.stringify(result)).recoverySnapshot, result.recoverySnapshot);
});

test("direct placement stops render the public unmet prerequisites in order", () => {
  const contract = contractId("kei/waiting-on-prerequisites");
  const unmet = [
    { contractId: contractId("kei/active-prerequisite"), state: "active" as const },
    { contractId: contractId("kei/abandoned-prerequisite"), state: "abandoned" as const },
    { contractId: contractId("kei/missing-prerequisite"), state: "missing" as const },
  ];
  const placement = {
    refusal: { kind: "prerequisites-unsatisfied" as const, contractId: contract, unmet },
  };
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [],
    settlementLags: [],
  };

  const deliver: InvocationResult = { ...envelope, verb: "deliver", placement };
  assert.equal(
    renderText(deliver),
    [
      "✓ deliver incomplete  kei/waiting-on-prerequisites",
      "! prerequisites unsatisfied",
      "  prerequisite  kei/active-prerequisite  ·  active",
      "  prerequisite  kei/abandoned-prerequisite  ·  abandoned",
      "  prerequisite  kei/missing-prerequisite  ·  missing",
      "  candidate  kept",
    ].join("\n"),
  );

  const review: InvocationResult = { ...envelope, verb: "review", verdict: "satisfied", placement };
  assert.equal(
    renderText(review),
    [
      "✓ review satisfied  kei/waiting-on-prerequisites",
      "! prerequisites unsatisfied",
      "  prerequisite  kei/active-prerequisite  ·  active",
      "  prerequisite  kei/abandoned-prerequisite  ·  abandoned",
      "  prerequisite  kei/missing-prerequisite  ·  missing",
    ].join("\n"),
  );
});

test("direct gate stops render the sole placement report without another read", () => {
  const contract = contractId("kei/waiting-on-gates");
  assert.equal(
    renderText({
      kind: "accepted",
      verb: "deliver",
      contract,
      head: contractHead("head"),
      facts: [],
      settlementLags: [],
      placement: {
        refusal: {
          kind: "gates-unsatisfied",
          contractId: contract,
          unmet: [
            {
              gate: gate("verified"),
              current: {
                kind: "attested",
                verdict: "unsatisfied",
                summary: "[1 bash exit 1]",
                at: "2026-08-01T00:00:00.000Z",
              },
            },
            { gate: gate("reviewed"), current: { kind: "stale", priorVerdict: "satisfied" } },
            { gate: gate("manual"), current: { kind: "missing" } },
          ],
        },
      },
    }),
    [
      "✓ deliver incomplete  kei/waiting-on-gates",
      "! gates unsatisfied",
      "  gate  verified  ·  unsatisfied  · at 2026-08-01T00:00:00.000Z",
      "  summary verified",
      "  [1 bash exit 1]",
      "",
      "  gate  reviewed  · stale  · prior satisfied",
      "  gate  manual  · missing",
      "  candidate  kept",
    ].join("\n"),
  );
});

test("completion stops project every checkout-followability refusal fact", () => {
  const contract = contractId("kei/checkout-followability");
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [],
    settlementLags: [],
  };
  const cases = [
    {
      reason: "staged" as const,
      paths: ["staged.ts", 'quote"path.ts'],
      text: [
        "! checkout-not-followable",
        "  checkout  /repo/checkout",
        "  target  refs/heads/main",
        "  reason  staged",
        "  paths",
        "    staged.ts",
        '    quote"path.ts',
      ],
    },
    {
      reason: "dirty-tracked" as const,
      paths: ["conflict.ts"],
      text: [
        "! checkout-not-followable",
        "  checkout  /repo/checkout",
        "  target  refs/heads/main",
        "  reason  dirty-tracked",
        "  paths",
        "    conflict.ts",
      ],
    },
    {
      reason: "untracked" as const,
      paths: [],
      text: [
        "! checkout-not-followable",
        "  checkout  /repo/checkout",
        "  target  refs/heads/main",
        "  reason  untracked",
        "  paths  none",
      ],
    },
  ];

  for (const { reason, paths, text } of cases) {
    const rendered = renderText({
      ...envelope,
      verb: "deliver",
      placement: {
        refusal: {
          kind: "checkout-not-followable",
          contractId: contract,
          target: "refs/heads/main",
          path: "/repo/checkout",
          reason,
          paths,
        },
      },
    } as InvocationResult);
    const renderedLines = rendered.split("\n");
    const start = renderedLines.indexOf("! checkout-not-followable");
    assert.notEqual(start, -1);
    assert.deepEqual(renderedLines.slice(start, start + text.length), text);
  }
});

test("continuation checkout stop keeps its exact block after the dependent context", () => {
  const contract = contractId("kei/prerequisite-checkout");
  const dependent = contractId("kei/stopped-checkout-dependent");
  assert.equal(
    renderText({
      kind: "accepted",
      verb: "deliver",
      contract,
      head: contractHead("head"),
      facts: [],
      settlementLags: [],
      completion: {
        integration: snapshotId("2".repeat(40)),
        predecessor: snapshotId("1".repeat(40)),
        target: "refs/heads/main",
      },
      continuation: {
        claimed: [],
        stopped: [
          {
            contractId: dependent,
            stop: {
              refusal: {
                kind: "checkout-not-followable",
                contractId: dependent,
                target: "refs/heads/main",
                path: "/repo/checkout",
                reason: "untracked",
                paths: ['quote"path.ts'],
              },
            },
          },
        ],
      },
    }),
    [
      "✓ delivered  kei/prerequisite-checkout",
      "  target  1111111..2222222  refs/heads/main",
      "● claimed",
      "! continuation  kei/stopped-checkout-dependent",
      "! checkout-not-followable",
      "  checkout  /repo/checkout",
      "  target  refs/heads/main",
      "  reason  untracked",
      "  paths",
      '    quote"path.ts',
    ].join("\n"),
  );
});

test("deliver projects a ran Verification completion", () => {
  const contract = contractId("kei/completion");
  const integration = snapshotId("4".repeat(40));
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "claim", kind: "claimed" as const }],
    settlementLags: [],
  };
  const text = renderText({
    ...envelope,
    verb: "deliver",
    completion: {
      integration,
      predecessor: snapshotId("3".repeat(40)),
      target: "refs/heads/main",
      verification: { mode: "ran", verdict: "satisfied" },
    },
  });
  assert.equal(
    text,
    [
      "✓ delivered  kei/completion",
      "  target  3333333..4444444  refs/heads/main",
      "  verification  satisfied  · on 4444444",
      "● claimed",
    ].join("\n"),
  );
  assertModeWordingAbsent(text);
});

test("deliver renders claimed and stopped continuations from the accepted result", () => {
  const contract = contractId("kei/prerequisite");
  const claimed = contractId("kei/claimed-dependent");
  const stopped = contractId("kei/stopped-dependent");
  assert.equal(
    renderText({
      kind: "accepted",
      verb: "deliver",
      contract,
      head: contractHead("head"),
      facts: [],
      settlementLags: [],
      completion: {
        integration: snapshotId("6".repeat(40)),
        predecessor: snapshotId("5".repeat(40)),
        target: "refs/heads/main",
      },
      continuation: {
        claimed: [claimed],
        stopped: [
          {
            contractId: stopped,
            stop: {
              refusal: {
                kind: "gates-unsatisfied",
                contractId: stopped,
                unmet: [{ gate: gate("reviewed"), current: { kind: "missing" } }],
              },
            },
          },
        ],
      },
    }),
    [
      "✓ delivered  kei/prerequisite",
      "  target  5555555..6666666  refs/heads/main",
      "● claimed",
      "✓ continuation  complete  kei/claimed-dependent",
      "! kei/stopped-dependent  ·  gates unsatisfied",
      "  gate  reviewed  · missing",
    ].join("\n"),
  );
});

test("deliver projects no Verification and an unsatisfied non-gating Verification", () => {
  const contract = contractId("kei/completion-states");
  const integration = snapshotId("8".repeat(40));
  const movement = { predecessor: snapshotId("7".repeat(40)), target: "refs/heads/main" };
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "claim", kind: "claimed" as const }],
    settlementLags: [],
  };
  assert.equal(
    renderText({
      ...envelope,
      verb: "deliver",
      completion: { integration, ...movement },
    }),
    ["✓ delivered  kei/completion-states", "  target  7777777..8888888  refs/heads/main", "● claimed"].join("\n"),
  );

  assert.equal(
    renderText({
      ...envelope,
      verb: "deliver",
      completion: { integration, ...movement, verification: { mode: "ran", verdict: "unsatisfied" } },
      verificationSummary: "[1 bash exit 1]",
    }),
    [
      "✓ delivered  kei/completion-states",
      "  target  7777777..8888888  refs/heads/main",
      "! verification  unsatisfied  (ran)  · not required by Contract gates",
      "  summary",
      "  [1 bash exit 1]",
      "",
      "● claimed",
    ].join("\n"),
  );
});

const reviewWorkspace = {
  staged: ["src/staged.ts"],
  unstaged: ["src/unstaged.ts"],
  untracked: ["untracked.txt"],
  unmergedPaths: [],
  shortStat: { filesChanged: 3, insertions: 4, deletions: 1 },
} as const;

function assertNoWorkspaceRows(text: string): void {
  assert.doesNotMatch(text, /^\s+(?:workspace|staged|unstaged|untracked|unmerged)\s/mu);
  assert.doesNotMatch(text, /files? changed/u);
}

function assertModeWordingAbsent(text: string): void {
  assert.doesNotMatch(text, /verified now|verification reused from delivery/u);
}

test("review projects a git-shaped movement row with a satisfied Verification fact row", () => {
  const contract = contractId("kei/review-completion");
  const predecessor = snapshotId("1".repeat(40));
  const integration = snapshotId("2".repeat(40));
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("journal-blob-oid"),
    facts: [
      { contract, entry: "reintegration", kind: "reintegrated" as const, data: { predecessor, snapshot: integration } },
      { contract, entry: "claim", kind: "claimed" as const },
    ],
    settlementLags: [],
  };
  const text = renderText({
    ...envelope,
    verb: "review",
    verdict: "satisfied",
    completion: {
      integration,
      predecessor,
      target: "refs/heads/main",
      verification: { mode: "reused", verdict: "satisfied" },
    },
    workspace: reviewWorkspace,
  });
  assert.equal(
    text,
    [
      "✓ review satisfied  kei/review-completion",
      "  target  1111111..2222222  refs/heads/main",
      "  verification  satisfied  · on 2222222",
      "● claimed",
    ].join("\n"),
  );
  assertModeWordingAbsent(text);
  assertNoWorkspaceRows(text);
  assert.doesNotMatch(text, /recorded|->|journal|integration commit|placement/u);
});

test("review names the verified sha and keeps the verdict title unadorned", () => {
  const contract = contractId("kei/review-fresh-verification");
  const predecessor = snapshotId("3".repeat(40));
  const integration = snapshotId("4".repeat(40));
  const text = renderText({
    kind: "accepted",
    verb: "review",
    contract,
    head: contractHead("head"),
    facts: [
      { contract, entry: "reintegration", kind: "reintegrated", data: { predecessor, snapshot: integration } },
      { contract, entry: "claim", kind: "claimed" },
    ],
    settlementLags: [],
    verdict: "satisfied",
    completion: {
      integration,
      predecessor,
      target: "refs/heads/main",
      verification: { mode: "ran", verdict: "satisfied" },
    },
  });
  assert.equal(
    text,
    [
      "✓ review satisfied  kei/review-fresh-verification",
      "  target  3333333..4444444  refs/heads/main",
      "  verification  satisfied  · on 4444444",
      "● claimed",
    ].join("\n"),
  );
  assertModeWordingAbsent(text);
});

test("review projects a reused unsatisfied Verification as non-gating completion", () => {
  const contract = contractId("kei/review-completion-unsatisfied");
  const predecessor = snapshotId("7".repeat(40));
  const integration = snapshotId("8".repeat(40));
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "claim", kind: "claimed" as const }],
    settlementLags: [],
  };
  assert.equal(
    renderText({
      ...envelope,
      verb: "review",
      verdict: "satisfied",
      completion: {
        integration,
        predecessor,
        target: "refs/heads/main",
        verification: { mode: "reused", verdict: "unsatisfied" },
      },
      verificationSummary: "[reused bash exit 1]",
      workspace: reviewWorkspace,
    }),
    [
      "✓ review satisfied  kei/review-completion-unsatisfied",
      "  target  7777777..8888888  refs/heads/main",
      "! verification  unsatisfied  (reused)  · not required by Contract gates",
      "  summary",
      "  [reused bash exit 1]",
      "",
      "● claimed",
    ].join("\n"),
  );
});

test("an unsatisfied review verdict and a claimed continuation stay outcome-only", () => {
  const contract = contractId("kei/review-outcome-only");
  const claimed = contractId("kei/claimed-by-review");
  const text = renderText({
    kind: "accepted",
    verb: "review",
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "testimony", kind: "attestation" }],
    settlementLags: [],
    verdict: "unsatisfied",
    continuation: { claimed: [claimed], stopped: [] },
    workspace: reviewWorkspace,
  });
  assert.equal(
    text,
    ["✓ review unsatisfied  kei/review-outcome-only", "✓ continuation  complete  kei/claimed-by-review"].join("\n"),
  );
  assertNoWorkspaceRows(text);
});

test("movement projects its deviation and reintegration coordinates", () => {
  const contract = contractId("kei/reintegrated");
  const predecessor = snapshotId("target-1");
  const integrated = snapshotId("integration-2");
  const secondPredecessor = snapshotId("target-3");
  const secondIntegrated = snapshotId("integration-4");
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    settlementLags: [],
  };
  const facts: readonly import("../src/cli/result.js").AcceptedFact[] = [
    {
      contract,
      entry: "reintegration",
      kind: "reintegrated" as const,
      data: { predecessor, snapshot: integrated },
    },
    {
      contract,
      entry: "reintegration-2",
      kind: "reintegrated" as const,
      data: { predecessor: secondPredecessor, snapshot: secondIntegrated },
    },
    { contract, entry: "claim", kind: "claimed" as const },
  ];

  assert.equal(
    renderText({
      ...envelope,
      verb: "deliver",
      facts,
      completion: { integration: secondIntegrated, predecessor: secondPredecessor, target: "refs/heads/main" },
    }),
    ["✓ delivered  kei/reintegrated", "  target  target-3..integration-4  refs/heads/main", "● claimed"].join("\n"),
  );

  assert.equal(
    renderText({
      ...envelope,
      verb: "deliver",
      facts: facts.slice(0, 2),
      placement: {
        failure: "target-moved",
        contractId: contract,
        target: "refs/heads/main",
        integratedAt: integrated,
        observed: null,
        attempts: 3,
        observedTreeEqualsCandidate: false,
      },
    }),
    [
      "✓ deliver incomplete  kei/reintegrated",
      "! target  moved · re-integrated x2",
      "! target moved  refs/heads/main  integration-2 -> null  attempts 3",
      "  candidate  kept",
    ].join("\n"),
  );
});

test("unmerged index paths render as a complete public refusal", () => {
  const contract = contractId("kei/conflicted");
  assert.equal(
    renderText({
      kind: "refused",
      verb: "deliver",
      contract,
      refusal: { kind: "unmerged-paths", contractId: contract, paths: ["a.txt", "z.txt"] },
    }),
    ["× deliver refused  kei/conflicted", "  unmerged-paths", "  paths", "    a.txt", "    z.txt"].join("\n"),
  );
});

test("materialized conflict text keeps the exact recovery projection", () => {
  const result: InvocationResult = {
    kind: "integration-conflict-materialized",
    targetHead: snapshotId("b".repeat(40)),
    conflictPaths: ["a.txt", "b.txt"],
    workspace: { kind: "worktree", path: "/repo/.keiyaku/wt/x" },
    handoffBase: snapshotId("a".repeat(40)),
    recovery: {
      deliver: "deliver --include-dirty",
      staging: "not-required",
      materialize: "deliver --materialize-conflict --include-dirty",
    },
  };
  assert.equal(
    renderText(result),
    [
      "! integration-conflict-materialized",
      "  target  bbbbbbb",
      "  delivery  none",
      "  index  unmerged",
      "  saved  worktree bytes before projection",
      "  handoff base  aaaaaaa",
      "  conflicts",
      "    a.txt",
      "    b.txt",
      "  workspace  /repo/.keiyaku/wt/x",
      "  deliver  deliver --include-dirty · reads worktree bytes, not index",
    ].join("\n"),
  );
  assert.equal(JSON.parse(JSON.stringify(result)).handoffBase, result.handoffBase);
  assert.doesNotMatch(renderText(result), /staging|not-required|UU|please|next|then/u);
});

test("World roster reuses snapshot activity rendering for concrete tool work", () => {
  const calls: readonly Readonly<{ name: string; call: ActivityToolCall; evidence: string }>[] = [
    { name: "read", call: { kind: "read", path: "src/a.ts", offset: 10, limit: 5 }, evidence: "src/a.ts · L10-14" },
    {
      name: "grep",
      call: { kind: "search", query: "snapshot", scope: "content", path: "src" },
      evidence: "search snapshot · src",
    },
    {
      name: "edit",
      call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts", diffstat: { added: 2, removed: 1 } }] },
      evidence: "src/a.ts — +2 -1",
    },
    {
      name: "bash",
      call: { kind: "run", command: "npm test -- tests/cli-render.test.ts" },
      evidence: "$ npm test -- tests/cli-render.test.ts",
    },
  ];
  const snapshot = openAkumaSnapshot(
    calls.map((member, index) => snapshotRow(completedTool(index + 1, member.name, member.call))),
  );
  const targeted = snapshotActivityLines(snapshot, { columns: 118, color: false });
  for (const member of calls)
    assert.ok(
      targeted.some((line) => line.includes(member.evidence)),
      member.evidence,
    );
  const roster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/aaaa0001", "running", snapshot)]), {
    columns: 120,
    color: false,
  });
  const bounded = snapshotActivityLines(snapshot, { columns: 118, color: false }, { latest: true });
  assert.deepEqual(
    roster.slice(-bounded.length),
    bounded.map((line) => `  ${line}`),
  );
  assert.match(roster.at(-1)!, /✓ run    \$ npm test -- tests\/cli-render\.test\.ts/u);
  assert.doesNotMatch(roster.join("\n"), /src\/a\.ts|activity "/u);
});

test("World roster selects an idle outcome newer than a retained tool entry", () => {
  const snapshot = idleAkumaSnapshot(
    [snapshotRow(completedTool(5, "bash", { kind: "run", command: "stale-command" }))],
    answeredOutcome(9, "fresh answer with detail"),
  );
  const roster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/bbbb0002", "asleep", snapshot)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(roster, /✓ say    “fresh answer with detail”/u);
  assert.doesNotMatch(roster, /stale-command/u);
});

test("World roster keeps the honest fallback for unknown tool calls", () => {
  const snapshot = openAkumaSnapshot([
    snapshotRow(completedTool(1, "mystery", { kind: "other", display: "Mystery Tool" })),
    snapshotRow(completedTool(2, "custom-tool", { kind: "other", display: "" })),
  ]);
  const roster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/cccc0003", "running", snapshot)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(roster, /✓ use    custom-tool/u);
});

test("World roster never substitutes a trailing gap for the latest semantic entry", () => {
  const snapshot = openAkumaSnapshot([
    snapshotRow(completedTool(5, "bash", { kind: "run", command: "kept-command" })),
    { kind: "gap", count: 4 },
  ]);
  const roster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/dddd0004", "running", snapshot)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(roster, /kept-command/u);
  assert.doesNotMatch(roster, /omitted/u);
});

test("World roster activity stays width-aware without embedding complete snapshot sections", () => {
  const snapshot = openAkumaSnapshot([
    snapshotRow(completedTool(5, "bash", { kind: "run", command: `npm test -- ${"focused/".repeat(20)}case.ts` })),
  ]);
  const report = akumaWorldReport([activityAkumaRow("aku/worker/eeee0005", "running", snapshot)]);
  for (const columns of [60, 80, 120]) {
    const lines = renderAkuma(report, { columns, color: false });
    for (const line of lines) assert.ok(displayColumns(line) <= columns, `${columns}: ${line}`);
  }
  const wide = renderAkuma(report, { columns: 120, color: false }).join("\n");
  assert.doesNotMatch(wide, /──|tasks \d|changes \d|came back|STILL RUNNING|killed/u);
});

test("World roster keeps active, error and truncated activity marks truthful", () => {
  const active = openAkumaSnapshot([
    snapshotRow(activeTool(1, "bash", { kind: "run", command: "keiyaku wait --all" })),
  ]);
  const activeRoster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/aabb0006", "running", active)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(activeRoster, /⧖ run    \$ keiyaku wait --all/u);
  assert.doesNotMatch(activeRoster, /— ok/u);

  const failed = openAkumaSnapshot([
    snapshotRow(completedTool(2, "bash", { kind: "run", command: "npm test" }, { status: "error", exitCode: 1 })),
  ]);
  const failedRoster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/ccdd0007", "running", failed)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(failedRoster, /! run    \$ npm test — exit 1/u);

  const truncated = openAkumaSnapshot([
    snapshotRow({ kind: "said", sequence: 3, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "x".repeat(400) }),
  ]);
  const truncatedActivity = snapshotActivityLines(truncated, { columns: 120, color: false });
  assert.equal(truncatedActivity.length, 2, "a said row renders within its bounded line budget");
  const truncatedRoster = renderAkuma(
    akumaWorldReport([activityAkumaRow("aku/worker/eeff0008", "running", truncated)]),
    { columns: 120, color: false },
  ).join("\n");
  assert.match(truncatedRoster, /…”/u);
  assert.ok(!truncatedRoster.includes("x".repeat(200)), "truncation bounds retained said text");
});

test("World roster previews strip markdown decoration without rewording", () => {
  const snapshot = openAkumaSnapshot([
    snapshotRow({
      kind: "said",
      sequence: 1,
      turnSequence: 1,
      at: AKUMA_ACTIVITY_AT,
      text: "**Source —** `src/a.ts`\n## Heading\n- *italic* and src/**/*.ts",
    }),
  ]);
  const roster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/44440004", "running", snapshot)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.doesNotMatch(roster, /`|##|^- |\*\*Source/mu);
  assert.match(roster, /Source — src\/a\.ts Heading italic and src\/\*\*\/\*\.ts/u);
});

test("a sleeping worker reports its return as an event", () => {
  const sleeping = parseAkumaStatus({
    id: "aku/worker/abcd0001",
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")),
  });
  const snapshot = snapshotText({ status: sleeping, contract: { kind: "none" } }, { columns: 80, color: false });
  assert.match(snapshot, /^✓ came back$/mu);

  const returned = waitText(
    {
      kind: "akuma",
      action: "wait",
      result: {
        completion: "all",
        observations: [{ status: sleeping, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } }],
        unobserved: [],
      },
    },
    { columns: 80, color: false },
  );
  assert.match(returned, /^✓ came back aku\/worker\/abcd0001$/mu);
});

test("an observation frame places the rule between the frame and its content", () => {
  const sleeping = parseAkumaStatus({
    id: "aku/worker/abcd0001",
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")),
  });
  const snapshot = snapshotText({ status: sleeping, contract: { kind: "none" } }, { columns: 80, color: false });
  assert.deepEqual(snapshot.split("\n").slice(0, 2), ["aku/worker/abcd0001", frameRule(["aku/worker/abcd0001"])]);

  const returned = waitText(
    {
      kind: "akuma",
      action: "wait",
      result: {
        completion: "all",
        observations: [{ status: sleeping, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } }],
        unobserved: [],
      },
    },
    { columns: 80, color: false },
  );
  assert.deepEqual(returned.split("\n").slice(0, 3), [
    "✓ came back aku/worker/abcd0001",
    frameRule(["✓ came back aku/worker/abcd0001"]),
    "the answer",
  ]);
});

test("the live stream keeps the newest tools and never drops a narrative row", () => {
  const lines = activityStream({ columns: 120, color: false })(
    idleAkumaSnapshot([
      snapshotRow(completedTool(1, "bash", { kind: "run", command: "first" })),
      snapshotRow(completedTool(2, "bash", { kind: "run", command: "second" })),
      snapshotRow(completedTool(3, "bash", { kind: "run", command: "third" })),
      snapshotRow(completedTool(4, "bash", { kind: "run", command: "fourth" })),
      snapshotRow({ kind: "said", sequence: 5, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "kept prose" }),
      snapshotRow(completedTool(6, "bash", { kind: "run", command: "fifth" })),
      snapshotRow(completedTool(7, "bash", { kind: "run", command: "sixth" })),
    ]),
  );
  const text = lines.join("\n");
  assert.doesNotMatch(text, /first|second|third/u, "older tool rows fold instead of streaming");
  assert.match(text, /⋮ 3 omitted/u);
  assert.ok(text.indexOf("⋮ 3 omitted") < text.indexOf("fourth"), "the marker sits where the omitted run began");
  assert.ok(text.indexOf("fourth") < text.indexOf("kept prose"), "the narrative keeps its order");
  assert.ok(text.indexOf("kept prose") < text.indexOf("fifth"));
  assert.ok(text.indexOf("fifth") < text.indexOf("sixth"));
});

test("the live stream marks each older contiguous tool run at its own position", () => {
  const tool = (sequence: number, command: string) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command }));
  const lines = activityStream({ columns: 120, color: false })(
    idleAkumaSnapshot([
      tool(1, "a1"),
      tool(2, "a2"),
      snapshotRow({ kind: "note", sequence: 3, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "between" }),
      tool(4, "b1"),
      tool(5, "b2"),
      tool(6, "c1"),
      tool(7, "c2"),
      tool(8, "c3"),
    ]),
  );
  const text = lines.join("\n");
  // The final three tools stay; the two older runs fold around the narrative, each at its own position.
  assert.deepEqual(lines.filter((line) => line.includes("⋮")), [
    `${" ".repeat(5)} ⋮ 2 omitted`,
    `${" ".repeat(5)} ⋮ 2 omitted`,
  ]);
  assert.doesNotMatch(text, /a1|a2|b1|b2/u);
  assert.ok(text.indexOf("⋮ 2 omitted") < text.indexOf("between"));
  assert.ok(text.indexOf("between") < text.lastIndexOf("⋮ 2 omitted"));
  assert.ok(text.lastIndexOf("⋮ 2 omitted") < text.indexOf("c1"));
  assert.ok(text.indexOf("c1") < text.indexOf("c2") && text.indexOf("c2") < text.indexOf("c3"));
});

test("the live stream keeps up to three settled tools fully visible", () => {
  const tool = (sequence: number) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command: `c${sequence}` }));
  for (const count of [0, 1, 2, 3]) {
    const lines = activityStream({ columns: 120, color: false })(
      idleAkumaSnapshot(Array.from({ length: count }, (_, index) => tool(index + 1))),
    );
    assert.doesNotMatch(lines.join("\n"), /omitted/u, `${count} tools fit the budget`);
    for (let sequence = 1; sequence <= count; sequence += 1) {
      assert.match(lines.join("\n"), new RegExp(`c${sequence}`, "u"));
    }
  }
});

test("the live stream appends each settled chunk once and never regrows a marker", () => {
  const stream = activityStream({ columns: 120, color: false });
  const tool = (sequence: number) => snapshotRow(completedTool(sequence, "bash", { kind: "run", command: `c${sequence}` }));
  const first = stream(idleAkumaSnapshot([tool(1), tool(2), tool(3), tool(4)]));
  const firstText = first.join("\n");
  assert.match(firstText, /⋮ 1 omitted/u, "only the oldest row of the batch folds");
  assert.doesNotMatch(firstText, /c1/u);
  assert.equal(first.filter((line) => line.includes("c2")).length, 1);
  assert.equal(first.filter((line) => line.includes("c4")).length, 1);

  // A later batch selects its own final three, so the per-batch budget never becomes a global cap.
  const second = stream(idleAkumaSnapshot([tool(1), tool(2), tool(3), tool(4), tool(5), tool(6), tool(7)]));
  const secondText = second.join("\n");
  assert.doesNotMatch(secondText, /c1|c2|c3|c4|omitted/u, "a later batch replays nothing and regrows no marker");
  assert.match(secondText, /c5/u);
  assert.match(secondText, /c6/u);
  assert.match(secondText, /c7/u);
});

test("the live stream settles rows without rendering the outcome row", () => {
  const lines = activityStream({ columns: 120, color: false })(
    idleAkumaSnapshot(
      [snapshotRow(completedTool(1, "bash", { kind: "run", command: "kept" }))],
      answeredOutcome(2, "the full answer"),
    ),
  );
  assert.match(lines.join("\n"), /kept/u);
  assert.doesNotMatch(lines.join("\n"), /the full answer|came back/u);
});

test("a wait stream opens an already settled Akuma with its head frame and no backlog", () => {
  const settled = parseAkumaStatus({
    id: "aku/worker/abcd0001",
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")),
  });
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  assert.deepEqual(stream.observe([observed(settled)]), ["aku/worker/abcd0001", frameRule(["aku/worker/abcd0001"])]);
  assert.deepEqual(stream.observe([observed(settled)]), []);
});

test("a wait stream prints only rows that settle after its baseline and opens a new head per Akuma", () => {
  const running = (id: string, entries: Parameters<typeof openAkumaSnapshot>[0]) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot(entries) });
  const first = "aku/worker/abcd0002";
  const second = "aku/worker/abcd0003";
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  assert.deepEqual(
    stream.observe([
      observed(running(first, [snapshotRow(completedTool(1, "bash", { kind: "run", command: "first" }))])),
    ]),
    [first, frameRule([first])],
  );
  const streamed = stream
    .observe([
      observed(
        running(first, [
          snapshotRow(completedTool(1, "bash", { kind: "run", command: "first" })),
          snapshotRow(completedTool(2, "bash", { kind: "run", command: "second" })),
        ]),
      ),
      observed(running(second, [snapshotRow(completedTool(1, "bash", { kind: "run", command: "elsewhere" }))])),
    ])
    .join("\n");
  assert.match(streamed, /first/u);
  assert.doesNotMatch(streamed, /second|elsewhere/u);
  assert.ok(streamed.includes(`\n\n${second}\n${frameRule([second])}`), "a later head frame opens a new paragraph");
});

test("a single answered wait concludes at its durable settle moment, not the poll that noticed it", () => {
  const settledAtMs = Date.parse(AKUMA_ACTIVITY_AT);
  let now = settledAtMs - 41_000;
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => now });
  const runningStatus = parseAkumaStatus({
    id: "aku/worker/abcd0004",
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([snapshotRow(completedTool(1, "bash", { kind: "run", command: "work" }))]),
  });
  const answeredStatus = parseAkumaStatus({
    id: "aku/worker/abcd0004",
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")),
  });
  stream.observe([observed(runningStatus)]);
  now = settledAtMs + 5_000;
  stream.observe([observed(answeredStatus)]);
  const conclusion = {
    observations: [{ status: answeredStatus, contract: { kind: "none" as const }, createdTasks: { kind: "present" as const, rows: [] } }],
    unobserved: [],
  };
  assert.equal(stream.conclude(conclusion), `${clockAt(settledAtMs)} ✓ answered — 41s\n\n`);
  assert.equal(stream.streamed(), true);
});

test("two Akuma first sighted in one round each open their own paragraph", () => {
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  const first = "aku/worker/abcd0010";
  const second = "aku/worker/abcd0011";
  const running = (id: string) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot([]) });
  assert.deepEqual(stream.observe([observed(running(first)), observed(running(second))]), [
    first,
    frameRule([first]),
    "",
    second,
    frameRule([second]),
  ]);
});

test("a wait stream head renders the alias and Contract association its observation carries", () => {
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  const status = parseAkumaStatus({
    id: "aku/worker/abcd0012",
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([]),
  });
  const head = ["aku/worker/abcd0012 (@scout-a)", "└─ kei/demo"];
  assert.deepEqual(
    stream.observe([
      observed(status, {
        alias: parseAkumaAlias("@scout-a"),
        contract: { kind: "associated", contractId: contractId("kei/demo") },
      }),
    ]),
    [...head, frameRule(head)],
  );
});

test("an unfinished wait concludes with the running mark and waited duration, never a replay", () => {
  let now = 1_000;
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => now });
  const runningStatus = parseAkumaStatus({
    id: "aku/worker/abcd0005",
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([snapshotRow({ kind: "said", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "still working" })]),
  });
  stream.observe([observed(runningStatus)]);
  now = 46_000;
  const conclusion = {
    observations: [
      { status: runningStatus, contract: { kind: "none" as const }, createdTasks: { kind: "present" as const, rows: [] } },
    ],
    unobserved: [],
  };
  assert.equal(stream.conclude(conclusion), `${clockAt(46_000)} ● still running — waited 45s`);
});

test("a streamed multi-target wait scoreboards without a count while a non-streamed wait keeps its own", () => {
  const settledAtMs = Date.parse(AKUMA_ACTIVITY_AT);
  let now = settledAtMs - 192_000;
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => now });
  const first = "aku/worker/abcd0006";
  const second = "aku/worker/abcd0007";
  const running = (id: string) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot([]) });
  const answered = (id: string) =>
    parseAkumaStatus({
      id,
      life: "asleep",
      allowed: [],
      timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")),
    });
  stream.observe([
    observed(running(first), { alias: parseAkumaAlias("@scout-a"), contract: { kind: "none" } }),
    observed(running(second)),
  ]);
  now = settledAtMs + 3_000;
  stream.observe([observed(answered(first)), observed(running(second))]);
  const conclusion = {
    observations: [
      { status: answered(first), contract: { kind: "none" as const }, createdTasks: { kind: "present" as const, rows: [] } },
      { status: running(second), contract: { kind: "none" as const }, createdTasks: { kind: "present" as const, rows: [] } },
    ],
    unobserved: [],
  };
  now = settledAtMs + 8_000;
  const scoreboard = stream.conclude(conclusion);
  assert.equal(
    scoreboard,
    `\n${clockAt(settledAtMs)} @scout-a            ✓ answered — 3m12s\n${clockAt(settledAtMs + 8_000)} ${second} ● still running — waited 3m20s`,
  );
  assert.doesNotMatch(scoreboard, /of \d+ done/u);

  const multiText = waitText(
    {
      kind: "akuma",
      action: "wait",
      result: {
        completion: "all",
        observations: [
          { status: answered(first), contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } },
          { status: answered(second), contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } },
        ],
        unobserved: [],
      },
    },
    { columns: 120, color: false },
  );
  assert.match(multiText, /\n\n2 of 2 done$/u);
});

test("a single non-streamed text wait keeps its snapshot without a completion count", () => {
  const running = parseAkumaStatus({ id: "aku/worker/abcd0013", life: "running", allowed: [], timeline: openAkumaSnapshot([]) });
  const text = waitText(
    {
      kind: "akuma",
      action: "wait",
      result: {
        completion: "all",
        observations: [{ status: running, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } }],
        unobserved: [],
      },
    },
    { columns: 120, color: false },
  );
  assert.doesNotMatch(text, /done/u);
});

test("a streamed wait keeps stdout byte-pure while a forwarded wait keeps its frame", () => {
  const observation = (status: ReturnType<typeof parseAkumaStatus>) => ({
    status,
    contract: { kind: "none" as const },
    createdTasks: { kind: "present" as const, rows: [] },
  });
  const answered = (id: string) =>
    parseAkumaStatus({ id, life: "asleep", allowed: [], timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")) });
  const running = (id: string) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot([]) });
  const wait = (statuses: readonly ReturnType<typeof parseAkumaStatus>[], streamed = false): AkumaInvocationResult => ({
    kind: "akuma",
    action: "wait",
    result: { completion: "all", observations: statuses.map(observation), unobserved: [] },
    ...(streamed ? { streamed: true } : {}),
  });

  assert.equal(akumaRawAnswer(wait([answered("aku/worker/aaa00001")], true)), "the answer");
  assert.equal(akumaRawAnswer(wait([running("aku/worker/aaa00002")], true)), "");
  assert.equal(
    akumaRawAnswer(wait([answered("aku/worker/aaa00003"), answered("aku/worker/aaa00004")], true)),
    "",
  );
  assert.equal(akumaRawAnswer(wait([running("aku/worker/aaa00005")])), undefined);
});

test("a plural wait attributes every row to its own aligned source", () => {
  const first = "aku/worker/abcd0020";
  const second = "aku/worker/abcd0021";
  const running = (id: string, entries: Parameters<typeof openAkumaSnapshot>[0]) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot(entries) });
  const tool = (sequence: number, command: string) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command }));
  const facts = { alias: parseAkumaAlias("@a"), contract: { kind: "none" as const } };
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  stream.select([{ id: first, alias: "@a" }, { id: second }]);

  // The baseline round opens each head frame and settles no row of its own.
  const opening = stream.observe([
    observed(running(first, [tool(1, "one")]), facts),
    observed(running(second, [tool(1, "two")])),
  ]);
  const head = `${first} (@a)`;
  assert.deepEqual(opening.slice(0, 2), [head, frameRule([head])]);
  assert.doesNotMatch(opening.join("\n"), /✓ run/u);

  const text2 = stream
    .observe([
      observed(running(first, [tool(1, "one"), tool(2, "three")]), facts),
      observed(running(second, [tool(1, "two"), tool(2, "four")])),
    ])
    .join("\n");
  assert.match(text2, /@a +✓ run +\$ one/u);
  assert.match(text2, /aku\/worker\/abcd0021 +✓ run +\$ two/u);
  assert.ok(!text2.includes(head), "headers do not recur");

  const text3 = stream
    .observe([
      observed(running(first, [tool(1, "one"), tool(2, "three"), tool(3, "five")]), facts),
      observed(running(second, [tool(1, "two"), tool(2, "four"), tool(3, "six")])),
    ])
    .join("\n");
  assert.match(text3, /@a +✓ run +\$ three/u);
  assert.match(text3, /aku\/worker\/abcd0021 +✓ run +\$ four/u);
  // Every semantic row puts its mark in the same source-aligned column.
  const marks = [text2, text3]
    .flatMap((block) => block.split("\n"))
    .filter((line) => line.includes("✓ run"))
    .map((line) => displayColumns(line.slice(0, line.indexOf("✓"))));
  assert.deepEqual(new Set(marks), new Set([26]));
});

test("a plural wait freezes its source column from the selected set before the first row", () => {
  const first = "aku/worker/abcd0023";
  const second = "aku/worker/abcd0024";
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  stream.select([{ id: first, alias: "@shorter" }, { id: second, alias: "@a-very-long-alias" }]);
  const tool = (sequence: number, command: string) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command }));
  const status = (entries: Parameters<typeof openAkumaSnapshot>[0]) =>
    parseAkumaStatus({ id: first, life: "running", allowed: [], timeline: openAkumaSnapshot(entries) });
  const facts = { alias: parseAkumaAlias("@shorter"), contract: { kind: "none" as const } };
  // The baseline round settles nothing, so the first rendered row still uses the frozen width.
  stream.observe([observed(status([tool(1, "solo")]), facts)]);
  const row = stream
    .observe([observed(status([tool(1, "solo"), tool(2, "later")]), facts)])
    .find((line) => line.includes("solo"));
  assert.ok(row !== undefined);
  assert.equal(displayColumns(row.slice(0, row.indexOf("✓"))), 5 + 1 + displayColumns("@a-very-long-alias") + 1);
});

test("a plural wait keeps source attribution on omission markers and continuations", () => {
  const id = "aku/worker/abcd0025";
  const alias = "@longer-name";
  const stream = waitObservationStream({ columns: 60, color: false }, { now: () => 0 });
  // A plural wait freezes every selected identity, even one this round never observes.
  stream.select([
    { id, alias },
    { id: "aku/worker/abcd0027", alias: "@other" },
  ]);
  const tools = [1, 2, 3, 4, 5].map((sequence) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command: `c${sequence}` })),
  );
  const note = (sequence: number, text: string) =>
    snapshotRow({ kind: "note", sequence, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text });
  const status = (entries: Parameters<typeof openAkumaSnapshot>[0]) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot(entries) });
  const facts = { alias: parseAkumaAlias(alias), contract: { kind: "none" as const } };
  // The baseline round settles nothing; the next round settles the tool burst and one long note.
  stream.observe([observed(status([tools[0]!]), facts)]);
  const lines = stream.observe([
    observed(
      status([
        ...tools,
        note(6, "alpha beta gamma delta epsilon zeta eta theta iota"),
        note(7, "still open"),
      ]),
      facts,
    ),
  ]);
  const marker = lines.find((line) => line.includes("⋮ 2 omitted"));
  assert.ok(marker !== undefined);
  assert.ok(marker.startsWith(`${" ".repeat(5)} ${alias.padEnd(displayColumns(alias))} ⋮ 2 omitted`));
  const toolRow = lines.find((line) => line.includes("✓ run"));
  assert.ok(
    toolRow !== undefined && toolRow.includes(alias),
    `retained tool rows keep their source column:\n${lines.join("\n")}`,
  );
  assert.ok(
    lines.some((line) => line.startsWith(`${" ".repeat(5)} ${" ".repeat(displayColumns(alias))} │`)),
    "continuations blank the time and source columns",
  );
});

test("a single-target wait stream keeps the plain row grammar", () => {
  const id = "aku/worker/abcd0026";
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  stream.select([{ id, alias: "@solo" }]);
  const tool = (sequence: number, command: string) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command }));
  const running = (entries: Parameters<typeof openAkumaSnapshot>[0]) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot(entries) });
  const facts = { alias: parseAkumaAlias("@solo"), contract: { kind: "none" as const } };
  // The baseline round settles nothing, so the next round streams the row it held open.
  stream.observe([observed(running([tool(1, "solo")]), facts)]);
  const text = stream.observe([observed(running([tool(1, "solo"), tool(2, "later")]), facts)]).join("\n");
  assert.match(text, /✓ run +\$ solo/u);
  assert.doesNotMatch(text, /@solo/u, "a single target carries no source column");
  const row = text.split("\n").find((line) => line.includes("✓ run"))!;
  assert.equal(
    displayColumns(row.slice(0, row.indexOf("✓"))),
    5 + 1,
    "the mark sits where the plain row grammar puts it",
  );
});

test("terminal width counts grapheme clusters rather than code points", () => {
  const family = "👨‍👩‍👧‍👦";
  assert.equal([...family].length, 7, "a ZWJ family is seven code points in one cluster");
  assert.equal(displayColumns(family), 2, "a ZWJ sequence occupies one cell group");
  assert.equal(displayColumns("©"), 1, "a plain text symbol stays narrow");
  assert.equal(displayColumns("©️"), 2, "the emoji selector widens the same symbol");
  assert.equal(displayColumns("™"), 1, "an unselected letterlike symbol stays narrow");
  assert.equal(displayColumns("♥"), 1, "a text-presentation heart stays narrow");
  assert.equal(displayColumns("☀"), 1, "a text-presentation sun stays narrow");
  assert.equal(displayColumns("❤"), 1, "an emoji without its selector stays text width");
  assert.equal(displayColumns("✅"), 2, "an emoji that is wide by default needs no selector");
  assert.equal(displayColumns("🇺🇸"), 2, "a flag is one pair of regional indicators");
  assert.equal(displayColumns("❤️"), 2, "an emoji presentation selector widens its base");
  assert.equal(displayColumns("1️⃣"), 2, "a keycap is one cluster");
  assert.equal(displayColumns("👍🏽"), 2, "a skin tone modifier adds no cells");
  assert.equal(displayColumns("é"), 1, "a precomposed accented letter is one cell");
  assert.equal(displayColumns("e\u0301"), 1, "a combining mark adds no cell");
  assert.equal(displayColumns("\u0301"), 0, "an isolated mark occupies no cell");
  assert.equal(displayColumns(`a${family}b`), 4, "narrow text around a cluster keeps its cells");
  assert.equal(displayColumns("plain ascii"), 11, "ASCII keeps its own measure");
  assert.deepEqual(takeDisplayColumns(`a${family}b`, 3), { text: `a${family}`, rest: "b" });
  assert.deepEqual(takeDisplayColumns("🇺🇸x", 1), { text: "", rest: "🇺🇸x" }, "a cluster never splits");
  assert.deepEqual(takeDisplayColumns("e\u0301x", 1), { text: "e\u0301", rest: "x" });
});

test("a plural wait aligns a source label wider than its code-unit length and quotes only body text", () => {
  const id = "aku/worker/abcd0031";
  const alias = "@👨‍👩‍👧‍👦x";
  const stream = waitObservationStream({ columns: 60, color: false }, { now: () => 0 });
  stream.select([{ id, alias }, { id: "aku/worker/abcd0032", alias: "@other" }]);
  const status = (entries: Parameters<typeof openAkumaSnapshot>[0]) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot(entries) });
  const said = (sequence: number, text: string) =>
    snapshotRow({ kind: "said", sequence, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text });
  const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
  const facts = { alias: alias as AkumaAlias, contract: { kind: "none" as const } };
  // The baseline round opens the head frame; the next round settles the short row and holds the
  // long quoted row open, so the round after that is the one that streams it wrapped.
  stream.observe([observed(status([said(1, "first words")]), facts)]);
  stream.observe([observed(status([said(1, "first words"), said(2, words)]), facts)]);
  const lines = stream.observe([
    observed(status([said(1, "first words"), said(2, words), said(3, "closing words")]), facts),
  ]);
  assert.ok(lines.length > 1, `the long row wraps into continuation lines:\n${lines.join("\n")}`);
  const marks = lines.map((line) => displayColumns(line.slice(0, line.indexOf("│"))));
  assert.equal(
    new Set(marks).size,
    1,
    `every line of the row aligns under the same source label:\n${lines.join("\n")}`,
  );
  assert.equal(
    marks[0],
    5 + 1 + Math.max(displayColumns(alias), displayColumns("@other")) + 1,
    "the frozen label width sets the mark column",
  );
  const quoted = lines.map((line) => line.slice(line.indexOf("“"))).join(" ");
  assert.equal(
    lines.filter((line) => line.includes("“")).length,
    lines.length,
    `every wrapped line quotes its own body:\n${lines.join("\n")}`,
  );
  for (const word of words.split(" ")) {
    assert.ok(quoted.includes(word), `the quote keeps ${word}:\n${lines.join("\n")}`);
  }
  const scoreLine = stream
    .conclude({
      observations: [
        {
          status: status([said(1, "first words"), said(2, words)]),
          contract: { kind: "none" as const },
          createdTasks: { kind: "present" as const, rows: [] },
        },
        {
          status: parseAkumaStatus({
            id: "aku/worker/abcd0032",
            life: "running",
            allowed: [],
            timeline: openAkumaSnapshot([]),
          }),
          contract: { kind: "none" as const },
          createdTasks: { kind: "present" as const, rows: [] },
        },
      ],
      unobserved: [],
    })
    .split("\n")
    .find((line) => line.includes("👨‍👩‍👧‍👦") && line.includes("● still running"))!;
  assert.equal(
    displayColumns(scoreLine.slice(0, scoreLine.indexOf("●"))),
    marks[0],
    `the scoreboard shares the activity mark column:\n${scoreLine}`,
  );
});

test("a streamed observing call opens one framed head and never replays a settled snapshot", () => {
  const id = "aku/worker/abcd0030";
  const settledAtMs = Date.parse(AKUMA_ACTIVITY_AT);
  let now = settledAtMs - 4_000;
  const head = {
    id,
    alias: "@scout",
    contract: { kind: "associated" as const, contractId: contractId("kei/demo") },
    facts: [],
  };
  const stream = callObservationStream({ columns: 100, color: false }, head, { now: () => now });
  const running = (entries: Parameters<typeof openAkumaSnapshot>[0]) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot(entries) });
  const tool = (sequence: number, command: string) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command }));
  const headLines = [`${id} (@scout)`, "└─ kei/demo"];
  const opening = stream.observe(running([tool(1, "first")]));
  assert.deepEqual(opening, [...headLines, frameRule(headLines)], "the head opens once before any row");
  assert.doesNotMatch(opening.join("\n"), /cwd|✓ run/u);
  const growing = running([tool(1, "first"), tool(2, "second")]);
  const text = stream.observe(growing).join("\n");
  assert.deepEqual(stream.observe(growing), [], "a settled row never streams twice");
  assert.match(text, /✓ run +\$ first/u);
  assert.doesNotMatch(text, /second|@scout|└─ kei\/demo/u, "the head never recurs and the newest row is still moving");

  now = settledAtMs + 1_000;
  const answered = parseAkumaStatus({
    id,
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([], answeredOutcome(2, "the answer")),
  });
  const conclusion = stream.conclude({ kind: "observed", status: answered });
  assert.equal(conclusion, `${clockAt(settledAtMs)} ✓ answered — 4s`);
  assert.doesNotMatch(conclusion, /the answer|└─ kei\/demo|@scout/u, "no head or answer replay");
});

test("a streamed observing call concludes truthfully when its stream never opened", () => {
  const id = "aku/worker/abcd0031";
  const head = { id, contract: { kind: "none" as const }, facts: [] };
  let now = 10_000;
  const runningStream = callObservationStream({ columns: 80, color: false }, head, { now: () => now });
  now = 40_000;
  const running = parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot([]) });
  const opened = runningStream.conclude({ kind: "observed", status: running }).split("\n");
  assert.deepEqual(opened.slice(0, 2), [id, frameRule([id])]);
  assert.equal(opened.at(-1), `${clockAt(40_000)} ● still running — waited 30s`);

  const failedStream = callObservationStream({ columns: 80, color: false }, head, { now: () => 0 });
  const failed = failedStream
    .conclude({ kind: "failed", failure: { kind: "infrastructure", diagnostic: "window lost" } })
    .split("\n");
  assert.deepEqual(failed.slice(0, 2), [id, frameRule([id])]);
  assert.equal(failed.at(-1), "! error window lost");

  const failedOutcome: OutcomeRow = {
    kind: "outcome",
    sequence: 2,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    outcome: { kind: "failed", historyId: "history-1", diagnostic: "provider 503" },
  };
  const outcomeStream = callObservationStream({ columns: 80, color: false }, head, { now: () => 0 });
  const outcomeText = outcomeStream.conclude({
    kind: "observed",
    status: parseAkumaStatus({ id, life: "asleep", allowed: [], timeline: idleAkumaSnapshot([], failedOutcome) }),
  });
  assert.match(outcomeText, /! failed — /u);
  assert.match(outcomeText, /! error provider 503/u);
});
