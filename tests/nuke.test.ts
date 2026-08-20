import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, KeiyakuRefused, World } from "../src/index.js";
import { driveAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import { HeldAkumaLeash, finishBodyIfIdle, initializeHeart, readHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { stopAkuma } from "../src/akuma/nuke.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { moveAlias } from "../src/alias/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { renderRefusal } from "../src/cli/render/refusal.js";
import { nukeExitCode } from "../src/cli/render/nuke.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { contractLocator } from "../src/git/identity.js";
import { commonGitDirectory, repositoryAt, worktreeGitDirectory } from "../src/git/repository.js";
import { worktreePath } from "../src/git/workspace.js";
import { reserveContractWorktree } from "../src/contract-worktree.js";
import { settlementFencePath } from "../src/settlement/fence.js";
import { appointManagedWorktrees, readPlaceRegister } from "../src/workspace-place.js";
import { contractId } from "../src/core/facts/types.js";
import { Tasks } from "../src/task/index.js";
import { makeGitRepository } from "./support/git.js";

const CLAUDE_EXECUTION = { name: "claude", kind: "claude-agent-sdk" } as const;

async function testWorld() {
  return await World.at(mkdtempSync(join(tmpdir(), "keiyaku-v4-nuke-")));
}

async function leaveIdleLock(path: string): Promise<void> {
  const held = await acquireSqliteTransactionLock({ path, mode: "immediate" });
  held.close();
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
  await reserveContractWorktree(repository, contractId("kei/nuke-here"));
  const common = commonGitDirectory(repository);
  const locator = contractLocator(managed);
  const reconcileLock = join(common, "keiyaku", "locks", "reconcile", locator.slice(0, 2), `${locator.slice(2)}.sqlite`);
  const settlementLock = settlementFencePath(repository, "task/nuke-settlement" as never);
  await leaveIdleLock(reconcileLock);
  await leaveIdleLock(settlementLock);
  raw.run(["branch", "business-branch"]);
  raw.run(["update-ref", "refs/heads/keiyaku-delivery/nuke-managed", "HEAD"]);
  raw.run(["update-ref", "refs/heads/keiyaku-candidate/nuke-managed", "HEAD"]);
  raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  const foreign = `${raw.path}-foreign`;
  raw.run(["worktree", "add", "--detach", foreign, "HEAD"]);
  return {
    raw,
    world,
    repository,
    managedPath,
    foreign,
    locks: [
      join(common, "keiyaku", "contract-worktree.sqlite"),
      join(common, "keiyaku", "locks", "places.sqlite"),
      reconcileLock,
      settlementLock,
    ],
  };
}

async function runningAkuma(world: Awaited<ReturnType<typeof testWorld>>) {
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "3456cdef" });
  await initializeHeart(allocated.paths);
  let aborted = false;
  let settle!: (result: { kind: "failed"; diagnostic: string }) => void;
  const completion = new Promise<{ kind: "failed"; diagnostic: string }>((resolve) => { settle = resolve; });
  const provider: ProviderAdapter = {
    admitOptions(options) { return { kind: "admitted", options }; },
    async start() {
      return {
        admission: { fence: "nuke-fixture-turn" },
        events: { async *[Symbol.asyncIterator]() { while (!aborted) { yield { type: "note" as const, text: "working" }; await new Promise((resolve) => setTimeout(resolve, 10)); } } },
        completion,
        async abort() { aborted = true; settle({ kind: "failed", diagnostic: "stopped" }); },
      };
    },
  };
  const launch: BodyLaunch = { paths: allocated.paths, seed: { id: allocated.id, archetype: "claude", provider: CLAUDE_EXECUTION, options: {}, origin: { kind: "direct" }, cwd: world }, initialBody: "keep working" };
  const body = driveAkumaBody(launch, provider, { now: () => "2026-08-19T00:00:00.000Z" });
  while ((await readHeart(allocated.paths)).latestBody === null) await new Promise((resolve) => setTimeout(resolve, 5));
  return { allocated, body };
}

