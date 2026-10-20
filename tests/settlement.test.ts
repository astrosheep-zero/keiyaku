import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contractId } from "../src/core/facts/types.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku } from "../src/index.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { claimDebtHolder, readDebtHoldersAt } from "../src/settlement/holder.js";
import { settle } from "../src/settlement/settle.js";

import { Debts } from "../src/debt/index.js";
import { World } from "../src/world.js";
import {
  cachedRepoAt,
  cachedRepositoryAt,
  makeGitRepository,
  withGitShim,
} from "./support/git.js";
import { acceptedDelivery } from "./support/library-verbs.js";

function repository() {
  const value = makeGitRepository();
  value.run(["config", "user.name", "Test User"]);
  value.run(["config", "user.email", "test@example.com"]);
  value.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  writeFileSync(join(value.path, ".git", "info", "exclude"), ".keiyaku/locks/\n");
  return value;
}

function document(title: string): string {
  return contractMarkdown(title, {
    Context: "Exercise Contract-to-Debt settlement.",
    Objective: "Keep Contract and Debt authority independent.",
    Design: "Project accepted facts through settlement.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: "### Settlement\nThe expected Debt state is visible.",
  });
}

async function debt(path: string, title: string, state: "open" | "done" | "drop" = "open") {
  const result = await Debts.of(await World.at(path)).add({ title, state });
  assert.ok(result.kind === "accepted", "expected result.kind = \"accepted\"");
  return result.value.id;
}

function debtPath(id: string): string {
  return `.keiyaku/debts/${id.slice("debt/".length)}.md`;
}

function replaceDebtState(path: string, id: string, before: string, after: string): void {
  const authority = `${path}/.keiyaku/debts/${id.slice("debt/".length)}.md`;
  const bytes = readFileSync(authority, "utf8");
  writeFileSync(authority, bytes.replace(`state: ${before}\n`, `state: ${after}\n`));
}

async function debtState(path: string, id: string) {
  const detail = await Debts.of(await World.at(path))
    .debt({ id })
    .read();
  assert.ok(detail);
  return detail.debt.state;
}

async function holders(world: ReturnType<typeof repository>) {
  const git = await cachedRepositoryAt(world.path);
  return withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, readDebtHoldersAt));
}

function commitDebts(world: ReturnType<typeof repository>, message = "track Debt authority"): void {
  world.run(["add", ".keiyaku/debts"]);
  world.run(["commit", "--quiet", "-m", message]);
}

test("renaming the product preserves the exact persisted holder key and bytes", () => {
  const legacyId = "task/existing-holder";
  const key = createHash("sha256").update(legacyId).digest("hex");
  const update = claimDebtHolder("debt/existing-holder", contractId("kei/existing-contract"));
  assert.equal(update.path, `settlement/task-holders/${key}.json`);
  assert.equal(
    Buffer.from(update.bytes).toString("utf8"),
    '{"version":1,"taskId":"task/existing-holder","contractId":"kei/existing-contract","disposition":"held"}\n',
  );
});

test("placement keeps post-bind Debt edits and changes only state to done", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const debtId = await debt(world.path, "Edited completion");
  commitDebts(world);
  const bound = accepted(await Keiyaku.with().bind({
    repo,
    debt: debtId,
    markdown: document("Edited completion"),
    workspace: "worktree",
    gates: [],
  }));
  const authority = join(world.path, debtPath(debtId));
  const before = readFileSync(authority, "utf8");
  writeFileSync(authority, `${before}Manual edit after bind.\n`);
  writeFileSync(`${world.path}/edited.txt`, "edited\n");

  const delivered = acceptedDelivery(await bound.value.keiyaku.deliver({ includeDirty: true }));

  const after = readFileSync(authority, "utf8");
  assert.match(after, /Manual edit after bind\./u);
  assert.match(after, /^state: done$/mu);
  assert.match(after, new RegExp(`^createdAt: ${before.match(/createdAt: (.+)$/mu)![1]}$`, "mu"));
  assert.equal(await debtState(world.path, debtId), "done");
  assert.deepEqual(delivered.effects.filter((effect) => effect.kind === "settlement-lag").map((effect) => effect.lag), []);
});

test("reconcile replay of an owed completion is an idempotent no-op the second time", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const debtId = await debt(world.path, "Replay completion", "drop");
  const bound = accepted(await Keiyaku.with().bind({
    repo,
    debt: debtId,
    markdown: document("Replay completion"),
    workspace: "worktree",
    gates: [],
  }));
  writeFileSync(`${world.path}/replay.txt`, "replay\n");
  const delivered = acceptedDelivery(await bound.value.keiyaku.deliver({ includeDirty: true }));

  assert.equal(delivered.effects.filter((effect) => effect.kind === "settlement-lag").map((effect) => effect.lag)[0]?.surface, "debt");
  assert.equal((present(await bound.value.keiyaku.state())).terminal?.kind, "claimed");
  assert.equal(await debtState(world.path, debtId), "drop");
  assert.deepEqual(await holders(world), [
    { version: 1, debtId, contractId: (present(await bound.value.keiyaku.state())).id, disposition: "held" },
  ]);
  replaceDebtState(world.path, debtId, "drop", "open");

  const first = await Keiyaku.with().reconcile({ repo, contract: (present(await bound.value.keiyaku.state())).id });
  assert.deepEqual(first.settlement.actions, [{ kind: "debt", debtId, action: "done" }]);
  assert.deepEqual(first.settlement.lags, []);
  assert.equal(await debtState(world.path, debtId), "done");
  assert.deepEqual(await holders(world), [
    { version: 1, debtId, contractId: (present(await bound.value.keiyaku.state())).id, disposition: "released" },
  ]);

  const second = await Keiyaku.with().reconcile({ repo, contract: (present(await bound.value.keiyaku.state())).id });
  assert.deepEqual(second.settlement.actions, []);
  assert.deepEqual(second.settlement.lags, []);
  assert.equal(await debtState(world.path, debtId), "done");
});

