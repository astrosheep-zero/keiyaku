import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nuke, World, type NukeResult } from "../src/index.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { driveAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import { HeldAkumaLeash, initializeHeart, readHeart, type Soul } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { main } from "../src/cli/main.js";
import { nukeExitCode, renderNukeText } from "../src/cli/render/nuke.js";
import { nukeGit } from "../src/git/nuke.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { commonGitDirectory, repositoryAt } from "../src/git/repository.js";
import { worktreePath } from "../src/git/workspace.js";
import { appointManagedWorktrees, placeRegisterPath, readPlaceRegister } from "../src/workspace-place.js";
import { contractId } from "../src/core/facts/types.js";
import { Tasks } from "../src/task/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";
import { settlementProbe, waitForCondition } from "./support/process.js";
import { captureOutput, cliJson } from "./support/cli-fixtures.js";

const CLAUDE_EXECUTION = { name: "claude", kind: "claude-agent-sdk" } as const;

async function testWorld() {
  return await World.at(mkdtempSync(join(tmpdir(), "keiyaku-v4-nuke-")));
}

function refPresent(raw: ReturnType<typeof makeGitRepository>, ref: string): boolean {
  try {
    raw.run(["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function placeLockPath(repository: Awaited<ReturnType<typeof repositoryAt>>): string {
  return join(commonGitDirectory(repository), "keiyaku", "locks", "places.sqlite");
}

function gitNukeShim(extra = ""): string {
  return ['printf "%s\\n" "$*" >> "$KEIYAKU_CALLS"', extra, 'exec "$KEIYAKU_REAL_GIT" "$@"'].join("\n");
}

async function gitNukeFixture() {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(raw.path);
  const repository = await repositoryAt(world);
  const managed = contractId("kei/nuke-managed");
  await appointManagedWorktrees(repository, [managed]);
  const place = (await readPlaceRegister(repository)).byContract.get(managed)!;
  const managedPath = worktreePath(repository, place.place);
  raw.run(["worktree", "add", "--detach", managedPath, "HEAD"]);
  raw.run(["branch", "business-branch"]);
  raw.run(["update-ref", "refs/keiyaku/delivery/nuke-managed", "HEAD"]);
  raw.run(["update-ref", "refs/keiyaku/candidate/nuke-managed", "HEAD"]);
  raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  const foreign = `${raw.path}-foreign`;
  raw.run(["worktree", "add", "--detach", foreign, "HEAD"]);
  return {
    raw,
    world,
    managedPath,
    foreign,
  };
}

async function runningAkuma(world: Awaited<ReturnType<typeof testWorld>>) {
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "3456cdef" });
  await initializeHeart(allocated.paths);
  let aborted = false;
  const { promise: completion, resolve: settle } = promiseBarrier<{ kind: "failed"; diagnostic: string }>();
  const provider: ProviderAdapter = {
    admitOptions(options) {
      return { kind: "admitted", options };
    },
    start(input) {
      return createProviderAttempt(input.signal, async (custody) => {
        const stop = async () => {
          aborted = true;
          settle({ kind: "failed", diagnostic: "stopped" });
        };
        const session = {
          admission: { fence: "nuke-fixture-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              while (!aborted) {
                yield { type: "note" as const, text: "working" };
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            },
          },
          completion,
          abort: stop,
          forceDispose: stop,
        };
        custody.own({
          closed: completion.then(() => undefined),
          abort: stop,
          forceDispose: stop,
        });
        return session;
      });
    },
  };
  const launch: BodyLaunch = {
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype: "claude",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
      cwd: world,
      allowed: ALLOWED_ACTIONS,
    },
    initialBody: "keep working",
  };
  const body = driveAkumaBody(launch, provider, { now: () => "2026-08-19T00:00:00.000Z" });
  await waitForCondition(
    "the first Body recorded in Heart",
    async () => (await readHeart(allocated.paths)).latestBody !== null,
    { terminalState: settlementProbe(body, () => "the driving Body pump settled without a recorded Body") },
  );
  return { allocated, body };
}

