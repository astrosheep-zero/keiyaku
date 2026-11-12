import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { candidatePinRefFor, deliveryRefFor, withGitShim } from "./support/git.js";
import {
  KeiyakuError,
  AuthorityCorruptionError,
  SettingsError,
  Repo,
  Kei,
  Keis,
} from "../src/index.js";
import { deliveryPreviewOutcomeSchema, deliverOutcomeSchema } from "../src/library/contract-outcomes.js";
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { createKeiHandle } from "../src/library/kei.js";
import { withOutcomeReceipt, projectFailure } from "../src/library/outcome.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { captureLocalContractComposition } from "../src/library/contract-settings.js";
import { scopeForRepo } from "../src/library/repo.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { executionStop } from "../src/protocol/progress.js";
import { actorId, contractId } from "../src/core/facts/types.js";
import { bind, commitCandidate, repositoryWithMain, present, accepted, document } from "./support/library-verbs.js";

// The captured native owner uses this repository-local capability; no global/module monkeypatch.
test("frozen KeiyakuError receipts merge into a fresh error retaining the original cause chain", () => {
  const cause = new TypeError("original frozen failure");
  const admitted = { kind: "attestation" as const, requirement: "requirement:original", verdict: "satisfied" as const };
  const effect = { kind: "worktree-created" as const, path: "/tmp/frozen-effect" };
  const original = new KeiyakuError("internal", "frozen failure", {
    cause,
    spawn: { kind: "spawned", akumaId: parseAkumaId("aku/worker/11111111").id },
    tell: { kind: "admitted", akumaId: parseAkumaId("aku/worker/11111111").id, tellId: "original-tell" },
    outcome: { kind: "contract", contractId: contractId("kei/frozen-error"), admitted: [admitted], effects: [effect] },
  });
  Object.freeze(original);
  const returned = withOutcomeReceipt(original, {
    kind: "contract",
    contractId: contractId("kei/frozen-error"),
    effects: [effect, { kind: "worktree-removed", path: "/tmp/frozen-removal" }],
    issues: [{ kind: "diagnostic", severity: "optional", diagnostic: "frozen retirement" }],
  });
  assert.notEqual(returned, original);
  assert.equal(returned.category, "internal");
  assert.equal(returned.cause, original);
  assert.equal(original.cause, cause);
  assert.equal(returned.spawn, original.spawn);
  assert.equal(returned.tell, original.tell);
  assert.equal(projectFailure(new KeiyakuError("internal", "no native cause")).causeClass, undefined);
  const corruption = new AuthorityCorruptionError("native authority", { cause });
  assert.equal(projectFailure(withOutcomeReceipt(corruption, { kind: "contract" })).causeClass, corruption.name);
  assert.equal(projectFailure(returned).causeClass, "TypeError");
  assert.equal(projectFailure(returned).causeDiagnostic, cause.message);
  assert.ok(Object.isFrozen(returned.outcome));
  assert.throws(() => Object.assign(returned, { outcome: undefined }), TypeError);
  assert.deepEqual(original.outcome?.kind === "contract" ? original.outcome.effects : undefined, [effect]);
  assert.equal(returned.message, "frozen failure");
  assert.deepEqual(returned.outcome, {
    kind: "contract",
    contractId: contractId("kei/frozen-error"),
    admitted: [admitted],
    effects: [effect, { kind: "worktree-removed", path: "/tmp/frozen-removal" }],
    issues: [{ kind: "diagnostic", severity: "optional", diagnostic: "frozen retirement" }],
  });
});

