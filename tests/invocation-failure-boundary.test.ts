import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withGitShim } from "./support/git.js";
import {
  KeiyakuError,
  AuthorityCorruptionError,
  Repo,
  Keis,
} from "../src/index.js";
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { createKeiHandle } from "../src/library/kei.js";
import { withOutcomeReceipt, projectFailure } from "../src/library/outcome.js";
import { captureLocalContractComposition } from "../src/library/contract-settings.js";
import { scopeForRepo } from "../src/library/repo.js";
import { SqliteTransactionLockError } from "../src/coordination/sqlite-transaction-lock.js";
import { contractId, type AttestationEntry } from "../src/core/facts/types.js";
import { projectSettings } from "../src/settings.js";
import { bind, commitCandidate, repositoryWithMain, present, accepted, document } from "./support/library-verbs.js";

// The captured native owner uses this repository-local capability; no global/module monkeypatch.
test("native review publications survive observer mutation and preserve independent evidence on conflict", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: null, gates: ["reviewed"] }));
  const id = bound.contractId;
  commitCandidate(repository, bound.worktreePath);
  accepted(await bound.kei.deliver());
  const base = scopeForRepo(repo);

  async function failReview(summary: string, mutateDuringObservation = false) {
    let seen: AttestationEntry | undefined;
    let failure: KeiyakuError | undefined;
    let armed = false;
    const original = new TypeError(`${summary}: trailing observation failed`);
    const native = createKeiHandle(
      id,
      {
        ...base,
        get gitPath() {
          if (armed) throw original;
          return base.gitPath;
        },
        onPrivateStateSeatClose() {
          armed = true;
          throw new SqliteTransactionLockError(`${summary}: publication seat close failed`, "release-failed");
        },
      },
      captureLocalContractComposition(),
    );
    await assert.rejects(
      native.review({ verdict: "unsatisfied", summary }, {
        observe(event) {
          if (event.kind !== "admitted" || event.fact.kind !== "attestation") return;
          seen = event.fact;
          if (mutateDuringObservation) Object.assign(seen.data, { summary: "observer's description" });
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof KeiyakuError && error.outcome?.kind === "contract");
        assert.equal(error.cause, original);
        failure = error;
        return true;
      },
    );
    assert.ok(seen && failure?.outcome?.kind === "contract");
    const { issues } = failure.outcome;
    assert.deepEqual(issues, [
      { kind: "diagnostic", severity: "required", diagnostic: `${summary}: publication seat close failed` },
    ]);
    const published = present(await bound.kei.state()).attestations.find((entry) => entry.entry === seen?.entry);
    assert.ok(published);
    assert.equal(published.data.summary, summary);
    return { seen, published, failure, issues };
  }

  const first = await failReview("First review");
  const second = await failReview("Second review", true);
  const inner = Object.freeze(first.failure);
  Object.assign(first.seen.data, { verdict: "satisfied" });
  assert.ok(bound.worktreePath);
  const movement = { kind: "worktree-created" as const, path: bound.worktreePath };
  const wrap = (...facts: readonly AttestationEntry[]) =>
    withOutcomeReceipt(inner, { kind: "contract", contractId: id, facts, effects: [movement], issues: second.issues });
  const leaf = { kind: "attestation" };
  assert.deepEqual(inner.outcome, { kind: "contract", contractId: id, admitted: [leaf], issues: first.issues });
  const expected = {
    kind: "contract",
    contractId: id,
    admitted: [leaf, leaf],
    effects: [movement],
    issues: [...first.issues, ...second.issues],
  };
  assert.deepEqual(wrap(first.published, second.published).outcome, expected);

  const conflict = wrap(first.seen, second.published);
  assert.ok(conflict instanceof AuthorityCorruptionError);
  assert.equal(conflict.category, "authority-corruption");
  assert.equal(conflict.cause, inner);
  assert.ok(conflict.outcome?.kind === "contract");
  const projected = projectFailure(conflict);
  assert.equal(projected.causeClass, "AuthorityCorruptionError");
  assert.equal(projected.diagnostic, "conflicting invocation receipt");
  assert.deepEqual(conflict.outcome, expected);
});

test("native delivery keeps an independent programming failure when the caller aborts", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: "main", gates: [] }));
  commitCandidate(repository);
  const controller = new AbortController();
  const original = new TypeError("Git capability failure after leading publication");
  const native = createKeiHandle(bound.contractId, {
    ...scopeForRepo(repo),
    onPrivateStateSeatClose() {
      Object.defineProperty(this, "gitPath", { get() {
        controller.abort();
        throw original;
      } });
    },
  }, captureLocalContractComposition());
  await assert.rejects(native.deliver({ signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError && error.outcome?.kind === "contract");
    assert.equal(error.category, "internal");
    assert.equal(error.cause, original);
    assert.ok(error.outcome.admitted?.some((fact) => fact.kind === "deliver"));
    return true;
  });
});