test("bare and mismatched nuke confirmations refuse before deletion", async () => {
  const world = await testWorld();
  const sentinel = join(world, ".keiyaku", "sentinel");
  try {
    writeFileSync(sentinel, "preserve\n");
    await assert.rejects(Keiyaku.nuke({ world }), (error: unknown) => error instanceof KeiyakuRefused
      && error.refusal.kind === "nuke-confirmation-required" && error.refusal.world === world);
    await assert.rejects(Keiyaku.nuke({ world, confirm: "wrong" }), (error: unknown) => error instanceof KeiyakuRefused
      && error.refusal.kind === "nuke-confirmation-mismatch" && error.refusal.confirmation === "wrong");
    assert.equal(readFileSync(sentinel, "utf8"), "preserve\n");
  } finally { rmSync(world, { recursive: true, force: true }); }
});

test("confirmed nuke stops live writers and removes owned state while preserving boundaries", async () => {
  const fixture = await gitNukeFixture();
  try {
    const { raw, world, repository, managedPath, foreign, locks } = fixture;
    const tasks = Tasks.of(world);
    assert.equal((await tasks.add({ title: "Remove me" })).kind, "accepted");
    const namespace = join(world, ".keiyaku", "namespace", "current");
    mkdirSync(join(world, ".keiyaku", "namespace"), { recursive: true });
    writeFileSync(namespace, "retained\n");
    const running = await runningAkuma(world);
    await moveAlias({ world, alias: "@running", akuId: running.allocated.id });
    const settings = join(world, ".keiyaku", "settings.json");
    const unknown = join(world, ".keiyaku", "unknown.bin");
    const unknownRun = join(world, ".keiyaku", "akuma", "run", "foreign-12345678");
    const orphanRun = join(world, ".keiyaku", "akuma", "run", "foreign-87654321");
    const foreignByte = join(foreign, "foreign.txt");
    writeFileSync(settings, "{\"project\":true}\n");
    writeFileSync(unknown, "unknown\n");
    mkdirSync(unknownRun, { recursive: true });
    writeFileSync(join(unknownRun, "bytes.bin"), "foreign runtime\n");
    mkdirSync(orphanRun, { recursive: true });
    writeFileSync(join(orphanRun, "leash.db"), "orphan leash\n");
    writeFileSync(foreignByte, "retain\n");

    assert.deepEqual(await Keiyaku.nuke({ world, confirm: world }), { kind: "success", world });
    await running.body;
    assert.equal(existsSync(running.allocated.paths.heart), false);
    assert.equal(existsSync(running.allocated.paths.leash), true);
    assert.equal(existsSync(join(running.allocated.paths.directory, "requests")), true);
    assert.equal(existsSync(join(world, ".keiyaku", "akuma", "alias.json")), false);
    assert.equal(existsSync(join(world, ".keiyaku", "locks", "akuma-alias.sqlite")), true);
    assert.equal(existsSync(join(world, ".keiyaku", "tasks", "remove-me.md")), false);
    assert.equal(existsSync(join(world, ".keiyaku", "locks", "task-allocation.sqlite")), true);
    for (const lock of locks) assert.equal(existsSync(lock), true, lock);
    assert.equal(existsSync(managedPath), false);
    assert.throws(() => raw.run(["show-ref", "--verify", "--quiet", "refs/heads/keiyaku-state"]));
    assert.equal(raw.run(["show-ref", "--verify", "--quiet", "refs/heads/business-branch"]), "");
    assert.equal(readFileSync(settings, "utf8"), "{\"project\":true}\n");
    assert.equal(readFileSync(namespace, "utf8"), "retained\n");
    assert.equal(readFileSync(unknown, "utf8"), "unknown\n");
    assert.equal(readFileSync(join(unknownRun, "bytes.bin"), "utf8"), "foreign runtime\n");
    assert.equal(readFileSync(join(orphanRun, "leash.db"), "utf8"), "orphan leash\n");
    assert.equal(readFileSync(foreignByte, "utf8"), "retain\n");
    assert.deepEqual(await Keiyaku.nuke({ world, confirm: world }), { kind: "success", world });
    for (const lock of locks) assert.equal(existsSync(lock), true);
  } finally {
    rmSync(fixture.raw.path, { recursive: true, force: true });
    rmSync(fixture.foreign, { recursive: true, force: true });
  }
});

