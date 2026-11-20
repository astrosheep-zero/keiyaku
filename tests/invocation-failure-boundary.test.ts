import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
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
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { createKeiHandle } from "../src/library/kei.js";
import { withOutcomeReceipt, projectFailure } from "../src/library/outcome.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { captureLocalContractComposition } from "../src/library/contract-settings.js";
import { scopeForRepo } from "../src/library/repo.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { SqliteTransactionLockError } from "../src/coordination/sqlite-transaction-lock.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { contractId, type AttestationEntry } from "../src/core/facts/types.js";
import { projectSettings } from "../src/settings.js";
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
    effects: [{ path: effect.path, kind: effect.kind }, { kind: "worktree-removed", path: "/tmp/frozen-removal" }],
    issues: [{ kind: "diagnostic", severity: "optional", diagnostic: "frozen retirement" }],
  });
  assert.notEqual(returned, original);
  assert.equal(returned.category, "internal");
  assert.equal(returned.cause, original);
  assert.equal(original.cause, cause);
  assert.equal(returned.spawn, original.spawn);
  assert.equal(returned.tell, original.tell);
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

test("accepted delivery preserves its identities and required retirement failure", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), gates: ["reviewed"], target: "main" }));
  commitCandidate(repository, bound.worktreePath);
  let first = true;
  const native = createKeiHandle(bound.contractId, {
    ...scopeForRepo(repo),
    onPrivateStateSeatClose: () => {
      if (!first) return;
      first = false;
      throw new SqliteTransactionLockError("publication retirement failed", "release-failed");
    },
  }, captureLocalContractComposition());
  const result = accepted(await native.deliver());
  assert.equal(result.contractId, bound.contractId);
  assert.equal(result.placement?.kind, "gates-unsatisfied");
  assert.ok(result.issues?.some((issue) => issue.kind === "diagnostic" &&
    issue.severity === "required" && issue.diagnostic === "publication retirement failed"));
  assert.equal(classifyVerb("deliver", {}, { kind: "returned", value: result }), "failed");
  assert.equal(present(await bound.kei.state()).delivery?.data.integration.snapshot, result.integration);
});

test("failed redelivery retains its reused admission and addressed placement stop", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: "main", gates: ["reviewed"] }));
  commitCandidate(repository, bound.worktreePath);
  const first = accepted(await bound.kei.deliver());
  const stop = first.placement;
  assert.ok(stop?.kind === "gates-unsatisfied");
  assert.equal(stop.unmet[0]?.state, "missing");
  const before = present(await bound.kei.state());
  assert.ok(before.delivery);
  const reused = encodeEntry(before.delivery);
  const original = new TypeError("Git observation failed after the placement decision");
  const base = scopeForRepo(repo);
  let armed = false;
  let newAdmission = false;
  const native = createKeiHandle(bound.kei.id, {
    ...base,
    get gitPath() {
      if (armed) throw original;
      return base.gitPath;
    },
  }, captureLocalContractComposition());
  await assert.rejects(
    native.deliver({}, {
      observe(event) {
        if (event.kind === "admitted") newAdmission = true;
        if (event.kind === "stage" && event.stage === "reconciliation" && event.state === "started") armed = true;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof KeiyakuError && error.outcome?.kind === "contract");
      assert.equal(error.cause, original);
      assert.equal(error.outcome.contractId, bound.kei.id);
      assert.deepEqual(error.outcome.placement, stop);
      assert.deepEqual(error.outcome.admitted, [{
        kind: "deliver",
        admission: "reused",
        candidate: first.candidate,
        integration: first.integration,
        contentId: first.contentId,
      }]);
      const repeated = withOutcomeReceipt(error, { kind: "contract", reused, placement: stop });
      assert.equal(repeated.cause, error);
      assert.deepEqual(repeated.outcome, error.outcome);
      return true;
    },
  );
  assert.equal(newAdmission, false);
  assert.deepEqual(present(await bound.kei.state()), before);
});

test("native delivery propagates lower programming and corruption failures after confirmed publication", async () => {
  for (const original of [
    new TypeError("broken lower target observation"),
    new AuthorityCorruptionError("broken lower authority"),
  ]) {
    const repository = repositoryWithMain();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: "main", gates: [] }));
    const id = bound.contractId;
    commitCandidate(repository);
    let armed = false;
    const base = scopeForRepo(repo);
    const native = createKeiHandle(id, {
      ...base,
      get gitPath() {
        if (armed) throw original;
        return base.gitPath;
      },
      onPrivateStateSeatClose: () => { armed = true; },
    }, captureLocalContractComposition());
    await assert.rejects(native.deliver(), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, original instanceof AuthorityCorruptionError ? "authority-corruption" : "internal");
      assert.equal(error.cause, original);
      assert.ok(error.outcome?.kind === "contract");
      const [delivery] = error.outcome.admitted ?? [];
      assert.ok(delivery?.kind === "deliver");
      assert.ok(delivery.candidate && delivery.integration && delivery.contentId);
      assert.deepEqual(error.outcome, { kind: "contract", contractId: id, admitted: [delivery] });
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

