import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { GIT_REF, readRef, repositoryAt, updateRefsAtomically, writeCommit } from "../src/git/repository.js";
import { repositoryWithCommit } from "./support/git.js";

test("a linked worktree HEAD and state ref share one expected-head transaction", async () => {
  const raw = repositoryWithCommit();
  const path = join(mkdtempSync(join(tmpdir(), "keiyaku-target-ref-")), "parent");
  raw.run(["worktree", "add", "--quiet", "--detach", path]);
  const repository = await repositoryAt(raw.path);
  const admin = raw.run(["-C", path, "rev-parse", "--path-format=absolute", "--git-dir"]).trim();
  const ref = `worktrees/${basename(admin)}/HEAD`;
  const initial = raw.run(["rev-parse", "HEAD"]).trim();
  const tree = raw.run(["rev-parse", "HEAD^{tree}"]).trim();
  const next = await writeCommit({ repository, tree, parent: initial, message: "landed" });
  const state = await writeCommit({ repository, tree, parent: initial, message: "state" });
  const replacement = await writeCommit({ repository, tree, parent: state, message: "next state" });

  assert.equal(
    (await updateRefsAtomically(repository, [{ ref: GIT_REF, newOid: state, expectedOid: null }])).kind,
    "published",
  );
  assert.equal(
    (
      await updateRefsAtomically(repository, [
        { ref: GIT_REF, newOid: replacement, expectedOid: state },
        { ref, newOid: next, expectedOid: next },
      ])
    ).kind,
    "non-published",
  );
  assert.equal(await readRef(repository, GIT_REF), state);
  assert.equal(await readRef(repository, ref), initial);

  assert.equal(
    (
      await updateRefsAtomically(repository, [
        { ref: GIT_REF, newOid: replacement, expectedOid: state },
        { ref, newOid: next, expectedOid: initial },
      ])
    ).kind,
    "published",
  );
  assert.equal(await readRef(repository, GIT_REF), replacement);
  assert.equal(await readRef(repository, ref), next);
  assert.equal(raw.run(["-C", path, "rev-parse", "HEAD"]).trim(), next);
  await assert.rejects(readRef(repository, "worktrees/parent/../HEAD"), /invalid Git ref/u);
});