test("confirmed nuke stops live writers and removes owned state while preserving boundaries", async () => {
  const fixture = await gitNukeFixture();
  try {
    const { raw, world, managedPath, foreign } = fixture;
    const tasks = Tasks.of(world);
    assert.equal((await tasks.add({ title: "Remove me" })).kind, "accepted");
    const namespace = join(world, ".keiyaku", "namespace", "current");
    mkdirSync(join(world, ".keiyaku", "namespace"), { recursive: true });
    writeFileSync(namespace, "retained\n");
    const running = await runningAkuma(world);
    await moveAlias({ world, alias: parseAkumaAlias("@running"), akuId: running.allocated.id });
    const settings = join(world, ".keiyaku", "settings.json");
    const unknown = join(world, ".keiyaku", "unknown.bin");
    const unknownRun = join(world, ".keiyaku", "akuma", "run", "foreign-12345678");
    const orphanRun = join(world, ".keiyaku", "akuma", "run", "foreign-87654321");
    const foreignByte = join(foreign, "foreign.txt");
    const recognizedUnknown = join(running.allocated.paths.directory, "unknown.bin");
    const recognizedDir = join(running.allocated.paths.directory, "unknown-dir");
    const recognizedLink = join(running.allocated.paths.directory, "unknown-link");
    writeFileSync(recognizedUnknown, "preserve recognized unknown\n");
    mkdirSync(recognizedDir);
    writeFileSync(join(recognizedDir, "inside.bin"), "inside\n");
    symlinkSync(recognizedUnknown, recognizedLink);
    writeFileSync(settings, '{"project":true}\n');
    writeFileSync(unknown, "unknown\n");
    mkdirSync(unknownRun, { recursive: true });
    writeFileSync(join(unknownRun, "bytes.bin"), "foreign runtime\n");
    mkdirSync(orphanRun, { recursive: true });
    writeFileSync(join(orphanRun, "leash.db"), "orphan leash\n");
    writeFileSync(foreignByte, "retain\n");

    assert.deepEqual(await nuke({ world, confirm: world }), {
      operation: "nuke",
      kind: "accepted",
      world,
      effects: [],
      pending: [],
      value: { removed: { refs: 3, worktrees: 1, tasks: 1 } },
    });
    await running.body;
    assert.equal(existsSync(running.allocated.paths.heart), false);
    assert.equal(existsSync(running.allocated.paths.leash), false);
    assert.equal(existsSync(join(running.allocated.paths.directory, "requests")), false);
    assert.equal(existsSync(recognizedUnknown), true);
    assert.equal(readFileSync(recognizedUnknown, "utf8"), "preserve recognized unknown\n");
    assert.equal(readFileSync(join(recognizedDir, "inside.bin"), "utf8"), "inside\n");
    assert.equal(readFileSync(recognizedLink, "utf8"), "preserve recognized unknown\n");
    assert.equal(existsSync(join(world, ".keiyaku", "akuma", "alias.json")), false);
    assert.equal(existsSync(join(world, ".keiyaku", "locks", "akuma-alias.sqlite")), true);
    assert.equal(existsSync(join(world, ".keiyaku", "tasks", "remove-me.md")), false);
    assert.equal(existsSync(managedPath), false);
    assert.throws(() => raw.run(["show-ref", "--verify", "--quiet", "refs/heads/keiyaku-state"]));
    assert.equal(raw.run(["show-ref", "--verify", "--quiet", "refs/heads/business-branch"]), "");
    assert.equal(existsSync(placeLockPath(await repositoryAt(world))), true);
    assert.equal(readFileSync(settings, "utf8"), '{"project":true}\n');
    assert.equal(readFileSync(namespace, "utf8"), "retained\n");
    assert.equal(readFileSync(unknown, "utf8"), "unknown\n");
    assert.equal(readFileSync(join(unknownRun, "bytes.bin"), "utf8"), "foreign runtime\n");
    assert.equal(readFileSync(join(orphanRun, "leash.db"), "utf8"), "orphan leash\n");
    assert.equal(readFileSync(foreignByte, "utf8"), "retain\n");
    assert.deepEqual(await nuke({ world, confirm: world }), {
      operation: "nuke",
      kind: "accepted",
      world,
      effects: [],
      pending: [],
      value: { removed: { refs: 0, worktrees: 0, tasks: 0 } },
    });
  } finally {
    rmSync(fixture.raw.path, { recursive: true, force: true });
    rmSync(fixture.foreign, { recursive: true, force: true });
  }
});

