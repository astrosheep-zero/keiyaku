import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { candidatePinRefFor, deliveryRefFor, withGitShim } from "./support/git.js";
import { KeiyakuError, AuthorityCorruptionError, Repo, Keiyaku } from "../src/index.js";
import { createKeiyakuHandle, captureLocalContractComposition } from "../src/library/keiyaku.js";
import { scopeForRepo } from "../src/library/repo.js";
import { localExecutionContext } from "../src/akuma/requests.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { executionStop } from "../src/protocol/progress.js";
import { actorId, contractId } from "../src/core/facts/types.js";
import { bind, commitCandidate, repositoryWithMain, present, accepted, document } from "./support/library-verbs.js";

// The captured native owner uses this repository-local capability; no global/module monkeypatch.
test("native delivery propagates lower programming and corruption failures after confirmed publication", async () => {
  for (const original of [
    new TypeError("broken lower target observation"),
    new AuthorityCorruptionError("broken lower authority"),
  ]) {
    const repository = repositoryWithMain();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(
      await Keiyaku.with().bind({
        repo,
        markdown: (await import("./support/library-verbs.js")).document(),
        target: "main",
        gates: [],
      }),
    );
    const id = present(await bound.value.keiyaku.state()).id;
    commitCandidate(repository);
    let armed = false;
    const base = scopeForRepo(repo);
    const scope = {
      ...base,
      get gitPath(): string {
        if (armed) throw original;
        return base.gitPath;
      },
      onPrivateStateSeatClose: () => {
        armed = true;
      },
    };
    const native = createKeiyakuHandle(id, scope, localExecutionContext(), captureLocalContractComposition());
    await assert.rejects(native.deliver(), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, original instanceof AuthorityCorruptionError ? "authority-corruption" : "internal");
      assert.equal(error.cause, original);
      assert.equal(error.outcome?.operation, "deliver");
      assert.ok(error.outcome !== undefined && "facts" in error.outcome);
      assert.ok(error.outcome.facts.some((fact) => fact.contract === id && fact.kind === "deliver"));
      assert.equal(
        error.outcome.effects.some((effect) => effect.kind === "execution-stopped"),
        false,
      );
      return true;
    });
  }
});

test("native delivery never treats an aborted signal as proof that an independent programming failure was cancellation", async () => {
  const repository = repositoryWithMain();
  const bound = await bind(repository);
  commitCandidate(repository);
  const repo = await Repo.at({ path: repository.path });
  const base = scopeForRepo(repo);
  const controller = new AbortController();
  const original = new TypeError("composition failure after leading publication");
  let armed = false;
  const scope = {
    ...base,
    onPrivateStateSeatClose: () => {
      armed = true;
      controller.abort();
    },
  };
  const composition = {
    ...captureLocalContractComposition(),
    get actor() {
      if (armed) throw original;
      return actorId("test");
    },
  };
  const native = createKeiyakuHandle(present(await bound.state()).id, scope, localExecutionContext(), composition);
  await assert.rejects(native.deliver({ signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "internal");
    assert.equal(error.cause, original);
    assert.ok(error.outcome !== undefined && "facts" in error.outcome);
    assert.ok(error.outcome.facts.some((fact) => fact.kind === "deliver"));
    return true;
  });
  assert.throws(
    () => executionStop(contractId("kei/independent"), "verification", original, controller.signal),
    (error) => error === original,
  );
});

test("decode-channel teardown never replaces the original failure, including a thrown undefined", async () => {
  const repository = repositoryWithMain();
  const scope = scopeForRepo(await Repo.at({ path: repository.path }));
  await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@"',
      "  exit 73",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      for (const original of [new TypeError("original failure before failed retirement"), undefined]) {
        let caught = false;
        let retirement: unknown;
        try {
          await withGitDecodeChannel(
            { ...scope, gitPath },
            async (channel) => {
              await channel.readObjects(["0".repeat(40)]);
              throw original;
            },
            (error) => {
              retirement = error;
            },
          );
        } catch (error) {
          caught = true;
          assert.equal(error, original);
        }
        assert.equal(caught, true);
        assert.ok(retirement instanceof Error);
        assert.match(retirement.message, /git cat-file --batch did not close cleanly/u);
      }
    },
  );
});