test(
  "settlement reports committed Debt cleanup failure before releasing its holder",
  { concurrency: false },
  async () => {
    const world = repository(),
      repo = await cachedRepoAt(world.path);
    const debtId = await debt(world.path, "Settlement cleanup", "drop");
    const bound = accepted(await Keiyaku.with().bind({
      repo,
      debt: debtId,
      markdown: document("Settlement cleanup"),
      workspace: "worktree",
      gates: [],
    }));
    writeFileSync(join(world.path, "cleanup.txt"), "cleanup\n");
    const delivered = acceptedDelivery(await bound.value.keiyaku.deliver({ includeDirty: true }));
    assert.equal(delivered.effects.filter((effect) => effect.kind === "settlement-lag").map((effect) => effect.lag)[0]?.surface, "debt");
    assert.deepEqual(await holders(world), [
      { version: 1, debtId, contractId: (present(await bound.value.keiyaku.state())).id, disposition: "held" },
    ]);
    replaceDebtState(world.path, debtId, "drop", "open");
    assert.equal(await debtState(world.path, debtId), "open");

    const originalClose = DatabaseSync.prototype.close;
    let fail = true;
    DatabaseSync.prototype.close = function patchedClose(this: DatabaseSync): void {
      try {
        if (
          fail &&
          (this.location() ?? "").includes(
            `${join(".keiyaku", "locks", "debt")}${process.platform === "win32" ? "\\" : "/"}`,
          )
        ) {
          fail = false;
          throw new Error("debt lock release failed");
        }
      } finally {
        originalClose.call(this);
      }
    };
    try {
      const replayed = await Keiyaku.with().reconcile({ repo, contract: (present(await bound.value.keiyaku.state())).id });
      const state = present(await bound.value.keiyaku.state());
      assert.deepEqual(replayed.settlement.actions, [{ kind: "debt", debtId, action: "done" }]);
      assert.deepEqual(replayed.settlement.lags, [
        {
          kind: "settlement-failed",
          surface: "debt",
          contractId: state.id,
          debtId,
          diagnostic: "cannot release SQLite lock: debt lock release failed",
        },
      ]);
      assert.equal(await debtState(world.path, debtId), "done");
      assert.deepEqual(await holders(world), [{ version: 1, debtId, contractId: state.id, disposition: "released" }]);
    } finally {
      DatabaseSync.prototype.close = originalClose;
    }
  },
);

test("Settlement exact-read-backs an unknown DebtHolder release after external state advancement", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const debtId = await debt(world.path, "Unknown holder release", "drop");
  const bound = accepted(await Keiyaku.with().bind({
    repo,
    debt: debtId,
    markdown: document("Unknown holder release"),
    workspace: "worktree",
    gates: [],
  }));
  writeFileSync(`${world.path}/unknown-holder.txt`, "candidate\n");
  const delivered = acceptedDelivery(await bound.value.keiyaku.deliver({ includeDirty: true }));
  assert.equal(delivered.effects.filter((effect) => effect.kind === "settlement-lag").map((effect) => effect.lag)[0]?.surface, "debt");
  assert.deepEqual(await holders(world), [
    { version: 1, debtId, contractId: (present(await bound.value.keiyaku.state())).id, disposition: "held" },
  ]);
  replaceDebtState(world.path, debtId, "drop", "open");
  assert.equal(await debtState(world.path, debtId), "open");
  const state = present(await bound.value.keiyaku.state());

  const git = await cachedRepositoryAt(world.path);
  const held = await acquireSqliteTransactionLock({ path: privateStatePublicationSeatPath(git), mode: "immediate" });
  let resolveArrival: () => void = () => undefined;
  const arrival = new Promise<void>((resolve) => {
    resolveArrival = resolve;
  });
  const pending = withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
      '  current=$("$KEIYAKU_REAL_GIT" rev-parse refs/heads/keiyaku-state)',
      '  tree=$("$KEIYAKU_REAL_GIT" rev-parse "$current^{tree}")',
      '  next=$("$KEIYAKU_REAL_GIT" commit-tree "$tree" -p "$current" -m external)',
      '  "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$next" "$current" || exit $?',
      "  kill -TERM $$",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      const git = {
        ...(await cachedRepositoryAt(world.path, gitPath)),
        onPrivateStateSeatContention: resolveArrival,
      };
      return await withGitDecodeChannel(git, async (channel) =>
        settle({ repository: git, channel, state, effects: [] }),
      );
    },
  );
  await arrival;
  assert.equal(await debtState(world.path, debtId), "done");
  assert.deepEqual(await holders(world), [{ version: 1, debtId, contractId: state.id, disposition: "held" }]);
  held.close();
  const report = await pending;

  assert.deepEqual(report.actions, [{ kind: "debt", debtId, action: "done" }]);
  assert.deepEqual(report.lags, []);
  assert.equal(await debtState(world.path, debtId), "done");
  assert.deepEqual(await holders(world), [{ version: 1, debtId, contractId: state.id, disposition: "released" }]);
});