test("confirmed nuke removes known stopped-entry artifacts and empty run roots", async () => {
  const world = await testWorld();
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "abcd1234" });
    await initializeHeart(allocated.paths);
    writeFileSync(allocated.paths.log, "stdio\n");
    writeFileSync(`${allocated.paths.heart}-wal`, "wal\n");
    writeFileSync(`${allocated.paths.heart}-shm`, "shm\n");
    mkdirSync(join(allocated.paths.requests, "1"), { recursive: true });
    writeFileSync(join(allocated.paths.requests, "1", "41111111-1111-4111-8111-111111111111.request.json"), "{}\n");
    writeFileSync(join(allocated.paths.requests, "1", "41111111-1111-4111-8111-111111111111.receipt.json"), "{}\n");
    assert.deepEqual(await nuke({ world, confirm: world }), {
      operation: "nuke",
      kind: "accepted",
      world,
      effects: [],
      pending: [],
      value: { removed: { refs: 0, worktrees: 0, tasks: 0 } },
    });
    assert.equal(existsSync(allocated.paths.heart), false);
    assert.equal(existsSync(allocated.paths.leash), false);
    assert.equal(existsSync(allocated.paths.log), false);
    assert.equal(existsSync(`${allocated.paths.heart}-wal`), false);
    assert.equal(existsSync(`${allocated.paths.heart}-shm`), false);
    assert.equal(existsSync(allocated.paths.requests), false);
    assert.equal(existsSync(allocated.paths.directory), false);
    assert.equal(existsSync(join(world, ".keiyaku", "akuma", "run")), false);
    assert.deepEqual(await nuke({ world, confirm: world }), {
      operation: "nuke",
      kind: "accepted",
      world,
      effects: [],
      pending: [],
      value: { removed: { refs: 0, worktrees: 0, tasks: 0 } },
    });
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

test("confirmed nuke cleans a legacy Heart schema and continues independent owners", async () => {
  const fixture = await gitNukeFixture();
  try {
    const { raw, world, managedPath, foreign } = fixture;
    const tasks = Tasks.of(world);
    assert.equal((await tasks.add({ title: "Remove me" })).kind, "accepted");
    const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "14000000" });
    const heart = new DatabaseSync(allocated.paths.heart);
    heart.exec(
      "CREATE TABLE akuma_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO akuma_schema VALUES (1, 14)",
    );
    heart.close();
    const leash = new DatabaseSync(allocated.paths.leash);
    leash.exec(
      "CREATE TABLE leash_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO leash_schema VALUES (1, 2)",
    );
    leash.close();
    await assert.rejects(readHeart(allocated.paths), /heart schema version must be 29/u);
    await assert.rejects(HeldAkumaLeash.try(allocated.paths), /leash schema version must be 4/u);
    writeFileSync(allocated.paths.log, "stdio\n");
    writeFileSync(`${allocated.paths.heart}-wal`, "wal\n");
    mkdirSync(join(allocated.paths.requests, "1"), { recursive: true });
    writeFileSync(join(allocated.paths.requests, "1", "41111111-1111-4111-8111-111111111111.request.json"), "{}\n");
    const recognizedUnknown = join(allocated.paths.directory, "unknown.bin");
    writeFileSync(recognizedUnknown, "preserve recognized unknown\n");
    const settings = join(world, ".keiyaku", "settings.json");
    const namespace = join(world, ".keiyaku", "namespace", "current");
    const unknown = join(world, ".keiyaku", "unknown.bin");
    mkdirSync(join(world, ".keiyaku", "namespace"), { recursive: true });
    writeFileSync(namespace, "retained\n");
    writeFileSync(settings, '{"project":true}\n');
    writeFileSync(unknown, "unknown\n");
    const foreignByte = join(foreign, "foreign.txt");
    writeFileSync(foreignByte, "retain\n");

    assert.deepEqual(await nuke({ world, confirm: world }), {
      operation: "nuke",
      kind: "accepted",
      world,
      effects: [],
      pending: [],
      value: { removed: { refs: 3, worktrees: 1, tasks: 1 } },
    });
    assert.equal(existsSync(allocated.paths.heart), false);
    assert.equal(existsSync(allocated.paths.leash), false);
    assert.equal(existsSync(allocated.paths.log), false);
    assert.equal(existsSync(`${allocated.paths.heart}-wal`), false);
    assert.equal(
      existsSync(join(allocated.paths.requests, "1", "41111111-1111-4111-8111-111111111111.request.json")),
      false,
    );
    assert.equal(readFileSync(recognizedUnknown, "utf8"), "preserve recognized unknown\n");
    assert.equal(existsSync(join(world, ".keiyaku", "tasks", "remove-me.md")), false);
    assert.equal(existsSync(managedPath), false);
    assert.throws(() => raw.run(["show-ref", "--verify", "--quiet", "refs/heads/keiyaku-state"]));
    assert.equal(raw.run(["show-ref", "--verify", "--quiet", "refs/heads/business-branch"]), "");
    assert.equal(readFileSync(settings, "utf8"), '{"project":true}\n');
    assert.equal(readFileSync(namespace, "utf8"), "retained\n");
    assert.equal(readFileSync(unknown, "utf8"), "unknown\n");
    assert.equal(readFileSync(foreignByte, "utf8"), "retain\n");
    assert.deepEqual(await nuke({ world, confirm: world }), {
      operation: "nuke",
      kind: "accepted",
      world,
      effects: [],
      pending: [],
      value: { removed: { refs: 0, worktrees: 0, tasks: 0 } },
    });
  } finally {
    rmSync(fixture.raw.path, { recursive: true, force: true });
    rmSync(fixture.foreign, { recursive: true, force: true });
  }
});

