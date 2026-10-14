import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { contractId, type ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { Keiyaku, Repo } from "../src/index.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { makeGitRepository, observeContract } from "./support/git.js";

type BindValue = Readonly<{
  kind: string;
  contract?: string;
  refusal?: Readonly<{ kind: string }>;
}>;

/**
 * Run the real CLI bind edge over the invocation repository. `--gates ""` keeps the sentinel on
 * target selection alone: an explicit empty selection never demands a Verification declaration.
 */
async function cliBind(path: string, extra: readonly string[] = []) {
  return await cliJson<BindValue>(["-C", path, "bind", "--gates", "", ...extra, "-"], {
    environment: {},
    readStdin: async () => document(),
  });
}

async function boundTarget(path: string, contract: ContractId): Promise<string | undefined> {
  const observed = await observeContract(await repositoryAt(path), contract);
  return observed.state?.coordinates.target;
}

test("CLI markdown bind without --target targets the attached invocation branch", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const start = raw.run(["rev-parse", "HEAD"]).trim();

  const bound = await cliBind(raw.path);
  assert.equal(bound.value.kind, "accepted", JSON.stringify(bound.value));
  assert.ok(bound.value.contract);
  const observed = await observeContract(await repositoryAt(raw.path), contractId(bound.value.contract));
  assert.equal(observed.state?.coordinates.target, "refs/heads/main");
  assert.equal(observed.state?.coordinates.start, start);
});

test("CLI and SDK share the one omitted-target default", async () => {
  const raw = repositoryWithMain();
  const fromCli = await cliBind(raw.path);
  assert.equal(fromCli.value.kind, "accepted", JSON.stringify(fromCli.value));
  assert.ok(fromCli.value.contract);

  const fromSdk = accepted(
    await Keiyaku.with().bind({
      repo: await Repo.at({ path: raw.path }),
      markdown: document(),
      workspace: "worktree",
      gates: [],
    }),
  );
  const sdkState = present(await fromSdk.value.keiyaku.state());
  assert.equal(sdkState.coordinates.target, "refs/heads/main");
  assert.equal(
    await boundTarget(raw.path, contractId(fromCli.value.contract)),
    sdkState.coordinates.target,
  );
});

test("CLI --no-target binds without a target on an attached HEAD", async () => {
  const raw = repositoryWithMain();
  const bound = await cliBind(raw.path, ["--no-target"]);
  assert.equal(bound.value.kind, "accepted", JSON.stringify(bound.value));
  assert.ok(bound.value.contract);
  assert.equal(await boundTarget(raw.path, contractId(bound.value.contract)), undefined);
});

test("CLI refuses --target together with --no-target", async () => {
  const raw = repositoryWithMain();
  await assert.rejects(
    () => runCli(["-C", raw.path, "bind", "--target", "main", "--no-target", "-"]),
    /--target and --no-target are mutually exclusive/u,
  );
  await assert.rejects(() => runCli(["-C", raw.path, "bind", "--no-target", "--no-target", "-"]), /duplicate option/u);
});

test("CLI markdown bind without --target on a detached HEAD stays targetless", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  raw.run(["checkout", "--quiet", "--detach"]);

  const bound = await cliBind(raw.path);
  assert.equal(bound.value.kind, "accepted", JSON.stringify(bound.value));
  assert.ok(bound.value.contract);
  assert.equal(await boundTarget(raw.path, contractId(bound.value.contract)), undefined);
});

test("CLI markdown bind without --target on an unborn HEAD refuses unborn-head", async () => {
  const raw = makeGitRepository();

  const bound = await cliBind(raw.path);
  assert.equal(bound.value.kind, "refused", JSON.stringify(bound.value));
  assert.equal(bound.value.refusal?.kind, "unborn-head");
});

test("CLI markdown bind keeps an explicit --target literal", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  raw.run(["branch", "release"]);

  const bound = await cliBind(raw.path, ["--target", "release"]);
  assert.equal(bound.value.kind, "accepted", JSON.stringify(bound.value));
  assert.ok(bound.value.contract);
  assert.equal(await boundTarget(raw.path, contractId(bound.value.contract)), "refs/heads/release");

  const missing = await cliBind(raw.path, ["--target", "missing"]);
  assert.equal(missing.value.kind, "refused", JSON.stringify(missing.value));
  assert.equal(missing.value.refusal?.kind, "target-missing");
});

test("an omitted target reads the explicit linked worktree coordinate, not the primary worktree", async () => {
  const raw = repositoryWithMain();
  const linked = join(raw.path, "linked-worktree");
  raw.run(["worktree", "add", "--quiet", "-b", "feature", linked]);

  const repo = await Repo.at({ path: linked });
  assert.equal(repo.root, raw.path);
  assert.equal(repo.cwd, await realpath(linked));

  const bound = accepted(
    await Keiyaku.with().bind({ repo, markdown: document(), workspace: "worktree", gates: [] }),
  );
  assert.equal(present(await bound.value.keiyaku.state()).coordinates.target, "refs/heads/feature");

  const fromCli = await cliBind(linked);
  assert.equal(fromCli.value.kind, "accepted", JSON.stringify(fromCli.value));
  assert.ok(fromCli.value.contract);
  assert.equal(await boundTarget(raw.path, contractId(fromCli.value.contract)), "refs/heads/feature");
});