test("accepted delivery preserves its identities and required retirement failure", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), gates: ["reviewed"], target: "main" }));
  commitCandidate(repository, bound.worktreePath);
  let first = true;
  const native = createKeiHandle(bound.contractId, {
    ...scopeForRepo(repo),
    onPrivateStateSeatClose: () => {
      if (!first) return;
      first = false;
      throw new Error("publication retirement failed");
    },
  }, captureLocalContractComposition());
  const result = accepted(await native.deliver());
  assert.equal(result.contractId, bound.contractId);
  assert.equal(result.placement?.kind, "gates-unsatisfied");
  assert.ok(result.issues?.some((issue) => issue.kind === "diagnostic" &&
    issue.severity === "required" && issue.diagnostic === "publication retirement failed"));
  assert.equal(classifyVerb("deliver", {}, { kind: "returned", value: result }), "failed");
  assert.equal(present(await bound.kei.state()).delivery?.data.integration.snapshot, result.integration);
  const wire = JSON.parse(JSON.stringify(result));
  assert.deepEqual(deliverOutcomeSchema.parse(wire), wire);
});

test("native delivery propagates lower programming and corruption failures after confirmed publication", async () => {
  for (const original of [
    new TypeError("broken lower target observation"),
    new AuthorityCorruptionError("broken lower authority"),
  ]) {
    const repository = repositoryWithMain();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(
      await Keis.of(repo).bind({
        markdown: (await import("./support/library-verbs.js")).document(),
        target: "main",
        gates: [],
      }),
    );
    const id = present(await bound.kei.state()).id;
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
    const native = createKeiHandle(id, scope, captureLocalContractComposition());
    await assert.rejects(native.deliver(), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, original instanceof AuthorityCorruptionError ? "authority-corruption" : "internal");
      assert.equal(error.cause, original);
      assert.ok(error.outcome?.kind === "contract");
      assert.ok(error.outcome.admitted?.some((fact) => fact.kind === "deliver"));
      assert.equal(
        (error.outcome.issues ?? []).some((effect) => effect.kind === "execution-stopped"),
        false,
      );
      return true;
    });
  }
});

test("native delivery wraps lower-owner failures before publication", async () => {
  const repository = repositoryWithMain();
  const bound = await bind(repository);
  const before = present(await bound.state());
  const base = scopeForRepo(await Repo.at({ path: repository.path }));
  for (const original of [
    new AuthorityCorruptionError("pre-admission authority failure"),
    new SettingsError("pre-admission settings failure"),
  ]) {
    const native = createKeiHandle(before.id, {
      ...base,
      get gitPath(): string {
        throw original;
      },
    }, captureLocalContractComposition());
    await assert.rejects(native.deliver(), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.notEqual(error, original);
      assert.equal(error.cause, original);
      assert.equal(error.category, original.category);
      assert.equal(error.outcome?.kind === "contract" ? error.outcome.admitted : undefined, undefined);
      return true;
    });
  }
  assert.deepEqual(present(await bound.state()), before);
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
  const native = createKeiHandle(present(await bound.state()).id, scope, composition);
  await assert.rejects(native.deliver({ signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "internal");
    assert.equal(error.cause, original);
    assert.ok(error.outcome?.kind === "contract");
    assert.ok(error.outcome.admitted?.some((fact) => fact.kind === "deliver"));
    return true;
  });
  assert.throws(
    () => executionStop(contractId("kei/independent"), original, controller.signal),
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

test("native delivery keeps claim and movement when later observation throws, without reading twice", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), target: "main", gates: [] }));
  const id = present(await bound.kei.state()).id;
  commitCandidate(repository);
  const original = new TypeError("broken post-placement observation");
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
  const native = createKeiHandle(id, scope, captureLocalContractComposition());
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
      assert.ok(error.outcome?.kind === "contract");
      assert.ok(error.outcome.admitted?.some((fact) => fact.kind === "claimed"));
      assert.ok(error.outcome.placement?.kind === "placed");
      assert.equal(error.outcome.placement.target, "refs/heads/main");
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
      await Keis.of(repo).bind({
        markdown: document().replace("# Library verbs", "# " + title),
        gates: [],
        // The continuation fixtures stay targetless, like their prerequisite.
        target: null,
        after: [primaryId],
      }),
    ).kei;
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
  const native = createKeiHandle(primaryId, scope, captureLocalContractComposition());
  await assert.rejects(
    native.review(
      { verdict: "satisfied", summary: "Invocation review passed" },
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
      assert.ok(error.outcome?.kind === "contract");
      assert.ok(error.outcome.admitted?.some((fact) => fact.contractId === childIds[0] && fact.kind === "claimed"));
      assert.deepEqual(error.outcome.continuation?.claimed, [childIds[0]]);
      assert.equal(
        error.outcome.admitted?.some((fact) => fact.contractId === childIds[1] && fact.kind === "claimed"),
        false,
      );
      return true;
    },
  );
});

