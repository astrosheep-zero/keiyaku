import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contractId } from "../src/core/facts/types.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keis } from "../src/index.js";
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
  const debts = Debts.of(await World.at(path));
  const result = await debts.add({ title });
  assert.ok(result.kind === "accepted", "expected result.kind = \"accepted\"");
  if (state !== "open") assert.equal((await debts.debt({ id: result.id }).update({ state })).kind, "accepted");
  return result.id;
}

function debtPath(id: string): string {
  return `.keiyaku/debts/${id.slice("debt/".length)}.md`;
}

async function reopen(path: string, id: string): Promise<void> {
  const result = await Debts.of(await World.at(path)).debt({ id }).update({ state: "open" });
  assert.equal(result.kind, "accepted");
}

async function debtState(path: string, id: string) {
  const detail = await Debts.of(await World.at(path))
    .debt({ id })
    .read();
  assert.equal(detail.kind, "present");
  if (detail.kind !== "present") throw new Error("missing Debt detail");
  return detail.state;
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
  const bound = accepted(await Keis.of(repo).bind({
    debt: debtId,
    markdown: document("Edited completion"),
    gates: [],
  }));
  const authority = join(world.path, debtPath(debtId));
  const before = readFileSync(authority, "utf8");
  writeFileSync(authority, `${before}Manual edit after bind.\n`);
  writeFileSync(`${world.path}/edited.txt`, "edited\n");

  const delivered = acceptedDelivery(await bound.kei.deliver({ includeDirty: true }));

  const after = readFileSync(authority, "utf8");
  assert.match(after, /Manual edit after bind\./u);
  assert.match(after, /^state: done$/mu);
  assert.match(after, new RegExp(`^createdAt: ${before.match(/createdAt: (.+)$/mu)![1]}$`, "mu"));
  assert.equal(await debtState(world.path, debtId), "done");
  assert.deepEqual((delivered.issues ?? []).filter((issue) => issue.kind === "settlement-failed"), []);
});

test("reconcile replay of an owed completion is an idempotent no-op the second time", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const debtId = await debt(world.path, "Replay completion", "drop");
  const bound = accepted(await Keis.of(repo).bind({
    debt: debtId,
    markdown: document("Replay completion"),
    gates: [],
  }));
  writeFileSync(`${world.path}/replay.txt`, "replay\n");
  const delivered = acceptedDelivery(await bound.kei.deliver({ includeDirty: true }));

  const owed = (delivered.issues ?? []).find((issue) => issue.kind === "settlement-failed");
  assert.equal(owed?.kind, "settlement-failed");
  if (owed?.kind === "settlement-failed") assert.match(owed.diagnostic, /^debt: /u);
  assert.equal((present(await bound.kei.state())).terminal?.kind, "claimed");
  assert.equal(await debtState(world.path, debtId), "drop");
  assert.deepEqual(await holders(world), [
    { version: 1, debtId, contractId: (present(await bound.kei.state())).id, disposition: "held" },
  ]);
  await reopen(world.path, debtId);

  const first = await Keis.of(repo).reconcile({ contract: (present(await bound.kei.state())).id });
  assert.ok(first.kind === "contract");
  assert.equal(first.issues, undefined);
  assert.deepEqual(first.effects, [{ kind: "debt-settled", debtId }]);
  assert.equal(await debtState(world.path, debtId), "done");
  assert.deepEqual(await holders(world), [
    { version: 1, debtId, contractId: (present(await bound.kei.state())).id, disposition: "released" },
  ]);

  const second = await Keis.of(repo).reconcile({ contract: (present(await bound.kei.state())).id });
  assert.ok(second.kind === "contract");
  assert.equal(second.issues, undefined);
  assert.equal(second.effects, undefined);
  assert.equal(await debtState(world.path, debtId), "done");

  // The released holder stays consumed: an explicit public reopen is not reclosed by replay.
  await reopen(world.path, debtId);
  const third = await Keis.of(repo).reconcile({ contract: (present(await bound.kei.state())).id });
  assert.ok(third.kind === "contract");
  assert.equal(third.issues, undefined);
  assert.equal(third.effects, undefined);
  assert.equal(await debtState(world.path, debtId), "open");
  assert.equal((present(await bound.kei.state())).terminal?.kind, "claimed");
  assert.deepEqual(await holders(world), [
    { version: 1, debtId, contractId: (present(await bound.kei.state())).id, disposition: "released" },
  ]);
});

test(
  "settlement reports committed Debt cleanup failure before releasing its holder",
  { concurrency: false },
  async () => {
    const world = repository(),
      repo = await cachedRepoAt(world.path);
    const debtId = await debt(world.path, "Settlement cleanup", "drop");
    const bound = accepted(await Keis.of(repo).bind({
      debt: debtId,
      markdown: document("Settlement cleanup"),
      gates: [],
    }));
    writeFileSync(join(world.path, "cleanup.txt"), "cleanup\n");
    const delivered = acceptedDelivery(await bound.kei.deliver({ includeDirty: true }));
    const owed = (delivered.issues ?? []).find((issue) => issue.kind === "settlement-failed");
    assert.equal(owed?.kind, "settlement-failed");
    assert.deepEqual(await holders(world), [
      { version: 1, debtId, contractId: (present(await bound.kei.state())).id, disposition: "held" },
    ]);
    await reopen(world.path, debtId);
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
      const replayed = await Keis.of(repo).reconcile({ contract: (present(await bound.kei.state())).id });
      assert.ok(replayed.kind === "contract");
      const state = present(await bound.kei.state());
      assert.equal(replayed.issues?.length, 1);
      const failure = replayed.issues?.[0];
      assert.equal(failure?.kind, "settlement-failed");
      if (failure?.kind === "settlement-failed") {
        assert.equal(failure.debtId, debtId);
        assert.match(failure.diagnostic, /^debt: .*cannot release SQLite lock: debt lock release failed$/u);
      }
      assert.deepEqual(replayed.effects, [{ kind: "debt-settled", debtId }]);
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
  const bound = accepted(await Keis.of(repo).bind({
    debt: debtId,
    markdown: document("Unknown holder release"),
    gates: [],
  }));
  writeFileSync(`${world.path}/unknown-holder.txt`, "candidate\n");
  const delivered = acceptedDelivery(await bound.kei.deliver({ includeDirty: true }));
  const owed = (delivered.issues ?? []).find((issue) => issue.kind === "settlement-failed");
  assert.equal(owed?.kind, "settlement-failed");
  assert.deepEqual(await holders(world), [
    { version: 1, debtId, contractId: (present(await bound.kei.state())).id, disposition: "held" },
  ]);
  await reopen(world.path, debtId);
  assert.equal(await debtState(world.path, debtId), "open");
  const state = present(await bound.kei.state());

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
