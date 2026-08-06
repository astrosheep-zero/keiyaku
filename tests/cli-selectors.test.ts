import assert from "node:assert/strict";
import test from "node:test";
import type { ContractId, StatusReport } from "../src/index.js";
import { resolveExistingContract } from "../src/cli/selectors.js";
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
        terminal: null,
        workspace: "worktree",
        worktreePath: "/repo/.keiyaku-v4/worktrees/active-contract",
        target: "refs/heads/main",
      },
      {
        contractId: here,
        phase: "bound",
        terminal: null,
        workspace: "here",
        worktreePath: null,
        target: "refs/heads/main",
      },
    ],
  };
}

test("selectors resolve active worktrees from public status rows", () => {
  const report = status();
  assert.equal(resolveExistingContract(report, "@active-contract"), active);
  assert.equal(resolveExistingContract(report, undefined), active);
});

test("omitted selectors require an exact public scope and exclude here workspaces", () => {
  assert.throws(
    () => resolveExistingContract(status("/repo/.keiyaku-v4/worktrees/active-contract/subdirectory"), undefined),
    CliUsageError,
  );
  assert.throws(
    () => resolveExistingContract({ ...status(), scope: "/repo" }, undefined),
    CliUsageError,
  );
});
