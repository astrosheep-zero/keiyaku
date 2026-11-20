import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
import { snapshotId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { materializeScratchCandidate, removeCollectableScratchWorktrees } from "../src/git/scratch.js";
import { projectSettings } from "../src/settings.js";
import { executeVerification } from "../src/verification/execution.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { appointedWorktreePath } from "./support/git.js";

const SELECTED = { index: 1, total: 1, requirement: "fixture" } as const;

function ownershipLockFor(scratch: string): string {
  return join(realpathSync(tmpdir()), `.${basename(scratch)}.owner.sqlite`);
}

test("post-checkout cancellation physically retires the scratch and its custody", async () => {
  const raw = repositoryWithMain();
  const marker = join(raw.path, "checkout-started");
  const declarationMarker = join(raw.path, "declaration-ran");
  const declarationCommand = `touch '${declarationMarker.replaceAll("'", "'\\''")}'`;
  const hook = join(raw.path, ".git/hooks/post-checkout");
  const bound = accepted(
    await Keis.of(await Repo.at({ path: raw.path })).bind({
      terms: document(declarationCommand),
      gates: ["verified", "reviewed"],
    }),
  );
  const source = await appointedWorktreePath(await repositoryAt(raw.path), present(await bound.kei.state()).id);
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      'case "$PWD" in',
      "  */keiyaku-v4-verify-*)",
      `    printf '%s' "$PWD" > '${marker}.tmp'`,
      `    mv '${marker}.tmp' '${marker}'`,
      '    echo "post-checkout interrupted" >&2',
      "    while :; do sleep 1; done ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  const controller = new AbortController();
  const pending = executeVerification({
    repository: { ...(await repositoryAt(raw.path)), signal: controller.signal },
    candidate: snapshotId(raw.run(["-C", source, "rev-parse", "HEAD"]).trim()),
    contractId: present(await bound.kei.state()).id,
    ...SELECTED,
    declaration: { executor: "bash", script: declarationCommand },
    materializeScratchCandidate,
    projectSettings,
    signal: controller.signal,
  });
  try {
    const deadline = AbortSignal.timeout(10_000);
    while (!existsSync(marker)) {
      deadline.throwIfAborted();
      await setTimeout(10);
    }
    const scratch = readFileSync(marker, "utf8");
    // The hook is still running: add has registered and populated the worktree before it throws.
    assert.equal(existsSync(join(scratch, ".git")), true);
    assert.equal(existsSync(ownershipLockFor(scratch)), true);
    assert.ok(raw.run(["worktree", "list", "--porcelain"]).includes(scratch));
    controller.abort(new Error("cancel during post-checkout"));
    const result = await pending;
    assert.equal(result.outcome.kind, "cancelled", JSON.stringify(result));
    assert.equal(result.leak, undefined);
    assert.equal(existsSync(scratch), false);
    assert.equal(existsSync(ownershipLockFor(scratch)), false);
    assert.equal(raw.run(["worktree", "list", "--porcelain"]).includes(scratch), false);
    assert.equal(existsSync(join(source, ".git")), true);
    assert.equal(existsSync(declarationMarker), false);
    assert.equal(present(await bound.kei.state()).attestations.length, 0);
  } finally {
    controller.abort();
    await pending.catch(() => undefined);
    rmSync(hook, { force: true });
    if (existsSync(marker)) {
      const scratch = readFileSync(marker, "utf8");
      if (existsSync(scratch)) {
        const removals = await removeCollectableScratchWorktrees(await repositoryAt(raw.path), new Set([scratch]));
        assert.equal(removals[0]?.retained, false);
      }
    }
  }
});