test("native delivery keeps claim and movement when later observation throws, without reading twice", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: "main", gates: [] }));
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

test("native review keeps completed and stopped dependents when a later sibling throws", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const keis = Keis.of(repo);
  const primary = accepted(await keis.bind({ terms: document(), target: null, gates: ["reviewed"] }));
  assert.ok(primary.worktreePath);
  writeFileSync(join(primary.worktreePath, "authored.txt"), "captured dirty bytes\n");
  const child = async (title: string, gates: readonly string[] = []) => accepted(await keis.bind({
    terms: document().replace("# Library verbs", `# ${title}`), target: null, gates, after: [primary.kei.id],
  }));
  const stopped = await child("A physically stopped sibling");
  const gated = await child("B gated sibling", ["reviewed"]);
  const claimed = await child("C claimed sibling");
  const later = await child("D failing sibling");
  assert.equal(accepted(await stopped.kei.deliver()).placement?.kind, "prerequisites-unsatisfied");
  accepted(await gated.kei.deliver());
  const delivered = accepted(await claimed.kei.deliver());
  accepted(await later.kei.deliver());
  assert.ok(stopped.worktreePath);
  const localEdit = join(stopped.worktreePath, "local-edit");
  writeFileSync(localEdit, "keep this edit\n");
  accepted(await primary.kei.deliver({ includeDirty: true }));
  const base = scopeForRepo(repo);
  const original = new TypeError("later dependent placement failed unexpectedly");
  let armed = false;
  const native = createKeiHandle(primary.kei.id, {
    ...base,
    get gitPath() {
      if (armed) throw original;
      return base.gitPath;
    },
  }, captureLocalContractComposition());
  await assert.rejects(native.review({ verdict: "satisfied", summary: "Release the prerequisite" }, {
    observe(event) {
      if (event.kind === "stage" && event.contractId === later.kei.id &&
        event.stage === "placement" && event.state === "started") armed = true;
    },
  }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError && error.outcome?.kind === "contract");
    assert.equal(error.cause, original);
    const { admitted, continuation, effects, issues, placement } = error.outcome;
    assert.equal(error.outcome.contractId, primary.kei.id);
    assert.equal(placement?.kind, "placed");
    assert.ok(issues?.some((issue) => issue.kind === "worktree-follow-retained" && issue.contractId === stopped.kei.id));
    assert.deepEqual(continuation?.stopped?.map(({ contractId, stop }) => [contractId, stop.kind]), [
      [stopped.kei.id, "physical-lag"], [gated.kei.id, "gates-unsatisfied"],
    ]);
    assert.equal(Object.hasOwn(continuation ?? {}, "claimed"), false);
    assert.deepEqual(admitted?.filter((fact) => fact.kind === "claimed" && fact.contractId).map((fact) => fact.contractId), [claimed.kei.id]);
    assert.deepEqual(effects?.filter((effect) => effect.kind === "placed" && effect.contractId === claimed.kei.id), [
      { kind: "placed", contractId: claimed.kei.id, integration: delivered.integration },
    ]);
    assert.equal(Object.hasOwn(error.outcome, "worktreeChanges"), false);
    return true;
  });
  assert.equal(present(await stopped.kei.state()).terminal, null);
  assert.equal(readFileSync(localEdit, "utf8"), "keep this edit\n");
});

test("explicit verify retains a finished check when the next check cannot finish admission", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const terms = document("true") + "\n~~~bash timeout=1m\nprintf second\n~~~\n";
  const bound = accepted(await Keis.of(repo).bind({ terms, target: null, gates: ["verified"] }));
  commitCandidate(repository, bound.worktreePath);
  const delivered = accepted(await bound.kei.deliver());
  const base = scopeForRepo(repo);
  const original = new TypeError("second check's admission failed unexpectedly");
  let armed = false;
  const native = createKeiHandle(bound.contractId, {
    ...base,
    get gitPath() {
      if (armed) throw original;
      return base.gitPath;
    },
  }, captureLocalContractComposition());
  await assert.rejects(native.verify({}, { observe(event) {
    if (event.kind !== "verification") return;
    const observation = event.observation;
    if (observation.index === 2 && observation.kind === "phase" && observation.phase === "cleanup" && observation.state === "finished") armed = true;
  } }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError && error.outcome?.kind === "contract");
    assert.equal(error.cause, original);
    assert.equal(error.outcome.snapshot, delivered.integration);
    const [admission] = error.outcome.admitted ?? [];
    assert.ok(admission?.kind === "attestation" && admission.requirement);
    assert.deepEqual(error.outcome.checks, [{
      kind: "terminal", index: 1, requirement: admission.requirement, verdict: "satisfied", admission: "admitted",
    }]);
    assert.equal(error.outcome.placement, undefined);
    return true;
  });
});