test("native delivery keeps claim and movement when the optional scope observation throws, without reading twice", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document(), target: "main", gates: [] }));
  const id = present(await bound.value.keiyaku.state()).id;
  commitCandidate(repository);
  const original = new TypeError("broken optional diffstat observation");
  const base = scopeForRepo(repo);
  let claimed = false;
  let armed = false;
  let reads = 0;
  const scope = {
    ...base,
    get gitPath(): string {
      if (armed) {
        reads += 1;
        throw original;
      }
      return base.gitPath;
    },
  };
  const native = createKeiyakuHandle(id, scope, localExecutionContext(), captureLocalContractComposition());
  await assert.rejects(
    native.deliver(
      {},
      {
        observe: (event) => {
          if (event.kind === "admitted" && event.fact.kind === "claimed") claimed = true;
          if (claimed && event.kind === "stage" && event.stage === "placement" && event.state === "finished")
            armed = true;
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, "internal");
      assert.equal(error.cause, original);
      assert.ok(error.outcome?.operation === "deliver");
      assert.ok(error.outcome.facts.some((fact) => fact.kind === "claimed"));
      assert.ok(error.outcome.value?.completion?.integration);
      assert.equal(error.outcome.value.completion.target, "refs/heads/main");
      return true;
    },
  );
  assert.equal(reads, 1, "failed optional observation cannot rerun completion or presentation");
});

test("native review retains an earlier claimed sibling when a later continuation throws", async () => {
  const repository = repositoryWithMain();
  const primary = await bind(repository);
  const repo = await Repo.at({ path: repository.path });
  const primaryId = present(await primary.state()).id;
  const child = async (title: string) =>
    accepted(
      await Keiyaku.with().bind({
        repo,
        markdown: document().replace("# Library verbs", "# " + title),
        gates: [],
        after: [primaryId],
      }),
    ).value.keiyaku;
  const left = await child("Earlier sibling");
  const right = await child("Later sibling");
  const childIds = [present(await left.state()).id, present(await right.state()).id].sort();
  accepted(await left.deliver());
  accepted(await right.deliver());
  accepted(await primary.deliver());
  const base = scopeForRepo(repo);
  const original = new TypeError("later sibling program failure");
  let firstClaimed = false;
  let armed = false;
  const scope = {
    ...base,
    get gitPath(): string {
      if (armed) throw original;
      return base.gitPath;
    },
  };
  const native = createKeiyakuHandle(primaryId, scope, localExecutionContext(), captureLocalContractComposition());
  await assert.rejects(
    native.review(
      { verdict: "satisfied" },
      {
        observe: (event) => {
          if (event.kind === "admitted" && event.contractId === childIds[0] && event.fact.kind === "claimed")
            firstClaimed = true;
          if (
            firstClaimed &&
            event.kind === "stage" &&
            event.contractId === childIds[1] &&
            event.stage === "placement" &&
            event.state === "started"
          )
            armed = true;
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, "internal");
      assert.equal(error.cause, original);
      assert.ok(error.outcome?.operation === "review");
      assert.ok(error.outcome.facts.some((fact) => fact.contract === childIds[0] && fact.kind === "claimed"));
      assert.deepEqual(error.outcome.value?.continuation?.claimed, [childIds[0]]);
      assert.equal(
        error.outcome.facts.some((fact) => fact.contract === childIds[1] && fact.kind === "claimed"),
        false,
      );
      return true;
    },
  );
});

test("a pre-admission custom caller abort keeps its exact reason and aborted category", async () => {
  const repository = repositoryWithMain();
  const native = await bind(repository);
  const controller = new AbortController();
  const reason = new Error("caller stopped");
  controller.abort(reason);
  await assert.rejects(native.deliver({ signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "aborted");
    assert.equal(error.cause, reason);
    assert.ok(error.outcome !== undefined && "facts" in error.outcome);
    assert.deepEqual(error.outcome.facts, []);
    return true;
  });
});

test("read observation preserves exact exceptional identity and thrown undefined", async () => {
  const repository = repositoryWithMain();
  const scope = scopeForRepo(await Repo.at({ path: repository.path }));
  const original = new AuthorityCorruptionError("original observation failure");
  for (const failure of [original, undefined]) {
    let caught = false;
    await withGitDecodeChannel(scope, async (channel) => {
      try {
        await withGitReadObservation(scope, channel, () => {
          throw failure;
        });
      } catch (error) {
        caught = true;
        assert.equal(error, failure);
      }
    });
    assert.equal(caught, true);
  }
});

test("native bind and delivery JSON retain result data without process custody", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document(), gates: [] }));
  const bindJson = JSON.parse(JSON.stringify(bound));
  assert.deepEqual(bindJson.value.keiyaku, { contract: bound.contract });
  assert.deepEqual(bindJson.facts, bound.facts);
  assert.deepEqual(bindJson.effects, bound.effects);
  assert.deepEqual(bindJson.value.workspace, bound.value.workspace);
  assert.deepEqual(Object.keys(bindJson.value).sort(), Object.keys(bound.value).sort());
  assert.ok(bound.value.workspace?.kind === "worktree");
  commitCandidate(repository, bound.value.workspace.path);
  const delivered = accepted(await bound.value.keiyaku.deliver());
  const json = JSON.parse(JSON.stringify(delivered));
  assert.deepEqual(json.facts, delivered.facts);
  assert.deepEqual(json.effects, delivered.effects);
  assert.deepEqual(json.value.leading, delivered.value.leading);
  assert.deepEqual(json.value.integration, delivered.value.integration);
  assert.deepEqual(Object.keys(json.value).sort(), Object.keys(delivered.value).sort());
  assert.ok((await delivered.value.diff())?.includes("candidate.txt"));
  for (const mechanics of ["readDiff", "scope", "execution", "composition", "checkpoints"]) {
    assert.equal(Object.hasOwn(json.value, mechanics), false);
    assert.equal(Object.hasOwn(bindJson.value.keiyaku, mechanics), false);
  }
});