test("Akuma nuke retains custody from stop through deletion", async () => {
  const world = await testWorld();
  try {
    const running = await runningAkuma(world);
    const deleteAkuma = await stopAkuma(world);
    await running.body;
    assert.equal(await HeldAkumaLeash.try(running.allocated.paths), null);
    await deleteAkuma();
    assert.equal(existsSync(running.allocated.paths.heart), false);
    assert.equal(existsSync(running.allocated.paths.leash), true);
  } finally { rmSync(world, { recursive: true, force: true }); }
});

test("Akuma nuke preserves unknown bytes inside recognized custody", async () => {
  const world = await testWorld();
  try {
    const running = await runningAkuma(world);
    const unknown = join(running.allocated.paths.directory, "foreign.bin");
    writeFileSync(unknown, "foreign runtime\n");
    const deleteAkuma = await stopAkuma(world);
    await running.body;
    await deleteAkuma();
    assert.equal(readFileSync(unknown, "utf8"), "foreign runtime\n");
    assert.equal(existsSync(running.allocated.paths.heart), false);
    assert.equal(existsSync(running.allocated.paths.leash), true);
    assert.equal(existsSync(running.allocated.paths.directory), true);
  } finally { rmSync(world, { recursive: true, force: true }); }
});

test("owner failure becomes one diagnostic and leaves failed custody for retry", async () => {
  const world = await testWorld();
  try {
    const broken = join(world, ".keiyaku", "tasks", "broken.md");
    mkdirSync(join(world, ".keiyaku", "tasks"), { recursive: true });
    writeFileSync(broken, "not Task authority\n");
    const result = await Keiyaku.nuke({ world, confirm: world });
    assert.equal(result.kind, "failed");
    assert.equal(result.world, world);
    assert.match(result.diagnostic, /task document/u);
    assert.equal(existsSync(broken), true);
  } finally { rmSync(world, { recursive: true, force: true }); }
});

test("owner deletion attempts remain independent after the stop prerequisite", async () => {
  const fixture = await gitNukeFixture();
  try {
    const { raw, world, managedPath } = fixture;
    const broken = join(world, ".keiyaku", "tasks", "broken.md");
    mkdirSync(join(world, ".keiyaku", "tasks"), { recursive: true });
    writeFileSync(broken, "not Task authority\n");
    const result = await Keiyaku.nuke({ world, confirm: world });
    assert.equal(result.kind, "failed");
    assert.equal(existsSync(managedPath), false);
    assert.throws(() => raw.run(["show-ref", "--verify", "--quiet", "refs/heads/keiyaku-state"]));
    assert.equal(existsSync(broken), true);
  } finally {
    rmSync(fixture.raw.path, { recursive: true, force: true });
    rmSync(fixture.foreign, { recursive: true, force: true });
  }
});

test("Git nuke lock timeout preserves custody and retries after release", async () => {
  const fixture = await gitNukeFixture();
  const held = await acquireSqliteTransactionLock({ path: fixture.locks[0]!, mode: "immediate" });
  try {
    const failed = await Keiyaku.nuke({ world: fixture.world, confirm: fixture.world });
    assert.equal(failed.kind, "failed");
    assert.match(failed.diagnostic, /SQLite lock timed out after 3000ms/u);
    assert.equal(existsSync(fixture.managedPath), true);
  } finally {
    held.close();
  }
  try {
    assert.deepEqual(await Keiyaku.nuke({ world: fixture.world, confirm: fixture.world }), { kind: "success", world: fixture.world });
  } finally {
    rmSync(fixture.raw.path, { recursive: true, force: true });
    rmSync(fixture.foreign, { recursive: true, force: true });
  }
});

