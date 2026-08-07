import assert from "node:assert/strict";
import test from "node:test";
import type { ContractId, StatusReport } from "../src/index.js";
import { resolveContextualContract } from "../src/cli/selectors.js";
import { CliUsageError } from "../src/cli/parse.js";

const active = "kei/active-contract" as ContractId;
const here = "kei/here-contract" as ContractId;

function status(scope = "/repo/.keiyaku-v4/worktrees/active-contract"): StatusReport {
  return {
    scope,
    contracts: [
      {
        contractId: active,
        phase: "bound",
        workspace: "worktree",
        worktreePath: "/repo/.keiyaku-v4/worktrees/active-contract",
        target: "refs/heads/main",
        verification: null,
      },
      {
        contractId: here,
        phase: "bound",
        workspace: "here",
        worktreePath: null,
        target: "refs/heads/main",
        verification: null,
      },
    ],
  };
}

test("selectors resolve active worktrees from public status rows", () => {
  const report = status();
  assert.equal(resolveContextualContract(report, "@active-contract"), active);
  assert.equal(resolveContextualContract(report, undefined), active);
});

test("omitted selectors require an exact public scope and exclude here workspaces", () => {
  assert.throws(
    () => resolveContextualContract(status("/repo/.keiyaku-v4/worktrees/active-contract/subdirectory"), undefined),
    CliUsageError,
  );
  assert.throws(
    () => resolveContextualContract({ ...status(), scope: "/repo" }, undefined),
    CliUsageError,
  );
});

test("selectors exclude claimed and abandoned rows from active candidates", () => {
  for (const phase of ["claimed", "abandoned"] as const) {
    const base = status();
    const report = {
      ...base,
      contracts: [{ ...base.contracts[0]!, phase }],
    } satisfies StatusReport;
    assert.throws(() => resolveContextualContract(report, "@active-contract"), CliUsageError);
    assert.throws(() => resolveContextualContract(report, undefined), CliUsageError);
  }
});
