import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keis, type Repo } from "../src/index.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import type { ContractState } from "../src/core/facts/types.js";
import { GitPlumbingError, type GitRepository } from "../src/git/process.js";
import { GIT_REF } from "../src/git/repository.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { readDebtHoldersAt } from "../src/settlement/holder.js";
import { settle, type SettlementReport } from "../src/settlement/settle.js";

import { Debts } from "../src/debt/index.js";
import { World } from "../src/world.js";
import {
  cachedRepoAt,
  cachedRepositoryAt,
  makeGitRepository,
  waitForFile,
  withGitShim,
  withSqliteCloseFailure,
} from "./support/git.js";
import { acceptedDelivery } from "./support/library-verbs.js";
import { deferred } from "./support/process.js";

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
  return withGitDecodeChannel(git, (channel) =>
    withGitReadObservation(git, channel, (read) => readDebtHoldersAt(read.snapshot, read.readBlobs)),
  );
}

async function bindOwedDebt(world: ReturnType<typeof repository>, repo: Repo, title: string) {
  const debtId = await debt(world.path, title, "drop");
  const bound = accepted(await Keis.of(repo).bind({ debt: debtId, terms: document(title), gates: [] }));
  writeFileSync(join(world.path, `${debtId.slice("debt/".length)}.txt`), "candidate\n");
  const delivered = acceptedDelivery(await bound.kei.deliver({ includeDirty: true }));
  assert.ok(delivered.issues?.some((issue) => issue.kind === "settlement-failed"));
  return { debtId, state: present(await bound.kei.state()) };
}

async function owedSettlement(title: string) {
  const world = repository();
  const repo = await cachedRepoAt(world.path);
  const { debtId, state } = await bindOwedDebt(world, repo, title);
  await reopen(world.path, debtId);
  return { world, repo, debtId, state };
}

function settleAt(repository: GitRepository, state: ContractState) {
  return withGitDecodeChannel(repository, (channel) => settle({ repository, channel, state }));
}

test("Settlement rereads the holder under the fence before touching Debt authority", async () => {
  const { world, repo, debtId, state } = await owedSettlement("Superseded holder");
  const captured = join(world.path, ".git", "hint-captured");
  const resume = join(world.path, ".git", "hint-resume");
  const pending = withGitShim(
    [
      `if [ "$1 $2 $3 $4" = "rev-parse --verify --quiet ${GIT_REF}" ] && [ ! -f "$CAPTURED" ]; then`,
      '  old=$("$KEIYAKU_REAL_GIT" "$@") || exit $?',
      '  touch "$CAPTURED"',
      '  while [ ! -f "$RESUME" ]; do sleep 0.02; done',
      '  printf "%s\\n" "$old"',
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { CAPTURED: captured, RESUME: resume },
    async (gitPath) => settleAt(await cachedRepositoryAt(world.path, gitPath), state),
  );
  let successor: string;
  try {
    await waitForFile(captured, 10_000);
    const later = accepted(await Keis.of(repo).bind({ debt: debtId, terms: document("New holder"), gates: [] }));
    successor = later.contractId;
    // Debt access would now raise corruption rather than returning an inert report.
    writeFileSync(join(world.path, debtPath(debtId)), "corrupt debt authority\n");
  } finally {
    writeFileSync(resume, "");
  }
  assert.deepEqual(await pending, { actions: [], lags: [] });
  assert.deepEqual(await holders(world), [{ version: 1, debtId, contractId: successor, disposition: "held" }]);
});

test("Settlement proves an unknown release after private state advances even when the caller cancels", async () => {
  const { world, repo, debtId, state } = await owedSettlement("Unknown holder release");
  const git = await cachedRepositoryAt(world.path);
  const held = await acquireSqliteTransactionLock({ path: privateStatePublicationSeatPath(git), mode: "immediate" });
  const arrival = deferred();
  const advanced = join(world.path, ".git", "externally-advanced");
  const cancellation = new AbortController();
  const pending = withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
      '  current=$("$KEIYAKU_REAL_GIT" rev-parse "$STATE_REF")',
      '  tree=$("$KEIYAKU_REAL_GIT" rev-parse "$current^{tree}")',
      '  next=$("$KEIYAKU_REAL_GIT" commit-tree "$tree" -p "$current" -m external)',
      '  "$KEIYAKU_REAL_GIT" update-ref "$STATE_REF" "$next" "$current" || exit $?',
      '  touch "$ADVANCED"',
      "  exec sleep 20",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { ADVANCED: advanced, STATE_REF: GIT_REF },
    async (gitPath) => {
      const repository = {
        ...(await cachedRepositoryAt(world.path, gitPath)),
        signal: cancellation.signal,
        onPrivateStateSeatContention: () => arrival.resolve(),
      };
      let report: SettlementReport | undefined;
      try {
        await withGitDecodeChannel(repository, async (channel) => {
          report = await settle({ repository, channel, state });
        });
      } catch (error) {
        // Caller-channel retirement is independent of the already resolved Settlement.
        if (report === undefined || !(error instanceof GitPlumbingError) || !cancellation.signal.aborted) throw error;
      }
      assert.ok(report);
      return report;
    },
  );
  try {
    try {
      await Promise.race([arrival.promise, pending]);
      assert.equal(await debtState(world.path, debtId), "done");
      assert.deepEqual(await holders(world), [{ version: 1, debtId, contractId: state.id, disposition: "held" }]);
      const before = world.run(["rev-parse", GIT_REF]).trim();
      const tree = world.run(["rev-parse", `${before}^{tree}`]).trim();
      const after = world.run(["commit-tree", tree, "-p", before, "-m", "before seat"]).trim();
      world.run(["update-ref", GIT_REF, after, before]);
    } finally {
      held.close();
    }
    await waitForFile(advanced, 15_000);
  } finally {
    cancellation.abort();
  }
  const report = await pending;
  assert.deepEqual(report.lags, []);
  assert.equal((await holders(world))[0]?.disposition, "released");
  await reopen(world.path, debtId);
  assert.deepEqual(await Keis.of(repo).reconcile({ contract: state.id }), { kind: "contract", contractId: state.id });
  assert.equal(await debtState(world.path, debtId), "open");
});