test("a pre-admission custom caller abort rejects with the exact raw reason without publication", async () => {
  const repository = repositoryWithMain();
  const native = await bind(repository);
  const before = present(await native.state());
  const controller = new AbortController();
  const reason = Object.freeze(new Error("caller stopped"));
  controller.abort(reason);
  await assert.rejects(native.deliver({ signal: controller.signal }), (error: unknown) => {
    assert.equal(error, reason);
    return true;
  });
  assert.deepEqual(present(await native.state()), before);
});

test("native cancellation preserves an existing category and any partial observation", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), target: "main", gates: [] }));
  const before = present(await bound.kei.state());
  const cause = new TypeError("original caller cause");
  const reason = Object.freeze(new KeiyakuError("authority-corruption", "categorized caller stop", { cause }));
  const preAdmission = new AbortController();
  preAdmission.abort(reason);
  await assert.rejects(bound.kei.deliver({ signal: preAdmission.signal }), (error: unknown) => {
    assert.equal(error, reason);
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "authority-corruption");
    assert.equal(error.outcome, undefined);
    return true;
  });
  assert.deepEqual(present(await bound.kei.state()), before);

  const controller = new AbortController();
  const base = scopeForRepo(repo);
  const native = createKeiHandle(before.id, {
    ...base,
    signal: controller.signal,
    get gitPath() {
      if (new Error().stack?.includes("observeTargetLag")) {
        controller.abort(reason);
        throw reason;
      }
      return base.gitPath;
    },
  }, captureLocalContractComposition());
  await assert.rejects(native.previewDelivery(), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.notEqual(error, reason);
    assert.equal(error.category, reason.category);
    assert.equal(error.cause, reason);
    assert.ok(error.outcome?.kind === "contract");
    assert.ok(error.outcome.preview?.kind === "ready");
    assert.ok(error.outcome.preview.candidate);
    assert.equal(error.outcome.admitted, undefined);
    return true;
  });
  assert.deepEqual(present(await bound.kei.state()), before);
  assert.equal(reason.cause, cause);
  assert.equal(reason.outcome, undefined);
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
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), gates: [] }));
  const bindJson = JSON.parse(JSON.stringify(bound));
  assert.deepEqual(bindJson, {
    kind: "accepted",
    contractId: bound.contractId,
    worktreePath: bound.worktreePath,
    target: "refs/heads/main",
  });
  assert.ok(bound.worktreePath);
  commitCandidate(repository, bound.worktreePath);
  const delivered = accepted(await bound.kei.deliver());
  const json = JSON.parse(JSON.stringify(delivered));
  assert.deepEqual(json, {
    kind: "accepted",
    contractId: bound.contractId,
    candidate: delivered.candidate,
    integration: delivered.integration,
    contentId: delivered.contentId,
    placement: delivered.placement,
  });
  assert.equal(delivered.placement?.kind, "placed");
  assert.equal(Object.hasOwn(bindJson, "kei"), false);
  assert.equal(Object.hasOwn(json, "diff"), false);
});

