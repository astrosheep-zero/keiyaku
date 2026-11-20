import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
import { readRef, repositoryAt } from "../src/git/repository.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { appointedWorktreePath, candidatePinRefFor, deliveryRefFor } from "./support/git.js";

async function withPlaceWritesBlocked<T>(git: Awaited<ReturnType<typeof repositoryAt>>, run: () => Promise<T>) {
  const directory = join(git.commonDirectory, "keiyaku");
  chmodSync(directory, 0o555);
  try {
    return await run();
  } finally {
    chmodSync(directory, 0o755);
  }
}

test("rewritten target history repairs missing custody without reporting target movement", async () => {
  const repository = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo).bind({ terms: document(), target: "refs/heads/main", gates: ["reviewed"] }),
  );
  const contract = bound.kei;
  const state = present(await contract.state());
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), state.id);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await contract.deliver();
  writeFileSync(join(repository.path, "target-only.txt"), "target only\n");
  repository.run(["add", "target-only.txt"]);
  repository.run(["commit", "--quiet", "-m", "target only"]);
  const git = await repositoryAt(repository.path);
  await withPlaceWritesBlocked(git, () =>
    contract.review({ verdict: "satisfied", summary: "Reconciliation review passed" }),
  );
  const reviewed = present(await contract.state());
  assert.equal(reviewed.terminal?.kind, "claimed");
  assert.equal(existsSync(worktree), false);
  assert.equal((await readManagedWorktreeAppointment(git, reviewed.id)).kind, "appointed");
  const tender = reviewed.delivery?.data.tenderSnapshot;
  const integration = reviewed.currentIntegration?.snapshot ?? reviewed.delivery?.data.integration.snapshot;
  assert.ok(tender);
  assert.ok(integration);
  assert.notEqual(tender, integration);
  repository.run(["update-ref", "-d", deliveryRefFor(reviewed.id)]);
  repository.run(["update-ref", "-d", candidatePinRefFor(reviewed.id)]);
  const tree = repository.run(["rev-parse", "HEAD^{tree}"]).trim();
  const rewritten = repository.run(["commit-tree", tree, "-m", "rewritten target"]).trim();
  repository.run(["update-ref", "refs/heads/main", rewritten]);

  const report = await Keis.of(repo).reconcile({ contract: reviewed.id });
  assert.ok(report.kind === "contract");
  assert.deepEqual(report.effects, [
    { kind: "ref", name: deliveryRefFor(reviewed.id), before: null, after: tender },
    { kind: "ref", name: candidatePinRefFor(reviewed.id), before: null, after: integration },
  ]);
  assert.equal(await readRef(git, deliveryRefFor(reviewed.id)), tender);
  assert.equal(await readRef(git, candidatePinRefFor(reviewed.id)), integration);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), rewritten);
  assert.equal((report.issues ?? []).length, 0);
});