test("Git nuke respects the linked worktree appointment writer lock", async () => {
  const fixture = await gitNukeFixture();
  const linkedContract = contractId("kei/nuke-linked");
  const linkedRepository = { ...fixture.repository, effectiveCwd: fixture.foreign };
  await reserveContractWorktree(linkedRepository, linkedContract);
  const linkedAdmin = await worktreeGitDirectory(fixture.repository, fixture.foreign);
  const linkedLock = join(linkedAdmin, "keiyaku", "contract-worktree.sqlite");
  const held = await acquireSqliteTransactionLock({ path: linkedLock, mode: "immediate" });
  const appointment = join(fixture.foreign, ".keiyaku", "KEIYAKU.md");
  try {
    const failed = await Keiyaku.nuke({ world: fixture.world, confirm: fixture.world });
    assert.equal(failed.kind, "failed");
    assert.match(failed.diagnostic, /SQLite lock timed out after 3000ms/u);
    assert.equal(existsSync(appointment), true);
  } finally {
    held.close();
  }
  try {
    assert.deepEqual(await Keiyaku.nuke({ world: fixture.world, confirm: fixture.world }), { kind: "success", world: fixture.world });
    assert.equal(existsSync(appointment), false);
  } finally {
    rmSync(fixture.raw.path, { recursive: true, force: true });
    rmSync(fixture.foreign, { recursive: true, force: true });
  }
});

test("foreign reconcile and settlement lock bytes remain inert during Git nuke", async () => {
  const fixture = await gitNukeFixture();
  const common = commonGitDirectory(fixture.repository);
  const reconcileForeign = join(common, "keiyaku", "locks", "reconcile", "foreign.bin");
  const settlementForeign = join(common, "keiyaku", "locks", "settlement", "foreign-dir");
  const settlementLink = join(common, "keiyaku", "locks", "settlement", "foreign-link");
  try {
    writeFileSync(reconcileForeign, "foreign\n");
    mkdirSync(settlementForeign, { recursive: true });
    symlinkSync(fixture.world, settlementLink);
    assert.deepEqual(await Keiyaku.nuke({ world: fixture.world, confirm: fixture.world }), { kind: "success", world: fixture.world });
    assert.equal(readFileSync(reconcileForeign, "utf8"), "foreign\n");
    assert.equal(existsSync(settlementForeign), true);
    assert.equal(existsSync(settlementLink), true);
  } finally {
    rmSync(fixture.raw.path, { recursive: true, force: true });
    rmSync(fixture.foreign, { recursive: true, force: true });
  }
});

test("CLI renders confirmation-required and confirmation-mismatch refusals", async () => {
  const world = await testWorld();
  try {
    const bare = parseArgv(["-C", world, "nuke"]);
    const mismatch = parseArgv(["-C", world, "nuke", "--confirm", "wrong"]);
    if ("help" in bare || "help" in mismatch) throw new Error("nuke invocation parsed as help");
    const required = await invoke(bare, { cwd: world });
    const rejected = await invoke(mismatch, { cwd: world });
    assert.equal(renderRefusal(required as Extract<typeof required, { kind: "refused" }>, { columns: 1000, color: false }), ["! nuke refused", `   nuke confirmation required world=${world}`, `   keiyaku nuke --confirm ${world}`].join("\n"));
    assert.equal(renderRefusal(rejected as Extract<typeof rejected, { kind: "refused" }>, { columns: 1000, color: false }), ["! nuke refused", `   nuke confirmation mismatch world=${world} confirmation=wrong`, `   keiyaku nuke --confirm ${world}`].join("\n"));
  } finally { rmSync(world, { recursive: true, force: true }); }
});

test("CLI nuke exit code reports owner failure", () => {
  assert.equal(nukeExitCode({ kind: "success", world: "/world" as never }), 0);
  assert.equal(nukeExitCode({ kind: "failed", world: "/world" as never, diagnostic: "broken" }), 2);
});