test("native delivery retains completed Debt settlement before terminal cleanup fails", async () => {
  const { readFileSync } = await import("node:fs");
  const { Debts } = await import("../src/debt/index.js");
  const { World } = await import("../src/world.js");
  const repository = repositoryWithMain();
  const world = await World.at(repository.path);
  const debt = await Debts.of(world).add({ title: "Settlement before cleanup" });
  assert.ok(debt.kind === "accepted");
  repository.run(["add", ".keiyaku/debts"]);
  repository.run(["commit", "--quiet", "-m", "Debt authority"]);
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), debt: debt.id, gates: [] }));
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
      if (/^state: done$/mu.test(readFileSync(`${world}/.keiyaku/debts/${debt.id.slice(5)}.md`, "utf8"))) armed = true;
    },
  };
  const native = createKeiHandle(bound.contractId, scope, captureLocalContractComposition());
  await assert.rejects(native.deliver(), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.cause, original);
    assert.equal(error.category, "internal");
    assert.ok(error.outcome?.kind === "contract");
    assert.ok(error.outcome.admitted?.some((fact) => fact.kind === "claimed"));
    assert.deepEqual(
      error.outcome.effects?.filter((effect) => effect.kind === "debt-settled"),
      [{ kind: "debt-settled", debtId: debt.id }],
    );
    return true;
  });
  const settledRead = await Debts.of(world).debt({ id: debt.id }).read();
  assert.equal(settledRead.kind, "present");
  if (settledRead.kind === "present") assert.equal(settledRead.state, "done");
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
    assert.ok(error.cause.cause instanceof TypeError);
    assert.ok(error.message.includes(id));
    return true;
  });
});

test("native preview preserves partial observation on unexpected target-lag failure without admitting facts", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo).bind({ markdown: document("true"), target: "main", gates: ["reviewed", "verified"] }),
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
  const native = createKeiHandle(bound.contractId, scope, captureLocalContractComposition());
  const witnessedHead = present(await bound.kei.state()).head;
  await assert.rejects(native.previewDelivery(), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "internal");
    assert.equal(error.cause, original);
    assert.ok(error.outcome?.kind === "contract");
    assert.equal(error.outcome.contractId, bound.contractId);
    assert.equal(error.outcome.admitted, undefined);
    assert.deepEqual(error.outcome.issues ?? [], []);
    assert.ok(error.outcome.preview?.kind === "ready");
    assert.ok(error.outcome.preview.candidate);
    assert.ok(error.outcome.preview.unmetGates?.length);
    assert.equal(error.outcome.preview.target?.kind, "placeable");
    assert.equal(error.outcome.preview.target?.behind, undefined);
    return true;
  });
  assert.equal(injected, 1);
  assert.equal(present(await bound.kei.state()).head, witnessedHead);
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
      const result = accepted(await Keis.of(repo).bind({ markdown: document(), gates: [] }));
      assert.ok(result.kei instanceof Kei);
      assert.ok(result.worktreePath);
      const healthy = Keis.of(await Repo.at({ path: repository.path })).kei({ id: result.contractId });
      assert.equal(present(await healthy.state()).id, result.contractId);
      assert.ok((result.issues ?? []).some((effect) => effect.kind === "diagnostic" && effect.severity === "optional"));
      assert.equal(classifyVerb("bind", { markdown: document() }, { kind: "returned", value: result }), "accepted");
      const preview = await result.kei.previewDelivery();
      assert.ok(preview.kind === "ready");
      assert.ok(preview.issues?.some((issue) => issue.kind === "diagnostic" && issue.severity === "optional"));
      const previewWire = JSON.parse(JSON.stringify(preview));
      assert.deepEqual(deliveryPreviewOutcomeSchema.parse(previewWire), previewWire);
    },
  );
});