test("confirmed nuke preserves unknown descendants inside the request channel", async () => {
  const world = await testWorld();
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "feedface" });
    await initializeHeart(allocated.paths);
    const sequence = join(allocated.paths.requests, "1");
    mkdirSync(sequence, { recursive: true });
    writeFileSync(join(sequence, "41111111-1111-4111-8111-111111111111.request.json"), "{}\n");
    writeFileSync(join(sequence, "41111111-1111-4111-8111-111111111111.receipt.json"), "{}\n");
    const unknownFile = join(sequence, "unknown.bin");
    const unknownDir = join(sequence, "unknown-dir");
    const unknownLink = join(sequence, "unknown-link");
    const requestLink = join(sequence, "42222222-2222-4222-8222-222222222222.request.json");
    const invalidUuid = join(sequence, "11111111-1111-1111-1111-111111111111.request.json");
    writeFileSync(unknownFile, "keep-request-unknown\n");
    writeFileSync(invalidUuid, "keep-invalid-uuid\n");
    mkdirSync(unknownDir);
    writeFileSync(join(unknownDir, "nested.request.json"), "nested\n");
    symlinkSync(unknownFile, unknownLink);
    symlinkSync(unknownFile, requestLink);
    writeFileSync(join(allocated.paths.requests, "not-a-sequence.request.json"), "sibling\n");
    mkdirSync(join(allocated.paths.requests, "other-dir"));
    writeFileSync(join(allocated.paths.requests, "other-dir", "inside.bin"), "inside\n");
    assert.deepEqual(await nuke({ world, confirm: world }), {
      operation: "nuke",
      kind: "accepted",
      world,
      effects: [],
      pending: [],
      value: { removed: { refs: 0, worktrees: 0, tasks: 0 } },
    });
    assert.equal(existsSync(join(sequence, "41111111-1111-4111-8111-111111111111.request.json")), false);
    assert.equal(existsSync(join(sequence, "41111111-1111-4111-8111-111111111111.receipt.json")), false);
    assert.equal(readFileSync(unknownFile, "utf8"), "keep-request-unknown\n");
    assert.equal(readFileSync(invalidUuid, "utf8"), "keep-invalid-uuid\n");
    assert.equal(readFileSync(join(unknownDir, "nested.request.json"), "utf8"), "nested\n");
    assert.equal(readFileSync(unknownLink, "utf8"), "keep-request-unknown\n");
    assert.equal(readFileSync(requestLink, "utf8"), "keep-request-unknown\n");
    assert.equal(readFileSync(join(allocated.paths.requests, "not-a-sequence.request.json"), "utf8"), "sibling\n");
    assert.equal(readFileSync(join(allocated.paths.requests, "other-dir", "inside.bin"), "utf8"), "inside\n");
    assert.equal(existsSync(allocated.paths.heart), false);
    assert.equal(existsSync(allocated.paths.leash), false);
    assert.equal(existsSync(sequence), true);
    assert.equal(existsSync(allocated.paths.requests), true);
    for (const name of ["01", "00", "9007199254740992", "9007199254740993"]) {
      const noncanonical = join(allocated.paths.requests, name);
      mkdirSync(noncanonical);
      writeFileSync(join(noncanonical, "43333333-3333-4333-8333-333333333333.request.json"), "keep-noncanonical\n");
    }
    assert.deepEqual(await nuke({ world, confirm: world }), {
      operation: "nuke",
      kind: "accepted",
      world,
      effects: [],
      pending: [],
      value: { removed: { refs: 0, worktrees: 0, tasks: 0 } },
    });
    for (const name of ["01", "00", "9007199254740992", "9007199254740993"]) {
      assert.equal(
        readFileSync(join(allocated.paths.requests, name, "43333333-3333-4333-8333-333333333333.request.json"), "utf8"),
        "keep-noncanonical\n",
      );
    }
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

