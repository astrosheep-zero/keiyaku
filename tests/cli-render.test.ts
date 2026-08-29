import assert from "node:assert/strict";
import test from "node:test";
import { changeId, contractHead, contractId, snapshotId } from "../src/core/facts/types.js";
import type { InvocationResult } from "../src/cli/result.js";
import { renderCatalogText } from "../src/cli/render/catalog.js";
import { renderText } from "../src/cli/render/text.js";
import type { Catalog } from "../src/library/catalog.js";
import type { ContractRow } from "../src/protocol/read/status.js";

test("catalog text renders only the selected identity layer", () => {
  assert.equal(
    renderCatalogText({
      kind: "archetypes",
      rows: [{ name: "reviewer", model: "codex-5", description: "Read the complete change without truncation." }],
    }),
    ["archetypes 1", "", "reviewer - codex-5", "  Read the complete change without truncation."].join("\n"),
  );
  assert.equal(
    renderCatalogText({
      kind: "akuma",
      root: "/world",
      archetype: "worker",
      observedAt: "2026-08-12T00:00:00.000Z",
      rows: [{ id: "aku/worker/deadbeef" as never, life: "unborn" }],
      searched: ["/world/.keiyaku/akuma/run"],
    }),
    ["akuma instances 1 of 1 known", "  scope worker", "", "○ aku/worker/deadbeef · unborn"].join("\n"),
  );
});

test("scoped Akuma catalog recovery preserves its instance population", () => {
  const text = renderCatalogText({
    kind: "akuma",
    root: "/world",
    archetype: "worker",
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: Array.from({ length: 11 }, (_, index) => ({
      id: `aku/worker/${String(index).padStart(8, "0")}` as never,
      life: "unborn" as const,
    })),
    searched: [],
  });
  assert.match(text, /akuma instances 10 of 11 known/u);
  assert.match(text, /keiyaku ls aku\/worker\//u);
  assert.doesNotMatch(text, /aku\/\*\/\*/u);
});

test("Akuma catalog renders future ages as now", () => {
  const text = renderCatalogText({
    kind: "akuma",
    root: "/world",
    archetype: "worker",
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: [
      {
        id: "aku/worker/future" as never,
        archetype: "worker",
        life: "unborn",
        lifeAt: "2026-08-12T00:00:01.000Z",
        lastActivityAt: null,
        pending: [],
      },
    ],
    searched: [],
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
      location: { kind: "worktree" },
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
  };
  const text = renderCatalogText(catalog);

  assert.match(text, /1 active · 0 candidates/u);
  assert.match(text, /contract state aaaaaaa · observedAt 2026-08-12T00:00:00.000Z/u);
  assert.match(text, /! kei\/selected-contract · waiting · 0s · Selected Contract/u);
  assert.match(text, /^  no candidate · no target$/mu);
  assert.doesNotMatch(text, /○ no candidate · ● candidate|satisfied  \[✗\] unsatisfied/u);
  assert.doesNotMatch(text, /worktree clean|tender |integration |merge /u);
  assert.doesNotMatch(text, new RegExp(state, "u"));
  assert.match(text, /\[✓\] reviewed  \[✗\] verified  \[~\] security \(stale\)  \[ \] manual/u);
  assert.match(text, /after kei\/claimed-prerequisite \(claimed\)/u);
  assert.match(text, /blocked by kei\/active-prerequisite \(waiting\)/u);
  assert.match(text, /blocked by kei\/abandoned-prerequisite \(abandoned\)/u);
  assert.match(text, /blocked by kei\/missing-prerequisite \(missing\)/u);
  assert.match(text, /dependents kei\/dependent-contract \(waiting\)/u);

  const snap = snapshotId("b".repeat(40));
  const delivered = renderCatalogText({
    ...catalog,
    rows: [
      {
        ...row,
        phase: "tendered",
        delivery: {
          tenderSnapshot: snap,
          integration: { predecessor: snap, snapshot: snap, changeId: changeId("chg-selected-contract") },
          method: "squash",
          policy: { requireBranchesToBeUpToDate: false },
        },
      },
    ],
  });
  assert.match(delivered, /1 active · 1 candidate(?!s)/u);
  assert.match(delivered, /^  candidate · no target$/mu);
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
        targetLag: { kind: "counted", behind: 0 },
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
  assert.match(moved, /^  candidate · target main · 0 commits behind main · target moved · bbbbbbb -> ccccccc$/mu);

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
    /^  candidate · target main · commits behind main unknown · target moved · bbbbbbb -> null$/mu,
  );
});

test("observation text keeps the command and view data together", () => {
  const result: InvocationResult = { kind: "observation", command: "status", contracts: [] };
  assert.equal(renderText(result), 'observation status\n{\n  "contracts": []\n}');
});

test("world reconcile text keeps a completed report under report", () => {
  const result: InvocationResult = {
    kind: "observation",
    command: "reconcile",
    report: { kind: "completed", contracts: [] },
  };
  assert.equal(
    renderText(result),
    ["observation reconcile", "{", '  "report": {', '    "kind": "completed",', '    "contracts": []', "  }", "}"].join(
      "\n",
    ),
  );
});

test("world observation failure text is exact", () => {
  const result: InvocationResult = {
    kind: "observation",
    command: "reconcile",
    report: { kind: "world-observation-failed", diagnostic: "git failed" },
  };
  assert.equal(renderText(result), "reconcile: world observation failed · git failed");
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
  assert.equal(
    renderText(result),
    [
      "✓ terms replaced — kei/no-amend-region-observation",
      "  terms diff",
      "",
      "",
      "",
      "  record",
      "    head head",
    ].join("\n"),
  );
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
    lag: [{ kind: "worktree-follow-retained" as const, path: "/tmp/wt", tender, head, reason: "head-moved" as const }],
    settlementLags: [],
  };
  assert.equal(
    renderText({ ...envelope, verb: "deliver" }),
    [
      "✓ deliver — not complete — kei/followed",
      "  candidate kept",
      "  record",
      "    head record",
      "  ! lag",
      "    worktree-follow-retained reason=head-moved tender=tender head=head path=/tmp/wt",
    ].join("\n"),
  );
  assert.deepEqual(envelope.lag[0], {
    kind: "worktree-follow-retained",
    path: "/tmp/wt",
    tender,
    head,
    reason: "head-moved",
  });
});

