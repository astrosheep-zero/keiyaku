import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { Keis, Repo } from "../src/index.js";
import type { ReviewOutcome } from "../src/index.js";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import { contractJournalPath } from "../src/git/identity.js";
import {
  GIT_REF,
  readGitPaths,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import { cliJson } from "./support/cli-fixtures.js";
import { appointedWorktreePath, cachedRepositoryAt } from "./support/git.js";
import { document, repositoryWithMain, present, accepted } from "./support/library-verbs.js";

/** A committed candidate whose configured scratch setup always fails, producing a Verification runtime stop. */
function runtimeStopSettings(): string {
  return JSON.stringify({
    worktree: {
      create: [{ name: "reject-candidate", argv: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 5_000 }],
    },
  });
}

async function bindAndCommit(options: {
  gates: readonly string[];
  verification: string;
  runtimeStop?: boolean;
  target?: string;
}) {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      terms: document(options.verification),
      gates: options.gates,
      // These lifecycle fixtures are targetless unless a case names a target.
      target: options.target ?? null,
    }),
  );
  const state = present(await bound.kei.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  const paths = ["candidate.txt"];
  if (options.runtimeStop === true) {
    mkdirSync(join(worktree, ".keiyaku"), { recursive: true });
    writeFileSync(join(worktree, ".keiyaku", "settings.json"), runtimeStopSettings());
    paths.push(".keiyaku/settings.json");
  }
  repository.run(["-C", worktree, "add", ...paths]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  return { repository, keiyaku: bound.kei, state };
}

test("journal reads ignore unknown envelope and nested keys while append preserves original bytes", async () => {
  const { repository, keiyaku, state } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 0" });
  const git = await cachedRepositoryAt(repository.path);
  const path = contractJournalPath(state.id);
  const snapshot = await readGitPaths(git, [path]);
  const oid = snapshot.paths.get(path)?.oid;
  assert.ok(oid);
  const original = repository.run(["cat-file", "-p", oid]);
  const history = await keiyaku.history({ item: "1" });
  const extended = `{"additional":{"opaque":true},${original.slice(1)}`
    .replace('"data":{', '"data":{"additional":null,')
    .replace('"document":{', '"document":{"additional":"future",');
  assert.deepEqual(decodeJournal(extended), decodeJournal(original));
  assert.equal(encodeEntry(decodeJournal(extended)[0]!), original);
  assert.throws(() => decodeJournal(extended.replace('{"additional":', '{ "additional":')), /not canonical/u);

  const tree = await updateGitTree(git, snapshot.tree, new Map([[path, { oid: await writeBlob(git, extended) }]]));
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );
  assert.deepEqual(await keiyaku.history({ item: "1" }), history);
  const reviewed = await cliJson<ReviewOutcome>(
    ["-C", repository.path, "review", state.id, "--satisfied", "--summary", "ordinary review"],
    { environment: { KEIYAKU_ACTOR_ID: "aku/worker/f0d0a002", KEIYAKU_ACTOR_WORLD: repository.path } },
  );
  assert.equal(reviewed.exit, 0, reviewed.stderr);
  accepted(reviewed.value);
  const appended = repository.run(["show", `${GIT_REF}:${path}`]);
  assert.ok(appended.startsWith(extended), "admission must append without rewriting original bytes");
  const next = appended.slice(extended.length);
  const [entry] = decodeJournal(next);
  assert.ok(entry?.kind === "attestation");
  assert.equal(entry.data.summary, "ordinary review");
  assert.equal(encodeEntry(entry), next, "new writes contain only known content");
});

describe("contract-lifecycle verification blocking", { concurrency: 3 }, () => {
  test("pre-delivery verification captures the snapshot the later delivery and review place", async () => {
    const { keiyaku } = await bindAndCommit({ gates: ["reviewed", "verified"], verification: "exit 0" });
    const verified = accepted(await keiyaku.verify());
    const check = verified.checks[0];
    assert.ok(check?.kind === "terminal");
    assert.equal(check.verdict, "satisfied");
    assert.equal(check.admission, "admitted");
    assert.equal(present(await keiyaku.state()).attestations.length, 1);
    assert.equal(present(await keiyaku.state()).delivery, null);
    assert.equal(verified.placement?.kind, "delivery-missing");
    const delivered = accepted(await keiyaku.deliver());

    assert.equal(delivered.admission, undefined);
    assert.equal(delivered.integration, verified.snapshot);
    assert.ok(delivered.placement?.kind === "gates-unsatisfied");
    assert.equal(delivered.placement.unmet.some(({ gate }) => gate === "verified"), false);
    const reviewed = accepted(await keiyaku.review({ verdict: "satisfied", summary: "Lifecycle review passed" }));

    assert.ok(reviewed.placement?.kind === "placed");
    assert.equal(reviewed.placement.integration, verified.snapshot);
    assert.equal(present(await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("unfinished candidate reuse refuses unauthorized dirty content", async () => {
    const { repository, keiyaku, state } = await bindAndCommit({
      gates: ["verified"],
      verification: "exit 0",
      runtimeStop: true,
    });
    accepted(await keiyaku.deliver());
    const firstEntry = present(await keiyaku.state()).delivery!.entry;
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    writeFileSync(join(worktree, "candidate.txt"), "dirty replacement\n");

    const refused = await keiyaku.deliver();
    assert.equal(refused.kind, "refused");
    assert.ok(refused.kind === "refused");
    assert.equal(refused.reason.kind, "dirty-workspace");
    assert.equal(present(await keiyaku.state()).delivery?.entry, firstEntry);
  });
});
