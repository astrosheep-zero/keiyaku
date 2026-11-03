import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Akumas, Keiyaku, Repo, World } from "../src/index.js";
import { contractJournalPaths } from "../src/git/identity.js";
import { readGitPaths, repositoryAt, updateGitTree, writeCommit } from "../src/git/repository.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { parseArgv } from "../src/cli/parse.js";
import { bornLineageAkuma } from "./support/akuma-fixtures.js";
import { withContractWaitBarrier } from "./support/contract-wait.js";
import { withGitShim } from "./support/git.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";

async function fixture() {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const make = async (name: string) => {
    const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document().replace("# Library verbs", `# ${name}`), target: null, gates: ["reviewed"], workspace: "worktree" }));
    const handle = bound.value.keiyaku;
    return { handle, id: present(await handle.state()).id };
  };
  return { repository, repo, first: await make("First wait subject"), second: await make("Second wait subject") };
}

async function amend(handle: Keiyaku, objective: string) {
  accepted(await handle.amend({ markdown: `## Replace: Objective\n\n${objective}\n` }));
}

test("Contract waits witness their own journal changes and preserve plural progress", async () => {
  const { repository, repo, first, second } = await fixture();
  await withContractWaitBarrier(repository.path, async (barrier) => {
    const observingRepo = await Repo.at({ path: repository.path, gitPath: barrier.gitPath });
    barrier.reset();
    const pending = Keiyaku.with().wait({ repo: observingRepo, contracts: [first.id, second.id, first.id], completion: "all", timeoutMs: 10_000 });
    await barrier.reads();
    await amend(first.handle, "First observed change.");
    barrier.reset();
    await barrier.reads(2);
    await amend(second.handle, "Second observed change.");
    const result = await pending;
    assert.equal(result.kind, "changed");
    assert.equal(result.completion, "all");
    assert.deepEqual(result.contracts.map((item) => item.contract), [first.id, second.id]);
    assert.ok(result.contracts.every((item) => item.changed && item.head !== item.baseline && item.present === true && item.terminal === null));

    barrier.reset();
    const any = Keiyaku.with().wait({ repo: observingRepo, contracts: [first.id, second.id], timeoutMs: 10_000 });
    await barrier.reads();
    await amend(second.handle, "Any mode wakes for this subject.");
    const anyResult = await any;
    assert.equal(anyResult.kind, "changed");
    assert.equal(anyResult.completion, "any");
    assert.deepEqual(anyResult.contracts.map((item) => item.changed), [false, true]);

    barrier.reset();
    const progress = Keiyaku.with().wait({ repo: observingRepo, contracts: [first.id, second.id], completion: "all", timeoutMs: 1800 });
    await barrier.reads();
    await amend(first.handle, "Another observed change.");
    const deadline = await progress;
    assert.equal(deadline.kind, "deadline");
    assert.deepEqual(deadline.contracts.map((item) => item.changed), [true, false]);
  });
  assert.equal((await first.handle.wait({ timeoutMs: 0 })).kind, "deadline");
  const missing = await Keiyaku.with().wait({ repo, contracts: [first.id, "kei/not-present"], timeoutMs: 0 });
  assert.equal(missing.kind, "missing");
  assert.equal(missing.contracts[1]?.present, false);
  accepted(await second.handle.abandon());
  const terminal = await second.handle.wait({ timeoutMs: 300 });
  assert.equal(terminal.kind, "deadline");
  assert.equal(terminal.contracts[0]?.terminal, "abandoned");
  assert.equal(terminal.contracts[0]?.changed, false);
});

test("other journals, Dispatch, worker completion, worktree edits and target movement do not wake a Contract", async () => {
  const { repository, repo, first, second } = await fixture();
  const world = await World.at(repository.path);
  await withContractWaitBarrier(repository.path, async (barrier) => {
    const observingRepo = await Repo.at({ path: repository.path, gitPath: barrier.gitPath });
    barrier.reset();
    const pending = Keiyaku.with().select({ repo: observingRepo, id: first.id }).wait({ timeoutMs: 3000 });
    await barrier.reads();
    const worker = await bornLineageAkuma({ root: world, archetype: "worker", draw: "1234abcd", createdAt: "2026-08-18T00:00:00.000Z" });
    await publishDispatch({ repository: await repositoryAt(repository.path), akuId: worker.id, contractId: first.id });
    const completed = await Akumas.of(world).wait({ akuma: [worker.id], timeoutMs: 0 });
    assert.equal(completed.reason, "completed");
    const killed = await Akumas.of(world).kill({ akuma: [first.id], repo });
    assert.equal(killed.results[0]?.id, worker.id);
    await amend(second.handle, "Other Contract changes.");
    writeFileSync(join(repository.path, "unrelated.txt"), "worktree edit\n");
    repository.run(["add", "unrelated.txt"]);
    repository.run(["commit", "--quiet", "-m", "unrelated target movement"]);
    const result = await pending;
    assert.equal(result.kind, "deadline");
    assert.equal(result.contracts[0]?.changed, false);
  });
});