test("native delivery retains completed Task settlement before terminal cleanup fails", async () => {
  const { readFileSync } = await import("node:fs");
  const { Tasks } = await import("../src/task/index.js");
  const { World } = await import("../src/world.js");
  const repository = repositoryWithMain();
  const world = await World.at(repository.path);
  const task = await Tasks.of(world).add({ title: "Settlement before cleanup" });
  assert.ok(task.kind === "accepted");
  repository.run(["add", ".keiyaku/tasks"]);
  repository.run(["commit", "--quiet", "-m", "Task authority"]);
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document(), task: task.value.id, gates: [] }));
  const original = new TypeError("terminal cleanup program failure");
  const base = scopeForRepo(repo);
  let armed = false;
  const scope = {
    ...base,
    get gitPath(): string {
      if (armed) throw original;
      return base.gitPath;
    },
    onPrivateStateSeatClose: () => {
      if (/^state: done$/mu.test(readFileSync(`${world}/.keiyaku/tasks/${task.value.id.slice(5)}.md`, "utf8")))
        armed = true;
    },
  };
  const native = createKeiyakuHandle(bound.contract, scope, localExecutionContext(), captureLocalContractComposition());
  await assert.rejects(native.deliver(), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.cause, original);
    assert.equal(error.category, "internal");
    assert.ok(error.outcome?.operation === "deliver");
    assert.ok(error.outcome.facts.some((fact) => fact.kind === "claimed"));
    assert.ok(
      error.outcome.effects.some(
        (effect) =>
          effect.kind === "settlement-action" &&
          effect.action.kind === "task" &&
          effect.action.taskId === task.value.id,
      ),
    );
    return true;
  });
  assert.equal((await Tasks.of(world).task({ id: task.value.id }).read())?.task.state, "done");
});

test("fork source object missing from the requested map is a broken observation, not unavailable", async () => {
  const { admitForkBindWithAppointment } = await import("../src/library/bind.js");
  const repository = repositoryWithMain();
  const source = await bind(repository);
  const state = present(await source.state());
  const scope = scopeForRepo(await Repo.at({ path: repository.path }));
  await withGitDecodeChannel(scope, async (channel) => {
    const broken = {
      ...channel,
      readObjects: async (ids: Parameters<typeof channel.readObjects>[0]) => {
        const objects = new Map(await channel.readObjects(ids));
        objects.delete(state.coordinates.start as never);
        return objects;
      },
    };
    await assert.rejects(
      admitForkBindWithAppointment({ scope, channel: broken, sourceId: state.id }),
      /missing fork source object observation: kei\//u,
    );
  });
});

test("native Contract reads use null for lawful absence while corrupt fork terms remain exceptional", async () => {
  const { decodeJournal, encodeEntry } = await import("../src/core/facts/codec.js");
  const { contractJournalPath } = await import("../src/git/identity.js");
  const { readGit, updateGitTree, writeBlob, writeCommit, updateRefsAtomically, GIT_REF } = await import(
    "../src/git/repository.js"
  );
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const missing = Keiyaku.with().select({ repo, id: contractId("kei/missing") });
  assert.equal(await missing.state(), null);
  assert.equal(await missing.history(), null);
  assert.equal(await missing.guidance(), null);
  assert.equal(await missing.delivery(), null);
  const source = await bind(repository);
  const id = present(await source.state()).id;
  const scope = scopeForRepo(repo);
  const snapshot = await readGit(scope);
  const journalPath = contractJournalPath(id, "active");
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
  await assert.rejects(Keiyaku.with().bind({ repo, forkOf: id }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "authority-corruption");
    assert.ok(error.cause instanceof TypeError);
    assert.ok(error.message.includes(id));
    return true;
  });
});