test("confirmed nuke preserves recognized entries when stop cannot take custody", async () => {
  const fixture = await gitNukeFixture();
  const { world, raw } = fixture;
  try {
    const task = await Tasks.of(world).add({ title: "Keep task while writer lives" });
    assert.ok(task.kind === "accepted");
    const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "deadbeef" });
    await initializeHeart(allocated.paths);
    const soul: Soul = {
      id: allocated.id,
      archetype: "claude",
      provider: CLAUDE_EXECUTION,
      options: {},
      cwd: world,
      origin: { kind: "direct" },
      allowed: ALLOWED_ACTIONS,
      createdAt: "2026-08-19T00:00:00.000Z",
    };
    const leash = (await HeldAkumaLeash.try(allocated.paths))!;
    try {
      await leash.birth(allocated.paths, soul);
      await leash.recordBody(allocated.paths, { leashTakenAt: "2026-08-19T00:00:00.000Z" });
      writeFileSync(allocated.paths.log, "stdio\n");
      mkdirSync(allocated.paths.requests, { recursive: true });
      writeFileSync(join(allocated.paths.requests, "pending.json"), "claim\n");
      const result = await nuke({ world, confirm: world });
      assert.equal(result.kind, "accepted");
      assert.equal(result.value.removed.refs, 0);
      assert.equal(result.value.removed.worktrees, 0);
      assert.equal(result.value.removed.tasks, 0);
      assert.deepEqual(result.effects, [
        {
          kind: "reset-owner-stopped",
          world,
          owner: "akuma",
          diagnostic: `Akuma ${allocated.id} could not be stopped: unavailable`,
        },
      ]);
      assert.deepEqual(result.pending, [{ surface: "reset", required: true }]);
      assert.equal(refPresent(raw, "refs/heads/keiyaku-state"), true);
      assert.equal(refPresent(raw, "refs/keiyaku/delivery/nuke-managed"), true);
      assert.equal(existsSync(fixture.managedPath), true);
      assert.ok(await Tasks.of(world).task({ id: task.value.id }).read());
      assert.equal(existsSync(allocated.paths.heart), true);
      assert.equal(existsSync(allocated.paths.leash), true);
      assert.equal(existsSync(allocated.paths.log), true);
      assert.equal(readFileSync(join(allocated.paths.requests, "pending.json"), "utf8"), "claim\n");
    } finally {
      leash.release();
    }
  } finally {
    raw.run(["worktree", "remove", "--force", fixture.foreign]);
    rmSync(world, { recursive: true, force: true });
  }
});

test("Git nuke refuses a changed state OID before deleting regenerable topology", async () => {
  const fixture = await gitNukeFixture();
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-nuke-state-race-")), "calls");
  const raced = join(calls, "..", "raced");
  fixture.raw.run(["commit", "--allow-empty", "--quiet", "-m", "moved-state"]);
  const moved = fixture.raw.run(["rev-parse", "HEAD"]).trim();
  try {
    await assert.rejects(() =>
      withGitShim(
        gitNukeShim(
          [
            'if [ "$1" = "update-ref" ] && [ "$2" = "--no-deref" ] && [ "$3" = "-d" ] && [ "$4" = "refs/heads/keiyaku-state" ] && [ ! -f "$KEIYAKU_RACE_DONE" ]; then',
            ': > "$KEIYAKU_RACE_DONE"',
            '"$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$KEIYAKU_RACE_STATE"',
            "fi",
          ].join("\n"),
        ),
        { KEIYAKU_CALLS: calls, KEIYAKU_RACE_DONE: raced, KEIYAKU_RACE_STATE: moved },
        (gitPath) => nukeGit(fixture.world, gitPath),
      ),
    );
    assert.equal(existsSync(fixture.managedPath), true);
    assert.equal(refPresent(fixture.raw, "refs/heads/keiyaku-state"), true);
    assert.equal(refPresent(fixture.raw, "refs/keiyaku/delivery/nuke-managed"), true);
    assert.equal(refPresent(fixture.raw, "refs/keiyaku/candidate/nuke-managed"), true);
    assert.equal(readFileSync(calls, "utf8").includes("worktree remove --force "), false);
    await nukeGit(fixture.world);
    assert.equal(existsSync(fixture.managedPath), false);
    assert.equal(refPresent(fixture.raw, "refs/heads/keiyaku-state"), false);
  } finally {
    rmSync(fixture.raw.path, { recursive: true, force: true });
    rmSync(fixture.foreign, { recursive: true, force: true });
  }
});