test("native cancellation preserves an existing category without constructing a partial preview", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: "main", gates: [] }));
  const before = present(await bound.kei.state());
  const cause = new TypeError("original caller cause");
  const reason = Object.freeze(new KeiyakuError("authority-corruption", "categorized caller stop", { cause }));
  for (const stop of [Object.freeze(new Error("caller stopped")), reason]) {
    await assert.rejects(bound.kei.deliver({ signal: AbortSignal.abort(stop) }), (error) => error === stop);
  }
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
    if (error === reason) return true;
    assert.equal(error.category, reason.category);
    assert.equal(error.cause, reason);
    assert.ok(error.outcome?.kind === "contract");
    assert.ok(error.outcome.issues?.length);
    assert.deepEqual(error.outcome, { kind: "contract", contractId: before.id, issues: error.outcome.issues });
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
    try {
      await withGitDecodeChannel(scope, (channel) => withGitReadObservation(scope, channel, async (epoch) => {
        await epoch.readBlobs(["0".repeat(40)]);
        throw failure;
      }));
    } catch (error) {
      caught = true;
      assert.equal(error, failure);
    }
    assert.equal(caught, true);
  }
});

test("native delivery JSON retains its direct accepted answer", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), gates: [] }));
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
});

test("native delivery retains completed Debt settlement before terminal cleanup fails", async () => {
  const { Debts } = await import("../src/debt/index.js");
  const { World } = await import("../src/world.js");
  const repository = repositoryWithMain();
  const world = await World.at(repository.path);
  const debt = await Debts.of(world).add({ title: "Settlement before cleanup" });
  assert.ok(debt.kind === "accepted");
  repository.run(["add", ".keiyaku/debts"]);
  repository.run(["commit", "--quiet", "-m", "Debt authority"]);
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), debt: debt.id, gates: [] }));
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
    assert.equal(error.cause.category, "authority-corruption");
    assert.match(error.cause.message, /has an undecodable document/u);
    assert.ok(error.cause.cause instanceof KeiyakuError);
    assert.equal(error.cause.cause.category, "invalid-input");
    assert.ok(error.message.includes(id));
    return true;
  });
});

test("native preview leaves no preview answer when target-lag observation throws", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo).bind({ terms: document("true"), target: "main", gates: ["reviewed", "verified"] }),
  );
  const base = scopeForRepo(repo);
  const original = new TypeError("unexpected native target lag observation failure");
  const scope = {
    ...base,
    get gitPath(): string {
      if (new Error().stack?.includes("observeTargetLag")) throw original;
      return base.gitPath;
    },
  };
  const native = createKeiHandle(bound.contractId, scope, captureLocalContractComposition());
  const witnessedHead = present(await bound.kei.state()).head;
  await assert.rejects(native.previewDelivery(), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "internal");
    assert.equal(error.cause, original);
    assert.deepEqual(error.outcome, { kind: "contract", contractId: bound.contractId });
    return true;
  });
  assert.equal(present(await bound.kei.state()).head, witnessedHead);
});

test("native bind retains its admission and handle when a later finite read fails before appointment", async () => {
  const repository = repositoryWithMain();
  await withGitShim(
    'if [ "$1 $2" = "cat-file --batch" ]; then "$KEIYAKU_REAL_GIT" "$@"; exit 73; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    {},
    async (gitPath) => {
      const repo = await Repo.at({ path: repository.path, gitPath });
      const result = accepted(await Keis.of(repo).bind({ terms: document(), gates: [] }));
      assert.ok(result.kei instanceof Kei);
      assert.equal(result.worktreePath, undefined);
      const healthy = Keis.of(await Repo.at({ path: repository.path })).kei({ id: result.contractId });
      const state = present(await healthy.state());
      assert.equal(state.id, result.contractId);
      assert.equal(state.terminal, null);
      assert.ok(result.issues?.some((issue) => issue.severity === "required" &&
        "diagnostic" in issue && /git exited with status 73/u.test(issue.diagnostic)), JSON.stringify(result));
      assert.equal(classifyVerb("bind", { terms: document() }, { kind: "returned", value: result }), "failed");
      await assert.rejects(result.kei.previewDelivery(), /git exited with status 73/u);
    },
  );
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

test("native terminal removal survives a subsequent malformed ref read, including its retirement marker", async () => {
  const repository = repositoryWithMain();
  const marker = join(repository.path, ".git", "removed-before-broken-ref");
  await withGitShim(
    failAfterTerminalRemoval,
    { KEIYAKU_REMOVAL_MARKER: marker },
    async (gitPath) => {
      const repo = await Repo.at({ path: repository.path, gitPath });
      const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: "main", gates: [] }));
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