test("native audit propagates an unexpected target-lag failure after verified publication with its partial report", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keiyaku.with().bind({ repo, markdown: document("true"), target: "main", gates: ["reviewed"] }),
  );
  const base = scopeForRepo(repo);
  const original = new TypeError("unexpected native target lag observation failure");
  let injected = 0;
  const scope = {
    ...base,
    get gitPath(): string {
      if (new Error().stack?.includes("observeTargetLag")) {
        injected += 1;
        throw original;
      }
      return base.gitPath;
    },
  };
  const native = createKeiyakuHandle(bound.contract, scope, localExecutionContext(), captureLocalContractComposition());
  let witnessedHead: string | undefined;
  await assert.rejects(native.audit(), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "internal");
    assert.equal(error.cause, original);
    assert.ok(error.outcome?.operation === "audit");
    assert.equal(error.outcome.contract, bound.contract);
    assert.ok(error.outcome.head);
    witnessedHead = error.outcome.head;
    const attestation = error.outcome.facts.find((fact) => fact.kind === "attestation");
    assert.ok(attestation?.kind === "attestation");
    assert.equal(attestation.data.gate, "verified");
    assert.equal(attestation.data.verdict, "satisfied");
    assert.equal(error.outcome.value?.candidate?.kind, "ready");
    assert.equal(error.outcome.value?.verification?.kind, "satisfied");
    assert.equal(error.outcome.value?.target?.kind, "placeable");
    assert.equal(error.outcome.value?.targetLag, undefined);
    return true;
  });
  assert.equal(injected, 1);
  assert.equal(present(await bound.value.keiyaku.state()).head, witnessedHead);
});

test("native bind retains its complete accepted value when its owned decode channel has an operational close failure", async () => {
  const { withGitShim } = await import("./support/git.js");
  const repository = repositoryWithMain();
  await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@"',
      "  exit 73",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      const repo = await Repo.at({ path: repository.path, gitPath });
      const result = accepted(await Keiyaku.with().bind({ repo, markdown: document(), gates: [] }));
      assert.ok(result.value.keiyaku instanceof Keiyaku);
      assert.ok(result.value.workspace?.kind === "worktree");
      assert.ok(result.facts.some((fact) => fact.kind === "bind" && fact.contract === result.contract));
      assert.ok(
        result.effects.some((effect) => effect.kind === "cleanup" && effect.issue.kind === "decode-channel-retirement"),
      );
      assert.deepEqual(result.pending, [{ surface: "cleanup", required: false }]);
    },
  );
});

test("native delivery retains an earlier completed checkout follow when a later arm throws", async () => {
  const { rmSync } = await import("node:fs");
  const repository = repositoryWithMain();
  const sibling = `${repository.path}-other-checkout`;
  repository.run(["worktree", "add", "--quiet", "--force", sibling, "main"]);
  try {
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document(), target: "main", gates: [] }));
    assert.ok(bound.value.workspace?.kind === "worktree");
    commitCandidate(repository, bound.value.workspace.path);
    const base = scopeForRepo(repo);
    const original = new TypeError("later checkout program failure");
    let follows = 0;
    const scope = {
      ...base,
      get gitPath(): string {
        if (new Error().stack?.includes("followTargetPlacement") && ++follows === 2) throw original;
        return base.gitPath;
      },
    };
    const native = createKeiyakuHandle(
      bound.contract,
      scope,
      localExecutionContext(),
      captureLocalContractComposition(),
    );
    await assert.rejects(native.deliver(), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.cause, original);
      assert.equal(error.category, "internal");
      assert.ok(error.outcome?.operation === "deliver");
      assert.ok(error.outcome.facts.some((fact) => fact.kind === "claimed"));
      const followed = error.outcome.effects.flatMap((effect) =>
        effect.kind === "reconciliation-effect" && effect.effect.kind === "target-checkout" ? [effect.effect] : [],
      );
      assert.deepEqual(followed, [
        {
          kind: "target-checkout",
          path: [repository.path, sibling].sort()[0],
          target: "refs/heads/main",
          action: "followed",
        },
      ]);
      assert.equal(
        error.outcome.effects.some((effect) => effect.kind === "checkout-retained"),
        false,
      );
      return true;
    });
    assert.equal(follows, 2);
  } finally {
    repository.run(["worktree", "remove", "--force", sibling]);
    rmSync(sibling, { recursive: true, force: true });
  }
});

