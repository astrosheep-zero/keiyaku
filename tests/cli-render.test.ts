import assert from "node:assert/strict";
import test from "node:test";
import { changeId, contractHead, contractId, gate, snapshotId } from "../src/core/facts/types.js";
import type { InvocationResult, Lag } from "../src/cli/result.js";
import { renderCatalogText } from "../src/cli/render/catalog.js";
import { snapshotActivityLines, snapshotText, waitText } from "../src/cli/render/akuma-activity.js";
import { parseAkumaStatus } from "../src/akuma/akuma.js";
import { renderAkuma } from "../src/cli/render/kanshi-akuma.js";
import { displayColumns } from "../src/cli/render/terminal.js";
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
    cases.map(([state, mark]) => `${mark} task/${state} · ${state} · P1 — ${state}`).join("\n"),
  );
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