test("native Contract reads tag lawful absence while corrupt fork terms remain exceptional", async () => {
  const { decodeJournal, encodeEntry } = await import("../src/core/facts/codec.js");
  const { contractJournalPath } = await import("../src/git/identity.js");
  const { readGitPaths, updateGitTree, writeBlob, writeCommit, updateRefsAtomically, GIT_REF } = await import(
    "../src/git/repository.js"
  );
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const missing = Keis.of(repo).kei({ id: contractId("kei/missing") });
  assert.equal(await missing.state(), null);
  assert.deepEqual(await missing.history(), { kind: "contract-missing", contractId: contractId("kei/missing") });
  assert.deepEqual(await missing.guidance(), { kind: "missing" });
  assert.equal(await missing.delivery(), null);
  const source = await bind(repository);
  const id = present(await source.state()).id;
  const scope = scopeForRepo(repo);
  const journalPath = contractJournalPath(id, "active");
  const snapshot = await readGitPaths(scope, [journalPath]);
  const entries = decodeJournal(repository.run(["show", `${GIT_REF}:${journalPath}`]));
  const first = entries[0];
  assert.ok(first?.kind === "bind");
  const malformed = {
    ...first,
    data: {
      ...first.data,
      terms: {
        ...first.data.terms,
        document: { ...first.data.terms.document, bytes: "# Stored but undecodable terms\n" },
      },
    },
  };
  const tree = await updateGitTree(
    scope,
    snapshot.tree,
    new Map([[journalPath, { oid: await writeBlob(scope, encodeEntry(malformed)) }]]),
  );
  const commit = await writeCommit({ repository: scope, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(scope, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );
  await assert.rejects(Keis.of(repo).bind({ forkOf: id }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "authority-corruption");
    assert.ok(error.cause instanceof KeiyakuError);
    assert.equal(error.cause.category, "authority-corruption");
    assert.match(error.cause.message, /has an undecodable document/u);
    assert.ok(error.cause.cause instanceof KeiyakuError);
    assert.equal(error.cause.cause.category, "invalid-input");
    assert.ok(error.message.includes(id));
    return true;
  });
});

test("a pre-admission finite read failure keeps its native cause without claiming delivery", async () => {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({ terms: document(), gates: ["reviewed"] }),
  );
  const id = bound.contractId;
  assert.ok(bound.worktreePath);
  writeFileSync(join(bound.worktreePath, "dirty.txt"), "unadmitted bytes\n");
  await withGitShim(
    'if [ "$1 $2" = "cat-file --batch" ]; then "$KEIYAKU_REAL_GIT" "$@"; exit 73; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    {},
    async (gitPath) => {
      const native = Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({ id });
      await assert.rejects(native.deliver(), (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.category, "internal");
        assert.ok(error.cause instanceof Error);
        assert.equal(error.cause.name, "GitPlumbingError");
        assert.match(error.cause.message, /git exited with status 73/u);
        assert.ok(error.outcome?.kind === "contract");
        assert.equal(error.outcome.contractId, id);
        assert.equal(error.outcome.admitted, undefined);
        assert.equal(error.outcome.issues, undefined);
        assert.equal(classifyVerb("deliver", { contract: id }, { kind: "threw", error }), "failed");
        return true;
      });
    },
  );
  const state = present(await bound.kei.state());
  assert.equal(state.delivery, null);
  assert.equal(state.terminal, null);
  assert.equal(readFileSync(join(bound.worktreePath, "dirty.txt"), "utf8"), "unadmitted bytes\n");
});