test("native terminal removal survives a subsequent malformed ref read, including its retirement marker", async () => {
  const repository = repositoryWithMain();
  const marker = join(repository.path, ".git", "removed-before-broken-ref");
  await withGitShim(
    [
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
    ].join("\n"),
    { KEIYAKU_REMOVAL_MARKER: marker },
    async (gitPath) => {
      const repo = await Repo.at({ path: repository.path, gitPath });
      const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document(), target: "main", gates: [] }));
      assert.ok(bound.value.workspace?.kind === "worktree");
      const path = bound.value.workspace.path;
      commitCandidate(repository, path);
      await assert.rejects(bound.value.keiyaku.deliver(), (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.category, "internal");
        assert.ok(error.cause instanceof Error);
        assert.equal(error.cause.name, "Error");
        assert.match(error.cause.message, /is not a Git object ID: broken-post-removal-object-identity/u);
        assert.equal(error.message, error.cause.message);
        assert.ok(error.outcome?.operation === "deliver");
        assert.equal(error.outcome.contract, bound.contract);
        assert.ok(error.outcome.facts.some((fact) => fact.kind === "deliver"));
        assert.ok(error.outcome.facts.some((fact) => fact.kind === "claimed"));
        const removals = error.outcome.effects.flatMap((effect) =>
          effect.kind === "reconciliation-effect" &&
          effect.effect.kind === "worktree" &&
          effect.effect.action === "removed"
            ? [effect.effect]
            : [],
        );
        assert.deepEqual(removals, [{ kind: "worktree", path, action: "removed" }]);
        assert.deepEqual(
          error.outcome.effects.filter((effect) => effect.kind === "worktree-retired"),
          [{ kind: "worktree-retired", contract: bound.contract, name: basename(path) }],
        );
        return true;
      });
      assert.equal(existsSync(marker), true);
      assert.equal(existsSync(path), false);
      for (const ref of [deliveryRefFor(bound.contract), candidatePinRefFor(bound.contract)])
        assert.match(repository.run(["rev-parse", "--verify", ref]).trim(), /^[0-9a-f]{40}$/u);
    },
  );
});

test("native delivery independently bounds stalled EOF retirement and proves the owned process exited", async () => {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keiyaku.with().bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: document(),
      gates: ["reviewed"],
    }),
  );
  const marker = join(repository.path, ".git", "stalled-batch-eof-pid");
  await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@" || exit "$?"',
      '  echo "$$" > "$KEIYAKU_EOF_MARKER"',
      "  sleep 30",
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_EOF_MARKER: marker },
    async (gitPath) => {
      const repo = await Repo.at({ path: repository.path, gitPath });
      const native = Keiyaku.with().select({ repo, id: bound.contract });
      const controller = new AbortController();
      let watchdogFired = false;
      let finishedAt: number | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = accepted(
          await native.deliver(
            { signal: controller.signal },
            {
              observe: (event) => {
                if (event.kind === "stage" && event.stage === "reconciliation" && event.state === "finished") {
                  finishedAt = performance.now();
                  watchdog = setTimeout(() => {
                    watchdogFired = true;
                    controller.abort(new Error("test backstop: retirement was not independently bounded"));
                  }, 10_000);
                }
              },
            },
          ),
        );
        assert.equal(watchdogFired, false);
        assert.equal(controller.signal.aborted, false);
        assert.ok(finishedAt !== undefined && performance.now() - finishedAt < 10_000);
        const cleanup = result.effects.filter(
          (effect) => effect.kind === "cleanup" && effect.issue.kind === "decode-channel-retirement",
        );
        assert.equal(cleanup.length, 1);
        assert.ok(cleanup[0]?.kind === "cleanup" && cleanup[0].issue.kind === "decode-channel-retirement");
        assert.match(cleanup[0].issue.diagnostic, /retirement exceeded its EOF close bound/u);
        assert.ok(result.pending.some((pending) => pending.surface === "cleanup" && !pending.required));
        const pid = Number(readFileSync(marker, "utf8").trim());
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        assert.throws(
          () => process.kill(pid, 0),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH",
        );
      } finally {
        clearTimeout(watchdog);
        controller.abort();
      }
    },
  );
});