test("a no-admission cleanup failure keeps its native cause without claiming delivery", async () => {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({ markdown: document(), gates: ["reviewed"] }),
  );
  const id = bound.contractId;
  assert.ok(bound.worktreePath);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(bound.worktreePath, "dirty.txt"), "unadmitted bytes\n");
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
      const native = Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({ id });
      await assert.rejects(native.deliver(), (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.category, "internal");
        assert.ok(error.cause instanceof Error);
        assert.equal(error.cause.name, "GitPlumbingError");
        assert.match(error.cause.message, /did not close cleanly/u);
        assert.ok(error.outcome?.kind === "contract");
        assert.equal(error.outcome.contractId, id);
        assert.equal(error.outcome.admitted, undefined);
        const cleanup = error.outcome.issues?.filter((issue) => issue.kind === "diagnostic");
        assert.equal(cleanup?.length, 1);
        assert.ok(cleanup?.[0]?.kind === "diagnostic" && cleanup[0].severity === "optional");
        assert.match(cleanup[0].diagnostic, /did not close cleanly/u);
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

test("native delivery retains an earlier completed checkout follow when a later arm throws", async () => {
  const { rmSync } = await import("node:fs");
  const repository = repositoryWithMain();
  const sibling = `${repository.path}-other-checkout`;
  repository.run(["worktree", "add", "--quiet", "--force", sibling, "main"]);
  try {
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({ markdown: document(), target: "main", gates: [] }));
    assert.ok(bound.worktreePath);
    commitCandidate(repository, bound.worktreePath);
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
    const native = createKeiHandle(bound.contractId, scope, captureLocalContractComposition());
    await assert.rejects(native.deliver(), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.cause, original);
      assert.equal(error.category, "internal");
      assert.ok(error.outcome?.kind === "contract");
      assert.ok(error.outcome.admitted?.some((fact) => fact.kind === "claimed"));
      const followed = error.outcome.effects?.filter((movement) => movement.kind === "target-checkout");
      assert.deepEqual(followed, [
        {
          kind: "target-checkout",
          path: [repository.path, sibling].sort()[0],
          target: "refs/heads/main",
        },
      ]);
      assert.ok(error.outcome.placement?.kind === "placed");
      assert.equal(
        repository.run(["-C", followed![0]!.path, "rev-parse", "HEAD"]).trim(),
        error.outcome.placement.integration,
      );
      assert.equal(
        (error.outcome.issues ?? []).some((effect) => effect.kind === "target-checkout-retained"),
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
      const bound = accepted(await Keis.of(repo).bind({ markdown: document(), target: "main", gates: [] }));
      assert.ok(bound.worktreePath);
      const path = bound.worktreePath;
      commitCandidate(repository, path);
      await assert.rejects(bound.kei.deliver(), (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.category, "internal");
        assert.ok(error.cause instanceof Error);
        assert.equal(error.cause.name, "Error");
        assert.match(error.cause.message, /is not a Git object ID: broken-post-removal-object-identity/u);
        assert.equal(error.message, error.cause.message);
        assert.ok(error.outcome?.kind === "contract");
        assert.equal(error.outcome.contractId, bound.contractId);
        assert.ok(error.outcome.admitted?.some((fact) => fact.kind === "deliver"));
        assert.ok(error.outcome.admitted?.some((fact) => fact.kind === "claimed"));
        assert.deepEqual(
          error.outcome.effects?.filter((effect) => effect.kind === "worktree-removed"),
          [{ kind: "worktree-removed", path }],
        );
        assert.ok(error.outcome.placement?.kind === "placed");
        return true;
      });
      assert.equal(existsSync(marker), true);
      assert.equal(existsSync(path), false);
      for (const ref of [deliveryRefFor(bound.contractId), candidatePinRefFor(bound.contractId)])
        assert.match(repository.run(["rev-parse", "--verify", ref]).trim(), /^[0-9a-f]{40}$/u);
    },
  );
});

test("native delivery independently bounds stalled EOF retirement and proves the owned process exited", async () => {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
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
      const native = Keis.of(repo).kei({ id: bound.contractId });
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
        const cleanup = (result.issues ?? []).filter((effect) => effect.kind === "diagnostic");
        assert.equal(cleanup.length, 1);
        assert.ok(cleanup[0]?.kind === "diagnostic" && cleanup[0].severity === "optional");
        assert.match(cleanup[0].diagnostic, /retirement exceeded its EOF close bound/u);
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
