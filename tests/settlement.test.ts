import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contractId } from "../src/core/facts/types.js";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AuthorityCorruptionError, KeiyakuError, Keis, type Repo } from "../src/index.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { acquireSqliteTransactionLock, SqliteTransactionLockError } from "../src/coordination/sqlite-transaction-lock.js";
import type { ContractState } from "../src/core/facts/types.js";
import { GitPlumbingError, type GitRepository } from "../src/git/process.js";
import { gitObjectId } from "../src/git/identity.js";
import { GIT_REF, readRef, updateGitTree, writeBlob, writeStateCommit } from "../src/git/repository.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { admitWithDebtHolderFence, claimDebtHolder, readDebtHoldersAt } from "../src/settlement/holder.js";
import { settlementFencePath } from "../src/settlement/fence.js";
import { settle, type SettlementReport } from "../src/settlement/settle.js";

import { Debts } from "../src/debt/index.js";
import type { DebtId } from "../src/debt/identity.js";
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
    terms: document("Edited completion"),
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

test("an owed completion survives missing Debt and is inert after release", async () => {
  const world = repository();
  const repo = await cachedRepoAt(world.path);
  const keis = Keis.of(repo);
  const { debtId, state } = await bindOwedDebt(world, repo, "Replay completion");
  const authority = join(world.path, debtPath(debtId));
  const saved = readFileSync(authority);
  unlinkSync(authority);
  const missing = await keis.reconcile({ contract: state.id });
  assert.ok(missing.kind === "contract" && missing.issues?.[0]?.kind === "settlement-failed");
  assert.match(missing.issues[0].diagnostic, /^debt: .*missing/u);
  assert.equal((await holders(world))[0]?.disposition, "held");
  writeFileSync(authority, saved);
  await reopen(world.path, debtId);

  const first = await keis.reconcile({ contract: state.id });
  assert.ok(first.kind === "contract");
  assert.deepEqual(first.effects, [{ kind: "debt-settled", debtId }]);
  assert.equal(await debtState(world.path, debtId), "done");
  assert.deepEqual(await keis.reconcile({ contract: state.id }), { kind: "contract", contractId: state.id });
});

test("committed Debt cleanup failure survives holder release", async () => {
  const { world, repo, debtId, state } = await owedSettlement("Settlement cleanup");
  const debtLock = `${join(".keiyaku", "locks", "debt")}${process.platform === "win32" ? "\\" : "/"}`;
  const report = await withSqliteCloseFailure(
    (path) => path?.includes(debtLock) ? new Error("debt lock release failed") : undefined,
    () => Keis.of(repo).reconcile({ contract: state.id }),
  );
  assert.ok(report.kind === "contract" && report.issues?.[0]?.kind === "settlement-failed");
  assert.match(report.issues[0].diagnostic, /^debt: .*cannot release SQLite lock: debt lock release failed$/u);
  assert.deepEqual(report.effects, [{ kind: "debt-settled", debtId }]);
  assert.equal((await holders(world))[0]?.disposition, "released");
});

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

async function corruptHolderCommit(world: ReturnType<typeof repository>, git: GitRepository, debtId: DebtId, state: ContractState) {
  const parent = gitObjectId(world.run(["rev-parse", GIT_REF]).trim());
  const base = gitObjectId(world.run(["rev-parse", `${parent}^{tree}`]).trim());
  const { path } = claimDebtHolder(debtId, state.id);
  const oid = await writeBlob(git, "{\n");
  const tree = await updateGitTree(git, base, new Map([[path, { oid }]]));
  return writeStateCommit({ repository: git, tree, parent });
}

