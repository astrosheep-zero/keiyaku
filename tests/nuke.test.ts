import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, KeiyakuRefused, World } from "../src/index.js";
import { driveAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import { initializeHeart, readHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { moveAlias } from "../src/alias/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { renderRefusal } from "../src/cli/render/refusal.js";
import { nukeExitCode } from "../src/cli/render/nuke.js";
import { nukeGit } from "../src/git/nuke.js";
import { repositoryAt } from "../src/git/repository.js";
import { worktreePath } from "../src/git/workspace.js";
import { appointManagedWorktrees, readPlaceRegister } from "../src/workspace-place.js";
import { contractId } from "../src/core/facts/types.js";
import { TaskAuthorityCorruptionError, Tasks } from "../src/task/index.js";
import { makeGitRepository } from "./support/git.js";

const CLAUDE_EXECUTION = { name: "claude", kind: "claude-agent-sdk" } as const;

async function testWorld() {
  return await World.at(mkdtempSync(join(tmpdir(), "keiyaku-v4-nuke-")));
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
  raw.run(["update-ref", "refs/heads/keiyaku-delivery/nuke-managed", "HEAD"]);
  raw.run(["update-ref", "refs/heads/keiyaku-candidate/nuke-managed", "HEAD"]);
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

test("confirmed nuke removes owned Task authority by path shape without decoding Markdown", async () => {
  const world = await testWorld();
  try {
    const tasks = Tasks.of(world);
    assert.equal((await tasks.add({ title: "Valid owned" })).kind, "accepted");
    const root = join(world, ".keiyaku", "tasks");
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "broken.md"), "not Task authority\n");
    writeFileSync(join(root, "nested", "also-broken.md"), "still corrupt\n");
    await assert.rejects(tasks.list({ scope: "world", selection: "all" }), TaskAuthorityCorruptionError);
    writeFileSync(join(root, "Not-Valid.md"), "invalid coordinate\n");
    writeFileSync(join(root, "keep.txt"), "unknown\n");
    const linked = join(root, "link.md");
    symlinkSync(join(root, "keep.txt"), linked);
    const fifo = join(root, "pipe.md");
    if (process.platform !== "win32") execFileSync("mkfifo", [fifo]);
    const outside = join(world, ".keiyaku", "unknown.bin");
    writeFileSync(outside, "outside\n");
    assert.deepEqual(await Keiyaku.nuke({ world, confirm: world }), { kind: "success", world });
    assert.equal(existsSync(join(root, "valid-owned.md")), false);
    assert.equal(existsSync(join(root, "broken.md")), false);
    assert.equal(existsSync(join(root, "nested", "also-broken.md")), false);
    assert.equal(existsSync(join(root, "nested")), false);
    assert.equal(existsSync(root), true);
    assert.equal(readFileSync(join(root, "Not-Valid.md"), "utf8"), "invalid coordinate\n");
    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "unknown\n");
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
    if (process.platform !== "win32") assert.equal(statSync(fifo).isFIFO(), true);
    assert.equal(readFileSync(outside, "utf8"), "outside\n");
    assert.deepEqual(await Keiyaku.nuke({ world, confirm: world }), { kind: "success", world });
    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "unknown\n");
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

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
    const { raw, world, managedPath, foreign } = fixture;
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
  } finally {
    rmSync(fixture.raw.path, { recursive: true, force: true });
    rmSync(fixture.foreign, { recursive: true, force: true });
  }
});

test("Git nuke removes legacy and migration leaves but preserves ordinary refs", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(raw.path);
  for (const ref of [
    "refs/heads/keiyaku-delivery/legacy",
    "refs/heads/keiyaku-candidate/legacy",
    "refs/keiyaku/delivery/current",
    "refs/keiyaku/candidate/current",
  ]) raw.run(["update-ref", ref, "HEAD"]);
  raw.run(["update-ref", "refs/heads/business-branch", "HEAD"]);
  raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  try {
    await nukeGit(world);
    for (const ref of [
      "refs/heads/keiyaku-delivery/legacy",
      "refs/heads/keiyaku-candidate/legacy",
      "refs/keiyaku/delivery/current",
      "refs/keiyaku/candidate/current",
    ]) assert.throws(() => raw.run(["show-ref", "--verify", "--quiet", ref]));
    assert.equal(raw.run(["show-ref", "--verify", "--quiet", "refs/heads/business-branch"]), "");
    assert.throws(() => raw.run(["show-ref", "--verify", "--quiet", "refs/heads/keiyaku-state"]));
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
    assert.throws(() => raw.run(["show-ref", "--verify", "--quiet", "refs/heads/keiyaku-state"]));
  } finally {
    raw.run(["worktree", "remove", "--force", path]);
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("owner failure becomes one diagnostic and leaves failed custody for retry", async () => {
  const world = await testWorld();
  try {
    const tasks = join(world, ".keiyaku", "tasks");
    writeFileSync(tasks, "not a directory\n");
    const result = await Keiyaku.nuke({ world, confirm: world });
    assert.equal(result.kind, "failed");
    assert.equal(result.world, world);
    assert.match(result.diagnostic, /ENOTDIR/u);
    assert.equal(readFileSync(tasks, "utf8"), "not a directory\n");
  } finally { rmSync(world, { recursive: true, force: true }); }
});

test("owner deletion attempts remain independent after the stop prerequisite", async () => {
  const fixture = await gitNukeFixture();
  try {
    const { raw, world, managedPath } = fixture;
    const tasks = join(world, ".keiyaku", "tasks");
    writeFileSync(tasks, "not a directory\n");
    const result = await Keiyaku.nuke({ world, confirm: world });
    assert.equal(result.kind, "failed");
    assert.equal(existsSync(managedPath), false);
    assert.throws(() => raw.run(["show-ref", "--verify", "--quiet", "refs/heads/keiyaku-state"]));
    assert.equal(readFileSync(tasks, "utf8"), "not a directory\n");
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