test("native delivery retains an earlier completed checkout follow when a later checkout throws", async () => {
  const { rmSync } = await import("node:fs");
  const repository = repositoryWithMain();
  const sibling = `${repository.path}-other-checkout`;
  repository.run(["worktree", "add", "--quiet", "--force", sibling, "main"]);
  try {
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: "main", gates: [] }));
    assert.ok(bound.worktreePath);
    commitCandidate(repository, bound.worktreePath);
    const base = scopeForRepo(repo);
    const original = new TypeError("later checkout program failure");
    const [first, second] = [repository.path, sibling].sort((a, b) => a.localeCompare(b)) as [string, string];
    const reachedSecond = join(repository.path, ".git", "reached-second-checkout");
    await withGitShim(
      [
        'if [ "$1" = "-C" ] && [ "$2" = "$KEIYAKU_TEST_SECOND" ]; then',
        '  : > "$KEIYAKU_TEST_REACHED_SECOND"',
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_TEST_SECOND: second, KEIYAKU_TEST_REACHED_SECOND: reachedSecond },
      async (gitPath) => {
        const scope = {
          ...base,
          get gitPath(): string {
            if (existsSync(reachedSecond)) throw original;
            return gitPath;
          },
        };
        const native = createKeiHandle(bound.contractId, scope, captureLocalContractComposition());
        await assert.rejects(native.deliver(), (error: unknown) => {
          assert.ok(error instanceof KeiyakuError);
          assert.equal(error.cause, original);
          assert.equal(error.category, "internal");
          assert.ok(error.outcome?.kind === "contract");
          assert.ok(error.outcome.admitted?.some((fact) => fact.kind === "claimed"));
          const followed = error.outcome.effects?.filter((movement) => movement.kind === "target-checkout");
          assert.deepEqual(followed, [{ kind: "target-checkout", path: first, target: "refs/heads/main" }]);
          assert.equal(readFileSync(join(first, "candidate.txt"), "utf8"), "candidate\n");
          assert.ok(error.outcome.placement?.kind === "placed");
          assert.equal(repository.run(["-C", first, "rev-parse", "HEAD"]).trim(), error.outcome.placement.integration);
          assert.ok(!error.outcome.issues?.some((effect) => effect.kind === "target-checkout-retained"));
          return true;
        });
      },
    );
  } finally {
    repository.run(["worktree", "remove", "--force", sibling]);
    rmSync(sibling, { recursive: true, force: true });
  }
});

const failAfterTerminalRemoval = [
  'if [ "$1 $2" = "worktree remove" ]; then',
  '  "$KEIYAKU_REAL_GIT" "$@" || exit "$?"',
  '  touch "$KEIYAKU_REMOVAL_MARKER"',
  "  exit 0",
  "fi",
  'if [ -f "$KEIYAKU_REMOVAL_MARKER" ] && [ "$1 $2 $3" = "rev-parse --verify --quiet" ]; then',
  '  echo "broken-post-removal-object-identity"',
  "  exit 0",
  "fi",
  'exec "$KEIYAKU_REAL_GIT" "$@"',
].join("\n");

test("abandon keeps both ref-free recovery snapshots when cleanup throws after removal", async () => {
  const repository = repositoryWithMain();
  const marker = join(repository.path, ".git", "removed-before-broken-ref");
  mkdirSync(join(repository.path, ".keiyaku"), { recursive: true });
  writeFileSync(join(repository.path, ".keiyaku", "settings.json"), JSON.stringify({
    worktree: { destroy: [{ name: "destroy", argv: [process.execPath, "-e",
      'require("node:fs").writeFileSync("hook.txt", "hook bytes\\n")'], timeoutMs: 5_000 }] },
  }));
  const settings = await projectSettings(repository.path);
  await withGitShim(failAfterTerminalRemoval, { KEIYAKU_REMOVAL_MARKER: marker }, async (gitPath) => {
    const repo = await Repo.at({ path: repository.path, gitPath });
    const bound = accepted(await Keis.of(repo, { settings }).bind({ terms: document(), target: null, gates: [] }));
    assert.ok(bound.worktreePath);
    writeFileSync(join(bound.worktreePath, "authored.txt"), "authored bytes\n");
    await assert.rejects(bound.kei.abandon(), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError && error.outcome?.kind === "contract");
      assert.equal(error.outcome.contractId, bound.contractId);
      assert.deepEqual(error.outcome.admitted, [{ kind: "abandoned" }]);
      const snapshots = error.outcome.effects?.flatMap((effect) => effect.kind === "recovery-snapshot" ? [effect.snapshot] : []);
      assert.ok(snapshots);
      assert.equal(snapshots.length, 2);
      const [before, after] = snapshots;
      assert.equal(repository.run(["show", `${before}:authored.txt`]), "authored bytes\n");
      assert.equal(repository.run(["show", `${after}:authored.txt`]), "authored bytes\n");
      assert.equal(repository.run(["show", `${after}:hook.txt`]), "hook bytes\n");
      assert.equal(repository.run(["rev-parse", `${after}^`]).trim(), before);
      return true;
    });
    assert.equal(existsSync(bound.worktreePath), false);
  });
});
