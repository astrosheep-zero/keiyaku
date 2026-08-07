import assert from "node:assert/strict";
import test from "node:test";
import type { ContractBoard, ContractId } from "../src/index.js";
import type { KanshiReport } from "../src/kanshi/index.js";
import { resolveContextualContract, resolveKanshiContract } from "../src/cli/selectors.js";
import { CliUsageError } from "../src/cli/parse.js";

const active = "kei/active-contract" as ContractId;
const here = "kei/here-contract" as ContractId;

function board(): ContractBoard {
  return {
    root: "/repo",
    rows: [
      {
        id: active,
        phase: "bound",
        disposition: "active",
        workspace: "worktree",
        worktreePath: "/repo/.keiyaku-v4/worktrees/active-contract",
        target: "refs/heads/main",
        candidate: null,
        gates: { reports: [], satisfied: true },
      },
      {
        id: here,
        phase: "bound",
        disposition: "active",
        workspace: "here",
        worktreePath: null,
        target: "refs/heads/main",
        candidate: null,
        gates: { reports: [], satisfied: true },
      },
    ],
  };
}

test("selectors resolve active worktrees from public status rows", () => {
  const report = board();
  assert.equal(resolveContextualContract(report, "@active-contract", "/repo"), active);
  assert.equal(resolveContextualContract(report, undefined, "/repo/.keiyaku-v4/worktrees/active-contract"), active);
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

test("omitted selectors require an exact public scope and exclude here workspaces", () => {
  assert.throws(
    () => resolveContextualContract(board(), undefined, "/repo/.keiyaku-v4/worktrees/active-contract/subdirectory"),
    CliUsageError,
  );
  assert.throws(
    () => resolveContextualContract(board(), undefined, "/repo"),
    CliUsageError,
  );
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
      () => resolveContextualContract(report, undefined, "/repo/.keiyaku-v4/worktrees/active-contract"),
      CliUsageError,
    );
  }
});

function kanshiReport(contracts: KanshiReport["contracts"]): KanshiReport {
  return {
    root: "/repo",
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
