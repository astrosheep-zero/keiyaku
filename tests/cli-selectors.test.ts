import assert from "node:assert/strict";
import test from "node:test";
import type { ContractBoard, ContractId } from "../src/index.js";
import type { ContractKanshiBoard } from "../src/kanshi/index.js";
import type { WorldRoot } from "../src/world.js";
import type { KanshiReport } from "../src/kanshi/index.js";
import { resolveContextualContract, resolveKanshiContract } from "../src/cli/selectors.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { invoke } from "../src/cli/invoke.js";
import { makeGitRepository } from "./support/git.js";
import { contractRow, kanshiReport as sharedKanshiReport } from "./support/cli-fixtures.js";
import { rmSync } from "node:fs";

const active = "kei/active-contract" as ContractId;

function board(): ContractKanshiBoard {
  return {
    root: "/repo",
    state: null,
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: [
      contractRow({
        id: active,
        title: "Active contract",
        phase: "bound",
        disposition: "active",
        worktreePath: "/repo/.keiyaku/wt/active-contract",
        workspaceObservation: {
          kind: "clean",
          location: { kind: "worktree", path: "/repo/.keiyaku/wt/active-contract" },
          counts: { staged: 0, unstaged: 0, untracked: 0, submodules: 0 },
          merge: null,
        },
        targetLag: { kind: "counted", behind: 0 },
      }),
    ],
  };
}

test("selectors resolve active worktrees from public status rows", () => {
  const report = board();
  assert.equal(resolveContextualContract(report, "@active-contract", "/repo"), active);
  assert.equal(resolveContextualContract(report, undefined, "/repo/.keiyaku/wt/active-contract"), active);
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

const kanshiReport = (contracts: KanshiReport["contracts"]): KanshiReport =>
  sharedKanshiReport(contracts, { root: "/repo" as WorldRoot });

test("missing Contract selectors refuse uniformly across read and reconcile verbs", async () => {
  const repo = makeGitRepository();
  try {
    for (const verb of ["show", "deliver", "status", "region", "reconcile"] as const) {
      const parsed = parseArgv([verb, "kei/missing"]);
      if (!("command" in parsed)) throw new Error(`expected ${verb} command`);
      const result = await invoke(parsed, { cwd: repo.path, environment: {} });
      assert.ok("kind" in result && result.kind === "refused");
      if ("kind" in result && result.kind === "refused") {
        assert.equal((result.refusal as { kind: string }).kind, "contract-missing");
      }
    }
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
});

test("Kanshi selectors share Contract identity syntax without hiding world availability", () => {
  assert.equal(resolveKanshiContract(kanshiReport({ kind: "present", value: board() }), "@active-contract"), active);
  assert.equal(resolveKanshiContract(kanshiReport({ kind: "present", value: board() }), active), active);
  for (const contracts of [{ kind: "absent" }, { kind: "failed", failure: { message: "broken" } }] as const) {
    assert.throws(() => resolveKanshiContract(kanshiReport(contracts), active), CliUsageError);
  }
});