test("disappearance after baseline is missing, never change success", async () => {
  const { repository, first } = await fixture();
  await withContractWaitBarrier(repository.path, async (barrier) => {
    const observingRepo = await Repo.at({ path: repository.path, gitPath: barrier.gitPath });
    barrier.reset();
    const pending = Keiyaku.with().select({ repo: observingRepo, id: first.id }).wait({ timeoutMs: 10_000 });
    await barrier.reads();
    const git = await repositoryAt(repository.path);
    const paths = contractJournalPaths(first.id);
    const before = await readGitPaths(git, paths);
    assert.notEqual(before.commit, null);
    const tree = await updateGitTree(git, before.tree, new Map(paths.map((path) => [path, null])));
    const commit = await writeCommit({ repository: git, tree, parent: before.commit });
    repository.run(["update-ref", "refs/heads/keiyaku-state", commit, before.commit!]);
    const result = await pending;
    assert.equal(result.kind, "missing");
    assert.equal(result.contracts[0]?.present, false);
    assert.equal(result.contracts[0]?.changed, false);
    assert.notEqual(result.contracts[0]?.baseline, null);
  });
});

test("initial reads honor deadlines and cancellation; inputs and Akuma selectors are validated", async () => {
  const { repository, repo, first } = await fixture();
  await withGitShim('if [ "$1 $2" = "cat-file --batch" ]; then exec sleep 30; fi\nexec "$KEIYAKU_REAL_GIT" "$@"', {}, async (gitPath) => {
    const slow = await Repo.at({ path: repository.path, gitPath });
    const started = performance.now();
    const result = await Keiyaku.with().wait({ repo: slow, contracts: [first.id], timeoutMs: 150 });
    assert.equal(result.kind, "deadline");
    assert.equal(result.contracts[0]?.present, null);
    assert.ok(performance.now() - started < 5000);
    const cli = await runCli(["--repo", repository.path, "wait", first.id, "--timeout", "150ms"], {
      cwd: repository.path, environment: { KEIYAKU_GIT_PATH: gitPath },
    });
    assert.equal(cli.exit, 0);
    assert.match(cli.stdout, /unobserved/u);
  });
  await withContractWaitBarrier(repository.path, async (barrier) => {
    const observingRepo = await Repo.at({ path: repository.path, gitPath: barrier.gitPath });
    const controller = new AbortController();
    barrier.reset();
    const pending = Keiyaku.with().select({ repo: observingRepo, id: first.id }).wait({ signal: controller.signal });
    await barrier.reads();
    controller.abort();
    await assert.rejects(pending);
  });
  await assert.rejects(Keiyaku.with().wait({ repo, contracts: [] }), /nonempty/u);
  await assert.rejects(Keiyaku.with().wait({ repo, contracts: ["not-a-contract"] }), /contract ID/u);
  await assert.rejects(Keiyaku.with().wait({ repo, contracts: [first.id], timeoutMs: -1 }), /timeoutMs/u);
  await assert.rejects(Keiyaku.with().wait({ repo, contracts: [first.id], completion: null as never }), /completion/u);
  const world = await World.at(repository.path);
  await assert.rejects(Akumas.of(world).wait({ akuma: [first.id], repo, timeoutMs: 0 }), /does not accept Contract/u);
});

test("CLI Contract waits need no Akuma World and mixed families refuse", async (context) => {
  const { repository, first } = await fixture();
  const cwd = mkdtempSync(join(tmpdir(), "contract-wait-no-world-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, ".keiyaku"), "not a World directory");
  await withContractWaitBarrier(repository.path, async (barrier) => {
    const environment = { KEIYAKU_GIT_PATH: barrier.gitPath };
    const json = await cliJson<{ kind: string; contracts: { contract: string }[] }>(["--repo", repository.path, "wait", first.id, "--timeout", "0ms"], { environment, cwd });
    assert.equal(json.exit, 0);
    assert.equal(json.value.kind, "deadline");
    assert.equal(json.value.contracts[0]?.contract, first.id);
    barrier.reset();
    const observing = cliJson<{ kind: string; contracts: { contract: string; changed: boolean }[] }>(["--repo", repository.path, "wait", first.id, "--timeout", "10s"], { environment, cwd });
    await barrier.reads();
    await amend(first.handle, "CLI witnessed journal admission.");
    const changed = await observing;
    assert.equal(changed.exit, 0);
    assert.equal(changed.value.kind, "changed");
    assert.equal(changed.value.contracts[0]?.changed, true);
    const missing = await runCli(["--repo", repository.path, "wait", "kei/not-present", "--timeout", "0ms"], { environment, cwd });
    assert.notEqual(missing.exit, 0);
    assert.match(missing.stdout + missing.stderr, /kei\/not-present/u);
    assert.throws(() => parseArgv(["--repo", repository.path, "wait", first.id, "@worker"]), /cannot mix Contract and Akuma/u);
  });
});
