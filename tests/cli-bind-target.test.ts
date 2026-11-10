import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { contractId, type ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { Keis, Repo } from "../src/index.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { parseArgv, renderHelp } from "../src/cli/parse.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { makeGitRepository, observeContract } from "./support/git.js";

type BindValue = Readonly<{ kind: string; contractId?: string; reason?: Readonly<{ kind: string }> }>;

async function cliBind(path: string, extra: readonly string[] = []) {
  return await cliJson<BindValue>(["-C", path, "bind", "--gates", "", ...extra, "-"], {
    environment: {},
    readStdin: async () => document(),
  });
}

async function boundTarget(
  path: string,
  id: ContractId,
): Promise<import("../src/core/facts/types.js").ContractTarget | undefined> {
  return (await observeContract(await repositoryAt(path), id)).state?.coordinates.target;
}

test("CLI markdown bind without --target targets the attached invocation branch", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const start = raw.run(["rev-parse", "HEAD"]).trim();
  const bound = await cliBind(raw.path);
  assert.equal(bound.value.kind, "accepted", JSON.stringify(bound.value));
  assert.ok(bound.value.contractId);
  const observed = await observeContract(await repositoryAt(raw.path), contractId(bound.value.contractId));
  assert.equal(observed.state?.coordinates.target, "refs/heads/main");
  assert.equal(observed.state?.coordinates.start, start);
});

test("CLI and SDK share the one omitted-target default", async () => {
  const raw = repositoryWithMain();
  const cli = await cliBind(raw.path);
  assert.equal(cli.value.kind, "accepted", JSON.stringify(cli.value));
  assert.ok(cli.value.contractId);
  const sdk = accepted(
    await Keis.of(await Repo.at({ path: raw.path })).bind({ markdown: document(), workspace: "worktree", gates: [] }),
  );
  const sdkState = present(await sdk.kei.state());
  assert.equal(sdkState.coordinates.target, "refs/heads/main");
  assert.equal(await boundTarget(raw.path, contractId(cli.value.contractId)), sdkState.coordinates.target);
});

test("CLI --no-target binds without a target on an attached HEAD", async () => {
  const raw = repositoryWithMain();
  const bound = await cliBind(raw.path, ["--no-target"]);
  assert.equal(bound.value.kind, "accepted", JSON.stringify(bound.value));
  assert.ok(bound.value.contractId);
  assert.equal(await boundTarget(raw.path, contractId(bound.value.contractId)), undefined);
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
  assert.ok(bound.value.contractId);
  assert.equal(await boundTarget(raw.path, contractId(bound.value.contractId)), undefined);
});

test("CLI markdown bind without --target on an unborn HEAD refuses unborn-head", async () => {
  const raw = makeGitRepository();
  const bound = await cliBind(raw.path);
  assert.equal(bound.value.kind, "refused", JSON.stringify(bound.value));
  assert.equal(bound.value.reason?.kind, "unborn-head");
});

test("CLI markdown bind keeps an explicit --target literal", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  raw.run(["branch", "release"]);
  const bound = await cliBind(raw.path, ["--target", "release"]);
  assert.equal(bound.value.kind, "accepted", JSON.stringify(bound.value));
  assert.ok(bound.value.contractId);
  assert.equal(await boundTarget(raw.path, contractId(bound.value.contractId)), "refs/heads/release");
  const missing = await cliBind(raw.path, ["--target", "missing"]);
  assert.equal(missing.value.kind, "refused", JSON.stringify(missing.value));
  assert.equal(missing.value.reason?.kind, "target-missing");
});

test("CLI selects a complete Contract identity and preserves the kei-named branch escape", async () => {
  const raw = repositoryWithMain();
  const parent = await cliBind(raw.path);
  assert.equal(parent.value.kind, "accepted");
  assert.ok(parent.value.contractId);
  const child = await cliBind(raw.path, ["--target", parent.value.contractId]);
  assert.equal(child.value.kind, "accepted", JSON.stringify(child.value));
  assert.ok(child.value.contractId);
  const target = await boundTarget(raw.path, contractId(child.value.contractId));
  assert.equal(typeof target, "object");
  if (typeof target !== "object" || target === null) throw new Error("missing typed target");
  assert.equal(target.contractId, parent.value.contractId);
  assert.equal(JSON.parse(child.stdout).target, parent.value.contractId);
  const malformed = await cliBind(raw.path, ["--target", "kei/"]);
  assert.equal(malformed.value.kind, "refused");
  assert.equal(malformed.value.reason?.kind, "invalid-target");
  raw.run(["branch", "kei/example"]);
  const branch = await cliBind(raw.path, ["--target", "refs/heads/kei/example"]);
  assert.equal(branch.value.kind, "accepted", JSON.stringify(branch.value));
  assert.ok(branch.value.contractId);
  assert.equal(await boundTarget(raw.path, contractId(branch.value.contractId)), "refs/heads/kei/example");
  const help = parseArgv(["bind", "--help"]);
  assert.ok("help" in help);
  assert.match(renderHelp(help.help), /active kei\/\.\.\./u);
});

test("an omitted target reads the explicit linked worktree coordinate, not the primary worktree", async () => {
  const raw = repositoryWithMain();
  const linked = join(raw.path, "linked-worktree");
  raw.run(["worktree", "add", "--quiet", "-b", "feature", linked]);
  const repo = await Repo.at({ path: linked });
  assert.equal(repo.root, raw.path);
  assert.equal(repo.cwd, await realpath(linked));
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), workspace: "worktree", gates: [] }));
  assert.equal(present(await bound.kei.state()).coordinates.target, "refs/heads/feature");
  const cli = await cliBind(linked);
  assert.equal(cli.value.kind, "accepted", JSON.stringify(cli.value));
  assert.ok(cli.value.contractId);
  assert.equal(await boundTarget(raw.path, contractId(cli.value.contractId)), "refs/heads/feature");
});