test("accepted receipts omit execution telemetry and retain recovery snapshots", () => {
  const contract = contractId("kei/unchanged-mechanics");
  const head = contractHead("head");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract,
    head,
    facts: [{ contract, entry: "claim", kind: "claimed" }],
    lag: [{ kind: "unsealed-bytes", path: "/repo/.keiyaku/wt/contract", paths: [] }],
    settlementLags: [],
    recoverySnapshot: snapshotId("recovery"),
    completion: { integration: snapshotId("integration") },
  };

  const text = renderText(result);
  assert.doesNotMatch(text, /ref updated|contract-file|worktree unchanged/u);
  assert.doesNotMatch(text, /ephemeral/u);
  assert.match(text, /recovery snapshot recovery/u);
  assert.match(text, /unsealed-bytes \/repo\/\.keiyaku\/wt\/contract/u);
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
      "✓ deliver — not complete — kei/waiting-on-prerequisites",
      "! prerequisites unsatisfied",
      "  prerequisite kei/active-prerequisite · active",
      "  prerequisite kei/abandoned-prerequisite · abandoned",
      "  prerequisite kei/missing-prerequisite · missing",
      "  candidate kept",
      "  record",
      "    head head",
    ].join("\n"),
  );

  const review: InvocationResult = { ...envelope, verb: "review", verdict: "satisfied", placement };
  assert.equal(
    renderText(review),
    [
      "✓ review satisfied — not complete — kei/waiting-on-prerequisites",
      "! prerequisites unsatisfied",
      "  prerequisite kei/active-prerequisite · active",
      "  prerequisite kei/abandoned-prerequisite · abandoned",
      "  prerequisite kei/missing-prerequisite · missing",
      "  candidate kept",
      "  record",
      "    head head",
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
              gate: "verified",
              current: {
                kind: "attested",
                verdict: "unsatisfied",
                summary: "[1 bash exit 1]",
                at: "2026-08-01T00:00:00.000Z",
              },
            },
            { gate: "reviewed", current: { kind: "stale", priorVerdict: "satisfied" } },
            { gate: "manual", current: { kind: "missing" } },
          ],
        },
      },
    }),
    [
      "✓ deliver — not complete — kei/waiting-on-gates",
      "! gates unsatisfied",
      "  gate verified · unsatisfied · at=2026-08-01T00:00:00.000Z",
      "  summary verified",
      "",
      "[1 bash exit 1]",
      "",
      "  gate reviewed · stale · prior=satisfied",
      "  gate manual · missing",
      "  candidate kept",
      "  record",
      "    head head",
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
        "  checkout: /repo/checkout",
        "  target: refs/heads/main",
        "  reason: staged",
        "  paths:",
        '    - "staged.ts"',
        '    - "quote\\"path.ts"',
      ],
    },
    {
      reason: "conflict" as const,
      paths: ["conflict.ts"],
      text: [
        "! checkout-not-followable",
        "  checkout: /repo/checkout",
        "  target: refs/heads/main",
        "  reason: conflict",
        "  paths:",
        '    - "conflict.ts"',
      ],
    },
    {
      reason: "untracked" as const,
      paths: [],
      text: [
        "! checkout-not-followable",
        "  checkout: /repo/checkout",
        "  target: refs/heads/main",
        "  reason: untracked",
        "  paths: (none)",
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
    });
    const renderedLines = rendered.split("\n");
    const start = renderedLines.indexOf("! checkout-not-followable");
    assert.notEqual(start, -1);
    assert.deepEqual(renderedLines.slice(start, start + text.length), text);
  }
});