test("a publication-seat timeout leaves addressed replay lag and world reconciliation continues", async () => {
  const { world, repo, debtId, state } = await owedSettlement("First contention");
  const later = await bindOwedDebt(world, repo, "Later settlement");
  assert.ok(state.id < later.state.id);
  const git = await cachedRepositoryAt(world.path);
  const seat = await acquireSqliteTransactionLock({ path: privateStatePublicationSeatPath(git), mode: "immediate" });
  const keis = Keis.of(repo);
  try {
    const report = await keis.reconcile({});
    assert.ok(report.kind === "world");
    const first = report.contracts?.find((row) => row.contractId === state.id);
    assert.deepEqual(first?.effects, [{ kind: "debt-settled", debtId }]);
    const contention = first?.issues?.[0];
    assert.ok(contention?.kind === "settlement-failed");
    assert.equal(contention.debtId, debtId);
    assert.match(contention.diagnostic, /^debt-holder: Debt holder release requires retry: SQLite lock timed out/u);
    const next = report.contracts?.find((row) => row.contractId === later.state.id)?.issues?.[0];
    assert.ok(next?.kind === "settlement-failed" && next.debtId === later.debtId);
    assert.match(next.diagnostic, /^debt: Debt settlement refused: .*\(drop\)$/u);
    assert.equal((await holders(world)).find((holder) => holder.debtId === debtId)?.disposition, "held");
  } finally {
    seat.close();
  }
  assert.deepEqual(await keis.reconcile({ contract: state.id }), { kind: "contract", contractId: state.id });
  assert.equal((await holders(world)).find((holder) => holder.debtId === debtId)?.disposition, "released");
});

test("a rejected release spends one offer and an already-done Debt can still release its holder", async () => {
  const { world, debtId, state } = await owedSettlement("Rejected holder release");
  const git = await cachedRepositoryAt(world.path);
  const attempts = join(world.path, ".git", "release-attempts");
  const rejected = await withGitShim(
    'if [ "$1 $2" = "update-ref --stdin" ]; then echo attempt >> "$ATTEMPTS"; exit 1; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { ATTEMPTS: attempts },
    async (gitPath) => settleAt(await cachedRepositoryAt(world.path, gitPath), state),
  );
  assert.deepEqual(rejected.actions, [{ kind: "debt", debtId, action: "done" }]);
  assert.match(rejected.lags[0]?.diagnostic ?? "", /requires retry/u);
  assert.equal(readFileSync(attempts, "utf8"), "attempt\n");
  assert.equal((await holders(world))[0]?.disposition, "held");

  const report = await withSqliteCloseFailure(
    (path) => path === privateStatePublicationSeatPath(git) ? new Error("post-release close failed") : undefined,
    () => settleAt(git, state),
  );
  assert.deepEqual(report, {
    actions: [],
    lags: [],
    seatClose: [{ kind: "private-state-seat-close-failed", diagnostic: "cannot release SQLite lock: post-release close failed" }],
  });
  assert.equal((await holders(world))[0]?.disposition, "released");
});