for (const readback of ["failed", "corrupt"] as const) {
  test(`finite ${readback} recovery retains Debt completion and the held token`, async () => {
    const { world, repo, debtId, state } = await owedSettlement("Release readback");
    const git = await cachedRepositoryAt(world.path);
    const before = await readRef(git, GIT_REF);
    const { path } = claimDebtHolder(debtId, state.id);
    const heldBlob = world.run(["rev-parse", `${before}:${path}`]).trim();
    const corrupt = readback === "corrupt" ? await corruptHolderCommit(world, git, debtId, state) : "";
    const attempted = join(world.path, ".git", "release-attempted");
    const seat = privateStatePublicationSeatPath(git);
    const fence = settlementFencePath(git, debtId);
    const run = () => withGitShim(
      [
        'if [ "$1 $2" = "update-ref --stdin" ]; then',
        '  IFS= read -r start && IFS= read -r option && read -r verb ref offer predecessor || exit 81',
        '  [ "$verb $ref" = "update $STATE_REF" ] && [ -n "$offer" ] || exit 81',
        '  echo "$offer" >> "$ATTEMPTED"; kill -TERM $$',
        'fi',
        `if [ "$1 $2 $3 $4" = "rev-parse --verify --quiet ${GIT_REF}" ] && [ -n "$CORRUPT" ] && [ -f "$ATTEMPTED" ]; then`,
        '  printf "%s\\n" "$CORRUPT"; exit 0',
        'fi',
        'if [ "$1 $2 $3" = "cat-file blob $HELD_BLOB" ] && [ -f "$ATTEMPTED" ]; then',
        '  read -r offer < "$ATTEMPTED"',
        '  "$KEIYAKU_REAL_GIT" cat-file blob "$offer:$HOLDER_PATH" || exit 82',
        '  echo "finite holder read failed" >&2; exit 73',
        'fi',
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { ATTEMPTED: attempted, CORRUPT: corrupt, HELD_BLOB: heldBlob, HOLDER_PATH: path, STATE_REF: GIT_REF },
      async (gitPath) => {
        const addressed = Keis.of(await cachedRepoAt(world.path, gitPath)).reconcile({ contract: state.id });
        if (readback === "corrupt") {
          await assert.rejects(addressed, (error: unknown) => {
            assert.ok(error instanceof KeiyakuError && error.category === "authority-corruption");
            assert.ok(error.cause instanceof AuthorityCorruptionError && error.cause.cause instanceof SyntaxError);
            assert.ok(error.outcome?.kind === "contract");
            assert.deepEqual(error.outcome.effects, [{ kind: "debt-settled", debtId }]);
            assert.deepEqual(error.outcome.issues, [
              { kind: "diagnostic", severity: "required", diagnostic: "cannot release SQLite lock: seat close" },
              { kind: "settlement-failed", severity: "required", debtId, diagnostic: "debt-holder: cannot release SQLite lock: Debt fence close" },
            ]);
            return true;
          });
          return;
        }
        const report = await addressed;
        assert.ok(report.kind === "contract" && report.issues?.[0]?.kind === "settlement-failed");
        assert.deepEqual(report.effects, [{ kind: "debt-settled", debtId }]);
        assert.equal(report.issues[0].debtId, debtId);
        assert.equal(report.issues[0].severity, "required");
        assert.match(report.issues[0].diagnostic, /^debt-holder: .*finite holder read failed/u);
        assert.match(report.issues[0].diagnostic, /exit 73/u);
      },
    );
    if (readback === "corrupt") {
      await withSqliteCloseFailure((path): Error | undefined => {
        if (!existsSync(attempted)) return undefined;
        if (path === seat) return new Error("seat close");
        if (path === fence) return new Error("Debt fence close");
        return undefined;
      }, run);
    } else await run();

    const offer = gitObjectId(readFileSync(attempted, "utf8").trim());
    assert.match(world.run(["cat-file", "blob", `${offer}:${path}`]), /"disposition":"released"/u);
    assert.equal(await readRef(git, GIT_REF), before);
    assert.equal((await holders(world))[0]?.disposition, "held");
    await reopen(world.path, debtId);
    const retry = await Keis.of(repo).reconcile({ contract: state.id });
    assert.ok(retry.kind === "contract");
    assert.deepEqual(retry.effects, [{ kind: "debt-settled", debtId }]);
    assert.equal((await holders(world))[0]?.disposition, "released");
  });
}

test("Debt holder admission preserves callback and actual fence close failures", async () => {
  const git = await cachedRepositoryAt(repository().path);
  const debtId = "debt/failed-admission";
  const lock = settlementFencePath(git, debtId);
  const primary = new AuthorityCorruptionError("cannot decode admission holder");
  const closeFailure = new Error("independent Debt fence close failure");
  await withSqliteCloseFailure((path) => path === lock ? closeFailure : undefined, () =>
    assert.rejects(
      admitWithDebtHolderFence(git, debtId, () => { throw primary; }),
      (error: unknown) => {
        assert.ok(error instanceof KeiyakuError && error.category === primary.category);
        assert.equal(error.cause, primary);
        assert.ok("retirement" in error && error.retirement instanceof SqliteTransactionLockError);
        assert.equal(error.retirement.cause, closeFailure);
        return true;
      },
    ),
  );
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