test("direct checkout refusal uses the same exact fact block", () => {
  const contract = contractId("kei/direct-checkout-followability");
  assert.equal(
    renderText({
      kind: "refused",
      verb: "deliver",
      contract,
      refusal: {
        kind: "checkout-not-followable",
        contractId: contract,
        target: "refs/heads/main",
        path: "/repo/checkout",
        reason: "conflict",
        paths: ["a/b.txt"],
      },
    }),
    [
      `! deliver refused — ${contract}`,
      "! checkout-not-followable",
      "  checkout: /repo/checkout",
      "  target: refs/heads/main",
      "  reason: conflict",
      "  paths:",
      '    - "a/b.txt"',
    ].join("\n"),
  );
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
      completion: { integration: snapshotId("integration") },
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
      "✓ delivered — kei/prerequisite-checkout",
      "  target -> integration",
      "! continuation kei/stopped-checkout-dependent",
      "! checkout-not-followable",
      "  checkout: /repo/checkout",
      "  target: refs/heads/main",
      "  reason: untracked",
      "  paths:",
      '    - "quote\\"path.ts"',
      "  record",
      "    head head",
    ].join("\n"),
  );
});

test("deliver projects a ran Verification completion", () => {
  const contract = contractId("kei/completion");
  const integration = snapshotId("integration-1");
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
      completion: { integration, verification: { mode: "ran", verdict: "satisfied" } },
    }),
    [
      "✓ delivered — kei/completion",
      "  target -> integration-1 · verified (ran)",
      "  record",
      "    journal claim · claimed",
      "    head head",
    ].join("\n"),
  );
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
      completion: { integration: snapshotId("integration") },
      continuation: {
        claimed: [claimed],
        stopped: [
          {
            contractId: stopped,
            stop: {
              refusal: {
                kind: "gates-unsatisfied",
                contractId: stopped,
                unmet: [{ gate: "reviewed", current: { kind: "missing" } }],
              },
            },
          },
        ],
      },
    }),
    [
      "✓ delivered — kei/prerequisite",
      "  target -> integration",
      "✓ continuation complete kei/claimed-dependent",
      "! kei/stopped-dependent · gates unsatisfied",
      "  gate reviewed · missing",
      "  record",
      "    head head",
    ].join("\n"),
  );
});

test("deliver projects no Verification and an unsatisfied non-gating Verification", () => {
  const contract = contractId("kei/completion-states");
  const integration = snapshotId("integration-2");
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
      completion: { integration },
    }),
    [
      "✓ delivered — kei/completion-states",
      "  target -> integration-2",
      "  record",
      "    journal claim · claimed",
      "    head head",
    ].join("\n"),
  );

  assert.equal(
    renderText({
      ...envelope,
      verb: "deliver",
      completion: { integration, verification: { mode: "ran", verdict: "unsatisfied" } },
      verificationSummary: "[1 bash exit 1]",
    }),
    [
      "✓ delivered — kei/completion-states",
      "  target -> integration-2",
      "! verification unsatisfied (ran) · not required by Contract gates",
      "  summary",
      "",
      "[1 bash exit 1]",
      "",
      "  record",
      "    journal claim · claimed",
      "    head head",
    ].join("\n"),
  );
});

