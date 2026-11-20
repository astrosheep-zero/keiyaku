import { acceptedDelivery, managedCandidate, repositoryWithMain, TARGET_PLACEMENT_FILES } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";

test("a native untracked collision keeps the whole predecessor until reconciliation follows", async () => {
  const repository = repositoryWithMain({ files: TARGET_PLACEMENT_FILES });
  const { contract, id, path: candidatePath } = await managedCandidate(repository, []);
  writeFileSync(resolve(candidatePath, "incoming.txt"), "candidate\n");
  repository.run(["-C", candidatePath, "add", "incoming.txt"]);
  repository.run(["-C", candidatePath, "commit", "--quiet", "-m", "add incoming"]);
  const index = readFileSync(resolve(repository.path, ".git", "index"));
  writeFileSync(resolve(repository.path, "incoming.txt"), "local untracked\n");

  const delivered = acceptedDelivery(await contract.deliver());
  assert.equal(delivered.placement?.kind, "placed");
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
  assert.ok((delivered.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"));
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "base\n");
  assert.equal(repository.run(["show", ":delivered.txt"]), "base\n");
  assert.equal(readFileSync(resolve(repository.path, "incoming.txt"), "utf8"), "local untracked\n");
  assert.deepEqual(readFileSync(resolve(repository.path, ".git", "index")), index);

  rmSync(resolve(repository.path, "incoming.txt"));
  const reconciled = await Keis.of(await Repo.at({ path: repository.path })).reconcile({ contract: id });
  assert.ok(reconciled.kind === "contract");
  assert.ok(!reconciled.issues?.some((issue) => issue.kind === "target-checkout-retained"));
  assert.deepEqual(
    (reconciled.effects ?? []).filter((effect) => effect.kind === "target-checkout"),
    [{ kind: "target-checkout", path: repository.path, target: "refs/heads/main" }],
  );
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(resolve(repository.path, "incoming.txt"), "utf8"), "candidate\n");
  assert.equal(repository.run(["status", "--porcelain"]), "");
});