test("Git nuke exact-read-backs an unknown state deletion before topology cleanup", async () => {
  const fixture = await gitNukeFixture();
  const marker = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-nuke-unknown-state-")), "done");
  try {
    const capability = await repositoryAt(fixture.world);
    const held = await acquireSqliteTransactionLock({
      path: privateStatePublicationSeatPath(capability),
      mode: "immediate",
    });
    const { promise: arrival, resolve: resolveArrival } = promiseBarrier<void>();
    const pending = withGitShim(
      gitNukeShim(
        [
          'if [ "$1" = "update-ref" ] && [ "$2" = "--no-deref" ] && [ "$3" = "-d" ] && [ "$4" = "refs/heads/keiyaku-state" ] && [ ! -e "$KEIYAKU_UNKNOWN_DONE" ]; then',
          '  : > "$KEIYAKU_UNKNOWN_DONE"',
          '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
          "  kill -TERM $$",
          "fi",
        ].join("\n"),
      ),
      { KEIYAKU_UNKNOWN_DONE: marker },
      (gitPath) => nukeGit(fixture.world, gitPath, { onPrivateStateSeatContention: resolveArrival }),
    );
    await arrival;
    assert.equal(refPresent(fixture.raw, "refs/heads/keiyaku-state"), true);
    assert.equal(existsSync(fixture.managedPath), true);
    held.close();
    await pending;
    assert.equal(refPresent(fixture.raw, "refs/heads/keiyaku-state"), false);
    assert.equal(existsSync(fixture.managedPath), false);
    assert.equal(refPresent(fixture.raw, "refs/keiyaku/delivery/nuke-managed"), false);
  } finally {
    rmSync(fixture.raw.path, { recursive: true, force: true });
    rmSync(fixture.foreign, { recursive: true, force: true });
  }
});