test("review projects reused Verification and distinguishes completion in its title", () => {
  const contract = contractId("kei/review-completion");
  const integration = snapshotId("integration-3");
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
      completion: { integration, verification: { mode: "reused", verdict: "satisfied" } },
    }),
    [
      "✓ review satisfied — complete — kei/review-completion",
      "  target -> integration-3 · verified (reused)",
      "  record",
      "    journal claim · claimed",
      "    head head",
    ].join("\n"),
  );
});

test("review projects a reused unsatisfied Verification as non-gating completion", () => {
  const contract = contractId("kei/review-completion-unsatisfied");
  const integration = snapshotId("integration-4");
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
      completion: { integration, verification: { mode: "reused", verdict: "unsatisfied" } },
      verificationSummary: "[reused bash exit 1]",
    }),
    [
      "✓ review satisfied — complete — kei/review-completion-unsatisfied",
      "  target -> integration-4",
      "! verification unsatisfied (reused) · not required by Contract gates",
      "  summary",
      "",
      "[reused bash exit 1]",
      "",
      "  record",
      "    journal claim · claimed",
      "    head head",
    ].join("\n"),
  );
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
  const facts = [
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
      completion: { integration: secondIntegrated },
    }),
    [
      "✓ delivered — kei/reintegrated",
      "~ target moved · re-integrated x2",
      "  target -> integration-4",
      "  record",
      "    journal reintegration · reintegrated target-1 -> integration-2",
      "    journal reintegration-2 · reintegrated target-3 -> integration-4",
      "    journal claim · claimed",
      "    head head",
    ].join("\n"),
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
      },
    }),
    [
      "✓ deliver — not complete — kei/reintegrated",
      "~ target moved · re-integrated x2",
      "! target moved refs/heads/main integration-2 -> null attempts=3",
      "  candidate kept",
      "  record",
      "    journal reintegration · reintegrated target-1 -> integration-2",
      "    journal reintegration-2 · reintegrated target-3 -> integration-4",
      "    head head",
    ].join("\n"),
  );
});

test("deliver conflict text exposes target head, paths, and recovery", () => {
  const contract = contractId("kei/conflicted");
  const targetHead = snapshotId("target-head");
  assert.equal(
    renderText({
      kind: "refused",
      verb: "deliver",
      contract,
      refusal: {
        kind: "integration-failed",
        contractId: contract,
        reason: "conflict",
        targetHead,
        conflictPaths: ["a.txt", "z.txt"],
        recovery: { materialize: "deliver --materialize-conflict", continue: "deliver --include-dirty" },
      },
    }),
    [
      "! deliver refused — kei/conflicted",
      "   integration-failed reason=conflict targetHead=target-head",
      "   conflictPaths",
      "   │ a.txt",
      "   │ z.txt",
      "   recovery materialize conflicts · deliver --materialize-conflict",
      "   recovery continue after resolve and commit · deliver --include-dirty",
    ].join("\n"),
  );
});

test("merge-state-present and materialized conflict render their public fields", () => {
  const contract = contractId("kei/conflicted");
  const targetHead = snapshotId("target-head");
  const workspace = { kind: "worktree" as const, path: "/tmp/wt" };
  assert.equal(
    renderText({
      kind: "refused",
      verb: "deliver",
      contract,
      refusal: { kind: "merge-state-present", contractId: contract, workspace },
    }),
    ["! deliver refused — kei/conflicted", "   merge-state-present workspace=worktree path=/tmp/wt"].join("\n"),
  );
  assert.equal(
    renderText({
      kind: "integration-conflict-materialized",
      targetHead,
      conflictPaths: ["a.txt", "z.txt"],
      workspace,
    }),
    [
      "integration-conflict-materialized targetHead=target-head",
      "   conflictPaths",
      "   │ a.txt",
      "   │ z.txt",
      "   workspace worktree /tmp/wt",
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
    ["! deliver refused — kei/conflicted", "   unmerged-paths", "   paths", "   │ a.txt", "   │ z.txt"].join("\n"),
  );
});
