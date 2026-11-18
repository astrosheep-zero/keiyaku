import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Debts, Keis, Repo, Settings, World } from "../src/index.js";
import type { ReconciliationLag } from "../src/library/outcome.js";
import { accepted, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";
import {
  reconcileLagIsFailure,
  reconcileLagScope,
  type ReconcileLagScope,
} from "../src/library/reconcile.js";

test("reconcile lag classification covers scope and failure for every current lag kind", () => {
  type Lag = ReconciliationLag;
  const fixtures: readonly [Lag, ReconcileLagScope, boolean][] = [
    [{ kind: "worktree-retained", path: "/tmp/worktree" }, "none", false],
    [
      {
        kind: "worktree-follow-retained",
        path: "/tmp/worktree",
        reason: "head-moved",
      },
      "continuation",
      false,
    ],
    [{ kind: "unsealed-bytes", path: "/tmp/worktree" }, "none", false],
    [{ kind: "target-checkout-retained", path: "/tmp/target", target: "refs/heads/main", diagnostic: "retained" }, "placement", true],
    [
      {
        kind: "worktree-hook-failed",
        phase: "create",
        path: "/tmp/worktree",
        name: "prepare",
        diagnostic: "failed",
      },
      "reconciliation",
      true,
    ],
    [{ kind: "reconcile-failed", diagnostic: "failed" }, "reconciliation", true],
    [
      {
        kind: "contract-file-failed",
        path: ".keiyaku/KEIYAKU.md",
        diagnostic: "failed",
      },
      "reconciliation",
      true,
    ],
  ];

  assert.deepEqual(
    fixtures.map(([lag]) => [lag.kind, reconcileLagScope(lag), reconcileLagIsFailure(lag)]),
    fixtures.map(([lag, scope, failure]) => [lag.kind, scope, failure]),
  );
});

test("world reconciliation settles each Contract before its own removal, even when another cleanup lags", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const debts = Debts.of(await World.at(repository.path));
  const firstDebt = await debts.add({ title: "First reconcile debt" });
  const secondDebt = await debts.add({ title: "Second reconcile debt" });
  assert.ok(firstDebt.kind === "accepted" && secondDebt.kind === "accepted");
  const debtIds = [firstDebt.id, secondDebt.id];
  const debtPaths = debtIds.map((id) => join(repository.path, ".keiyaku", "debts", `${id.slice(5)}.md`));
  const marker = join(repository.path, ".git", "world-ready");
  const log = join(repository.path, ".git", "world-cleanup");
  const failOnce = join(repository.path, ".git", "world-fail-first");
  const members = Keis.of(repo);
  const unchanged = accepted(await members.bind({ terms: document(), gates: ["reviewed"] }));
  const claimed = [];
  const destroy = {
    name: "witness settlement",
    timeoutMs: 10_000,
    argv: [
      process.execPath,
      "-e",
      [
        'const fs = require("node:fs");',
        `if (!fs.existsSync(${JSON.stringify(marker)})) process.exit(7);`,
        `const paths = ${JSON.stringify(debtPaths)};`,
        'const done = paths.map((path) => /^state: done$/m.test(fs.readFileSync(path, "utf8")));',
        `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([process.cwd(), done]) + "\\n");`,
        `if (!fs.existsSync(${JSON.stringify(failOnce)})) { fs.writeFileSync(${JSON.stringify(failOnce)}, "failed"); process.exit(8); }`,
      ].join(" "),
    ],
  };
  writeFileSync(
    join(repository.path, ".keiyaku", "settings.json"),
    JSON.stringify({ worktree: { destroy: [destroy] } }),
  );
  const settings = await Settings.load({ cwd: repository.path, home: join(repository.path, ".git", "isolated-home") });
  const contracts = Keis.of(repo, { settings });
  for (const [index, debt] of debtIds.entries()) {
    const bound = accepted(await contracts.bind({ terms: document(), debt, gates: [], target: null }));
    const worktreePath = bound.worktreePath;
    assert.ok(worktreePath);
    const file = debtPaths[index]!;
    renameSync(file, `${file}.pending`);
    try {
      commitCandidate(repository, worktreePath);
      const delivery = accepted(await bound.kei.deliver());
      assert.equal(delivery.placement?.kind, "placed");
      assert.equal(existsSync(worktreePath), true);
    } finally {
      renameSync(`${file}.pending`, file);
    }
    claimed.push({ contractId: bound.contractId, worktreePath });
  }
  writeFileSync(marker, "ready\n");
  const report = await contracts.reconcile({});
  assert.equal(report.kind, "world");
  const rows = report.contracts ?? [];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.contractId !== unchanged.contractId));
  const [first, second] = rows;
  assert.ok(first && second);
  const firstIndex = claimed.findIndex((bound) => bound.contractId === first.contractId);
  const secondIndex = claimed.findIndex((bound) => bound.contractId === second.contractId);
  assert.ok(firstIndex >= 0 && secondIndex >= 0 && firstIndex !== secondIndex);
  const firstPath = claimed[firstIndex]!.worktreePath;
  const secondPath = claimed[secondIndex]!.worktreePath;
  const witnesses = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  assert.deepEqual(witnesses, [
    [firstPath, debtIds.map((_, index) => index === firstIndex)],
    [secondPath, [true, true]],
  ]);
  assert.deepEqual(first.effects, [{ kind: "debt-settled", debtId: debtIds[firstIndex] }]);
  assert.equal(first.issues?.[0]?.kind, "worktree-hook-failed");
  assert.equal(second.issues, undefined);
  assert.deepEqual(
    second.effects?.filter((effect) => effect.kind !== "ref"),
    [
      { kind: "debt-settled", debtId: debtIds[secondIndex] },
      { kind: "worktree-removed", path: secondPath },
    ],
  );
  assert.equal(existsSync(firstPath), true);
  assert.equal(existsSync(secondPath), false);

  const retried = await contracts.reconcile({ contract: first.contractId });
  assert.equal(retried.kind, "contract");
  assert.equal(retried.issues, undefined);
  assert.deepEqual(
    retried.effects?.filter((effect) => effect.kind !== "ref"),
    [{ kind: "worktree-removed", path: firstPath }],
  );
  assert.deepEqual(await contracts.reconcile({}), { kind: "world" });
});
