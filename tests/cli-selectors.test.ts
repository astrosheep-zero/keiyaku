import assert from "node:assert/strict";
import test from "node:test";
import type { ContractBoard, ContractId } from "../src/index.js";
import type { ContractKanshiBoard } from "../src/kanshi/index.js";
import type { WorldRoot } from "../src/world.js";
import type { KanshiReport } from "../src/kanshi/index.js";
import { resolveContextualContract, resolveKanshiContract } from "../src/cli/selectors.js";
import { CliUsageError } from "../src/cli/parse.js";
import { makeGitRepository } from "./support/git.js";
import { contractRow, kanshiReport as sharedKanshiReport } from "./support/cli-fixtures.js";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";

/**
 * Run the real CLI boundary for one invocation. The refusal this suite pins is process output,
 * so it is observed across a real process instead of by swapping the in-process stdout that the
 * test runner also owns.
 */
function runCliJson(cwd: string, argv: readonly string[]) {
  const environment = { ...process.env };
  delete environment[AKUMA_REQUESTS_ENV];
  const result = spawnSync(
    process.execPath,
    [
      ...(import.meta.url.endsWith(".js") ? [] : ["--import", "tsx"]),
      fileURLToPath(
        new URL(import.meta.url.endsWith(".js") ? "../src/cli/index.js" : "../src/cli/index.ts", import.meta.url),
      ),
      "-C",
      cwd,
      ...argv,
      "--json",
    ],
    { encoding: "utf8", env: environment },
  );
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

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

test("missing Contract selectors refuse uniformly across read and reconcile verbs", () => {
  const repo = makeGitRepository();
  try {
    const refusalKind = (value: Readonly<{ kind: string; refusal?: Readonly<{ kind: string }> }>): string =>
      value.kind === "refused" ? (value.refusal?.kind ?? "missing-envelope") : value.kind;
    for (const argv of [
      ["deliver", "kei/missing"],
      ["status", "kei/missing"],
      ["region", "kei/missing"],
      ["reconcile", "kei/missing"],
    ] as const) {
      const result = runCliJson(repo.path, argv);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(refusalKind(JSON.parse(result.stdout)), "contract-missing");
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
