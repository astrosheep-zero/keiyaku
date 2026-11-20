import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { contractId, type ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { observeContract } from "./support/git.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

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

test("CLI refuses --target together with --no-target", async () => {
  const raw = repositoryWithMain();
  await assert.rejects(
    () => runCli(["-C", raw.path, "bind", "--target", "main", "--no-target", "-"]),
    /--target and --no-target are mutually exclusive/u,
  );
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
});

test("an omitted target reads the explicit linked worktree coordinate, not the primary worktree", async () => {
  const raw = repositoryWithMain();
  const linked = join(raw.path, "linked-worktree");
  raw.run(["worktree", "add", "--quiet", "-b", "feature", linked]);
  const cli = await cliBind(linked);
  assert.equal(cli.value.kind, "accepted", JSON.stringify(cli.value));
  assert.ok(cli.value.contractId);
  assert.equal(await boundTarget(raw.path, contractId(cli.value.contractId)), "refs/heads/feature");
});