test("Git nuke retains a leaf whose expected OID changed and retries later", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(raw.path);
  const racedRef = "refs/keiyaku/delivery/legacy";
  for (const ref of [
    racedRef,
    "refs/keiyaku/candidate/legacy",
    "refs/keiyaku/delivery/current",
    "refs/keiyaku/candidate/current",
    "refs/heads/business-branch",
    "refs/heads/keiyaku-state",
  ])
    raw.run(["update-ref", ref, "HEAD"]);
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "moved-leaf"]);
  const moved = raw.run(["rev-parse", "HEAD"]).trim();
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-nuke-leaf-race-")), "calls");
  const raced = join(calls, "..", "raced");
  try {
    await assert.rejects(() =>
      withGitShim(
        gitNukeShim(
          [
            'if [ "$1" = "update-ref" ] && [ "$2" = "--no-deref" ] && [ "$3" = "-d" ] && [ "$4" = "$KEIYAKU_RACE_REF" ] && [ ! -f "$KEIYAKU_RACE_DONE" ]; then',
            ': > "$KEIYAKU_RACE_DONE"',
            '"$KEIYAKU_REAL_GIT" update-ref "$KEIYAKU_RACE_REF" "$KEIYAKU_RACE_OID"',
            "fi",
          ].join("\n"),
        ),
        { KEIYAKU_CALLS: calls, KEIYAKU_RACE_DONE: raced, KEIYAKU_RACE_REF: racedRef, KEIYAKU_RACE_OID: moved },
        (gitPath) => nukeGit(world, gitPath),
      ),
    );
    assert.equal(refPresent(raw, "refs/heads/keiyaku-state"), false);
    assert.equal(refPresent(raw, racedRef), true);
    assert.equal(refPresent(raw, "refs/heads/business-branch"), true);
    await nukeGit(world);
    assert.equal(refPresent(raw, racedRef), false);
    assert.equal(refPresent(raw, "refs/keiyaku/candidate/legacy"), false);
    assert.equal(refPresent(raw, "refs/keiyaku/delivery/current"), false);
    assert.equal(refPresent(raw, "refs/keiyaku/candidate/current"), false);
    assert.equal(refPresent(raw, "refs/heads/business-branch"), true);
  } finally {
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("Git nuke retains an attached appointed worktree while clearing independent refs", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(raw.path);
  const repository = await repositoryAt(world);
  const contract = contractId("kei/nuke-attached");
  const register = await appointManagedWorktrees(repository, [contract]);
  const path = worktreePath(repository, register.byContract.get(contract)!.place);
  raw.run(["worktree", "add", "--quiet", "-b", "nuke-attached-branch", path, "HEAD"]);
  raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  try {
    await assert.rejects(() => nukeGit(world), /Place authority still has managed worktree appointments/u);
    assert.equal(existsSync(path), true);
    assert.equal(raw.run(["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"]), "nuke-attached-branch\n");
    assert.equal(refPresent(raw, "refs/heads/keiyaku-state"), false);
    assert.equal(existsSync(placeRegisterPath(repository)), true);
    assert.equal(existsSync(placeLockPath(repository)), true);
  } finally {
    raw.run(["worktree", "remove", "--force", path]);
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("Git nuke retains an unregistered appointed path whose admin is foreign", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(raw.path);
  const repository = await repositoryAt(world);
  const contract = contractId("kei/nuke-foreign-admin");
  const register = await appointManagedWorktrees(repository, [contract]);
  const path = worktreePath(repository, register.byContract.get(contract)!.place);
  const foreign = makeGitRepository();
  foreign.run(["commit", "--allow-empty", "--quiet", "-m", "foreign"]);
  foreign.run(["worktree", "add", "--quiet", "--detach", path, "HEAD"]);
  writeFileSync(join(path, "keep.txt"), "foreign\n");
  raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  try {
    await assert.rejects(() => nukeGit(world), /managed Place path has foreign custody/u);
    assert.equal(existsSync(path), true);
    assert.equal(readFileSync(join(path, "keep.txt"), "utf8"), "foreign\n");
    assert.equal(existsSync(placeRegisterPath(repository)), true);
    assert.equal(refPresent(raw, "refs/heads/keiyaku-state"), false);
  } finally {
    foreign.run(["worktree", "remove", "--force", path]);
    rmSync(foreign.path, { recursive: true, force: true });
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("Git nuke removes proven unregistered appointed residue", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(raw.path);
  const repository = await repositoryAt(world);
  const contract = contractId("kei/nuke-residue");
  const register = await appointManagedWorktrees(repository, [contract]);
  const path = worktreePath(repository, register.byContract.get(contract)!.place);
  const admin = join(commonGitDirectory(repository), "worktrees", "nuke-residue");
  mkdirSync(path, { recursive: true });
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(path, ".git"), `gitdir: ${admin}\n`);
  writeFileSync(join(path, "owned.txt"), "residue\n");
  writeFileSync(join(admin, "commondir"), "../..\n");
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/main\n");
  raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  try {
    await nukeGit(world);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(placeRegisterPath(repository)), false);
    assert.equal(existsSync(placeLockPath(repository)), true);
  } finally {
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("CLI nuke returns native refusal outcomes for missing and mismatched confirmation", async () => {
  const world = await testWorld();
  try {
    const required = await cliJson<NukeResult>(["-C", world, "nuke"], { cwd: world });
    const rejected = await cliJson<NukeResult>(["-C", world, "nuke", "--confirm", "wrong"], { cwd: world });
    assert.equal(required.value.kind, "refused");
    assert.equal(rejected.value.kind, "refused");
    if (required.value.kind !== "refused" || rejected.value.kind !== "refused")
      throw new Error("missing nuke refusal");
    assert.equal(
      renderNukeText(required.value),
      [
        "× nuke refused",
        "  reason  nuke confirmation required",
        `  world  ${world}`,
        `  option  keiyaku nuke --confirm '${world}'`,
      ].join("\n"),
    );
    assert.equal(
      renderNukeText(rejected.value),
      [
        "× nuke refused",
        "  reason  nuke confirmation mismatch",
        `  world  ${world}`,
        "  confirmation  wrong",
        `  option  keiyaku nuke --confirm '${world}'`,
      ].join("\n"),
    );
    assert.deepEqual(required.value.refusal, { kind: "nuke-confirmation-required", world });
    assert.deepEqual(rejected.value.refusal, { kind: "nuke-confirmation-mismatch", world, confirmation: "wrong" });
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

test("CLI nuke confirmation refusal is stdout exit 1 with labeled recovery facts", async () => {
  const world = await testWorld();
  const { exit, stdout, stderr } = await captureOutput(async () => {
    try {
      return await main(["-C", world, "nuke"]);
    } finally {
      rmSync(world, { recursive: true, force: true });
    }
  });
  assert.equal(exit, 1);
  assert.match(stdout, /^× nuke refused$/mu);
  assert.match(stdout, /^  reason  nuke confirmation required$/mu);
  assert.match(stdout, /^  world  /mu);
  assert.match(stdout, /^  option  keiyaku nuke --confirm /mu);
  assert.equal(stderr, "");
});

test("nuke receipt names confirmed removals and retained coordination locks", () => {
  const text = renderNukeText({
    operation: "nuke",
    kind: "accepted",
    world: "/world" as never,
    effects: [],
    pending: [],
    value: { removed: { refs: 3, worktrees: 1, tasks: 2 } },
  });
  assert.match(text, /refs removed  3/u);
  assert.match(text, /worktrees removed  1/u);
  assert.match(text, /task stores removed  2/u);
  assert.match(text, /locks  may remain · SQLite coordination files cannot be removed safely/u);
});

test("CLI nuke exit code reports owner failure", () => {
  assert.equal(
    nukeExitCode({
      operation: "nuke",
      kind: "accepted",
      world: "/world" as never,
      effects: [{ kind: "reset-owner-stopped", world: "/world", owner: "git", diagnostic: "busy" }],
      pending: [{ surface: "reset", required: true }],
      value: { removed: { refs: 1, worktrees: 0, tasks: 0 } },
    }),
    2,
  );
  assert.equal(
    nukeExitCode({
      operation: "nuke",
      kind: "accepted",
      world: "/world" as never,
      effects: [],
      pending: [],
      value: { removed: { refs: 0, worktrees: 0, tasks: 0 } },
    }),
    0,
  );
  assert.equal(
    nukeExitCode({
      operation: "nuke",
      kind: "refused",
      world: "/world" as never,
      effects: [],
      pending: [],
      refusal: { kind: "nuke-confirmation-required", world: "/world" as never },
    }),
    1,
  );
});

test("native reset awaits independent removals and keeps their counts on an exceptional owner retirement", async () => {
  const { nukeKeiyaku } = await import("../src/library/nuke.js");
  const { KeiyakuError } = await import("../src/index.js");
  const fixture = await gitNukeFixture();
  const { raw, world } = fixture;
  const original = new TypeError("reset owner retirement bug");
  try {
    raw.run(["update-ref", "-d", "refs/heads/keiyaku-state"]);
    const task = await Tasks.of(world).add({ title: "Independent reset owner" });
    assert.ok(task.kind === "accepted");
    await assert.rejects(
      nukeKeiyaku(
        { world, confirm: world },
        {
          onPrivateStateSeatClose: () => {
            throw original;
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.category, "internal");
        assert.equal(error.cause, original);
        assert.ok(error.outcome?.operation === "nuke");
        assert.deepEqual(error.outcome.value?.removed, { refs: 2, worktrees: 1, tasks: 1 });
        return true;
      },
    );
    assert.equal(await Tasks.of(world).task({ id: task.value.id }).read(), null);
    assert.equal(existsSync(fixture.managedPath), false);
    assert.equal(refPresent(raw, "refs/keiyaku/delivery/nuke-managed"), false);
    assert.equal(refPresent(raw, "refs/heads/business-branch"), true);
  } finally {
    raw.run(["worktree", "remove", "--force", fixture.foreign]);
    rmSync(world, { recursive: true, force: true });
  }
});

test("native reset returns a required partial stop after confirmed deletion and awaits independent owners", async () => {
  const fixture = await gitNukeFixture();
  const { raw, world, managedPath } = fixture;
  try {
    const task = await Tasks.of(world).add({ title: "Independent owner despite Git stop" });
    assert.ok(task.kind === "accepted");
    raw.run(["worktree", "remove", "--force", managedPath]);
    mkdirSync(managedPath, { recursive: true });
    writeFileSync(join(managedPath, "foreign.txt"), "not owned by Git cleanup\n");
    const result = await nuke({ world, confirm: world });
    assert.ok(result.kind === "accepted");
    assert.deepEqual(result.value.removed, { refs: 1, worktrees: 0, tasks: 1 });
    assert.deepEqual(result.pending, [{ surface: "reset", required: true }]);
    assert.deepEqual(result.effects, [
      {
        kind: "reset-owner-stopped",
        world,
        owner: "git",
        diagnostic: `managed Place path has foreign custody: ${managedPath}`,
      },
    ]);
    assert.equal(await Tasks.of(world).task({ id: task.value.id }).read(), null);
    assert.equal(refPresent(raw, "refs/heads/keiyaku-state"), false);
    assert.equal(refPresent(raw, "refs/keiyaku/delivery/nuke-managed"), true);
    assert.equal(readFileSync(join(managedPath, "foreign.txt"), "utf8"), "not owned by Git cleanup\n");
  } finally {
    raw.run(["worktree", "remove", "--force", fixture.foreign]);
    rmSync(world, { recursive: true, force: true });
  }
});
