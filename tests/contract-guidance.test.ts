import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderContractGuidance } from "../src/contract-guidance.js";
import { projectContractWorktree } from "../src/contract-worktree.js";
import { repositoryAt } from "../src/git/repository.js";
import { worktreePath } from "../src/git/workspace.js";
import { appointManagedWorktrees } from "../src/workspace-place.js";
import { repositoryWithMain } from "./support/library-verbs.js";
import {
  contractHead,
  contractId,
  documentKey,
  entryUlid,
  snapshotId,
  type ContractState,
} from "../src/core/facts/types.js";

const source = "# Guidance\r\n\r\n## Context\r\nExact source bytes.\r\n";

function state(currentArc: ContractState["currentArc"]): ContractState {
  return {
    id: contractId("kei/guidance"),
    head: contractHead("head"),
    coordinates: { start: snapshotId("start"), workspace: "worktree" },
    terms: {
      document: { bytes: source, key: documentKey("document") },
      segments: [],
      gates: [],
      requirements: {},
      after: [],
    },
    delivery: null,
    currentIntegration: null,
    attestations: [],
    ...(currentArc === undefined ? {} : { currentArc }),
    terminal: null,
  };
}

test("guidance inserts the current Arc before Fulfillment", () => {
  const guidance = renderContractGuidance(
    state({
      v: 1,
      kind: "arc",
      contract: contractId("kei/guidance"),
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      at: "2026-08-13T00:00:00.000Z",
      data: { seq: 2, title: "Second", body: "Continue.\n\nDo the next coherent work." },
    }),
  );

  assert.match(guidance, /^## Arc\n\n### Sequence\n\n2$/m);
  assert.match(guidance, /### Body\n\nContinue\.\n\nDo the next coherent work\./);
  assert.ok(guidance.indexOf("## Arc") < guidance.indexOf("## Fulfillment"));
});

test("guidance repair replaces read-only bytes, preserves protection, and retries unchanged", async () => {
  const repository = repositoryWithMain();
  const git = await repositoryAt(repository.path);
  const current = state(undefined);
  const register = await appointManagedWorktrees(git, [current.id]);
  const worktree = worktreePath(git, register.get(current.id)!);
  repository.run(["worktree", "add", "--detach", worktree, "HEAD"]);
  const path = join(worktree, ".keiyaku", "KEIYAKU.md");
  assert.deepEqual((await projectContractWorktree(git, current, register)).lag, []);
  const changed = { ...current, terms: { ...current.terms, document: { ...current.terms.document, bytes: "# Changed\n" } } };
  for (const next of [changed, current]) {
    const result = await projectContractWorktree(git, next, register);
    assert.deepEqual(result.lag, []);
    assert.equal(readFileSync(path, "utf8"), renderContractGuidance(next));
    assert.equal(statSync(path).mode & 0o222, 0);
    const before = statSync(path);
    const retry = await projectContractWorktree(git, next, register);
    assert.deepEqual(retry.lag, []);
    assert.equal(statSync(path).ino, before.ino);
  }
});

test("guidance repair leaves symlink targets alone and reports lag", { skip: process.platform === "win32" }, async () => {
  const repository = repositoryWithMain();
  const git = await repositoryAt(repository.path);
  const current = state(undefined);
  const register = await appointManagedWorktrees(git, [current.id]);
  const worktree = worktreePath(git, register.get(current.id)!);
  repository.run(["worktree", "add", "--detach", worktree, "HEAD"]);
  const path = join(worktree, ".keiyaku", "KEIYAKU.md");
  await projectContractWorktree(git, current, register);
  const target = join(worktree, "user-file");
  writeFileSync(target, "user data");
  chmodSync(target, 0o640);
  unlinkSync(path);
  symlinkSync(target, path);
  const result = await projectContractWorktree(git, current, register);
  assert.equal(result.lag[0]?.kind, "contract-file-failed");
  assert.equal(readFileSync(target, "utf8"), "user data");
  assert.equal(statSync(target).mode & 0o777, 0o640);
});
