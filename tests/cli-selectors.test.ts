import assert from "node:assert/strict";
import test from "node:test";
import type { ContractBoard, ContractId } from "../src/index.js";
import type { ContractKanshiBoard } from "../src/kanshi/index.js";
import type { WorldRoot } from "../src/world.js";
import type { KanshiReport } from "../src/kanshi/index.js";
import { resolveContextualContract, resolveKanshiContract } from "../src/cli/selectors.js";
import { CliUsageError } from "../src/cli/parse.js";

const active = "kei/active-contract" as ContractId;

function board(): ContractKanshiBoard {
  return {
    root: "/repo",
    state: null,
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: [
      {
        id: active,
        title: "Active contract",
        phase: "bound",
        phaseAt: "2026-08-12T00:00:00.000Z",
        lastJournalAt: "2026-08-12T00:00:00.000Z",
        disposition: "active",
        workspace: "worktree",
        worktreePath: "/repo/.keiyaku/wt/active-contract",
        workspaceObservation: {
          kind: "clean",
          location: { kind: "worktree", path: "/repo/.keiyaku/wt/active-contract" },
          counts: { staged: 0, unstaged: 0, untracked: 0, submodules: 0 },
          merge: null,
        },
        target: "refs/heads/main",
        targetLag: { kind: "counted", behind: 0 },
        delivery: null,
        targetObservation: null,
        gates: { reports: [], satisfied: true },
        after: [],
        dependents: [],
        holder: { kind: "none" },
        fleet: [],
      },
    ],
  };
}

test("selectors resolve active worktrees from public status rows", () => {
  const report = board();
  assert.equal(resolveContextualContract(report, "@active-contract", "/repo"), active);
  assert.equal(resolveContextualContract(report, undefined, "/repo/.keiyaku/wt/active-contract"), active);
});

test("short selectors match normalized contract segments without a second grammar", () => {
  const normalized = "kei/修复-👩‍💻" as ContractId;
  const base = board();
  const report = {
    ...base,
    rows: [{ ...base.rows[0]!, id: normalized }],
  } satisfies ContractBoard;
  assert.equal(resolveContextualContract(report, "@修复-👩‍💻", "/repo"), normalized);
});

test("omitted selectors require an exact public scope", () => {
  assert.throws(
    () => resolveContextualContract(board(), undefined, "/repo/.keiyaku/wt/active-contract/subdirectory"),
    CliUsageError,
  );
  assert.throws(() => resolveContextualContract(board(), undefined, "/repo"), CliUsageError);
});

test("selectors use disposition rather than reinterpreting terminal phases", () => {
  for (const phase of ["claimed", "abandoned"] as const) {
    const base = board();
    const report = {
      ...base,
      rows: [{ ...base.rows[0]!, phase, disposition: "terminal" }],
    } satisfies ContractBoard;
    assert.throws(() => resolveContextualContract(report, "@active-contract", "/repo"), CliUsageError);
    assert.throws(
      () => resolveContextualContract(report, undefined, "/repo/.keiyaku/wt/active-contract"),
      CliUsageError,
    );
  }
});

function kanshiReport(contracts: KanshiReport["contracts"]): KanshiReport {
  return {
    root: "/repo" as WorldRoot,
    observedAt: "2026-08-12T00:00:00.000Z",
    branch: null,
    contracts,
    tasks: { kind: "absent" },
    akuma: { kind: "absent" },
  };
}

test("Kanshi selectors share Contract identity syntax without hiding world availability", () => {
  assert.equal(resolveKanshiContract(kanshiReport({ kind: "present", value: board() }), "@active-contract"), active);
  assert.equal(resolveKanshiContract(kanshiReport({ kind: "present", value: board() }), active), active);
  for (const contracts of [{ kind: "absent" }, { kind: "failed", failure: { message: "broken" } }] as const) {
    assert.throws(() => resolveKanshiContract(kanshiReport(contracts), active), CliUsageError);
  }
});
