import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { Keis, Keiyaku, KeiyakuError, Repo, Settings } from "../src/index.js";
import { verifyOutcomeSchema } from "../src/library/contract-outcomes.js";
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { assertWireConformance, assertWireRoundTrip } from "./support/schema-parity.js";
import { contractObservationSchema } from "../src/protocol/read/status.js";
import { InvocationAccumulator } from "../src/library/invocation.js";
import { project } from "../src/library/outcome.js";
import { VERIFICATION_REF_NAMESPACE, verificationSnapshotRef } from "../src/git/repository.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { appointedWorktreePath, cachedRepositoryAt, withGitShim } from "./support/git.js";
import { accepted, commitCandidate, document, present, repositoryWithMain } from "./support/library-verbs.js";

const verifyNormalOutcomeSchema = Keiyaku.verbs.verify.normal;

function verificationFences(scripts: readonly string[]): string {
  return scripts.map((script) => `\`\`\`bash timeout=1m\n${script}\n\`\`\``).join("\n\n") + "\n";
}

async function fixture(scripts: readonly string[], gates = ["reviewed", "verified"], mode?: "optimistic" | "strict", target: string | null = "refs/heads/main") {
  const repository = repositoryWithMain();
  if (target === null) repository.run(["config", "core.logAllRefUpdates", "false"]);
  if (mode !== undefined) {
    mkdirSync(join(repository.path, ".keiyaku"), { recursive: true });
    writeFileSync(join(repository.path, ".keiyaku", "settings.json"), JSON.stringify({ verification: { mode } }));
  }
  const settings = mode === undefined ? undefined : await Settings.load({ cwd: repository.path, home: join(repository.path, ".git", "home") });
  const contract = accepted(await Keis.of(await Repo.at({ path: repository.path }), settings === undefined ? undefined : { settings }).bind({
    terms: scripts.length === 0 ? document() : `${document()}\n## Verification\n\n${verificationFences(scripts)}`, gates, target,
  })).kei;
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), present(await contract.state()).id);
  commitCandidate(repository, worktree);
  return { repository, contract, worktree };
}

function collectGitObjects(repository: ReturnType<typeof repositoryWithMain>): void {
  repository.run(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
  repository.run(["gc", "--prune=now"]);
}

function pinnedSnapshots(repository: ReturnType<typeof repositoryWithMain>): string[] {
  return repository.run(["for-each-ref", "--format=%(objectname)", VERIFICATION_REF_NAMESPACE]).trim().split("\n").filter(Boolean);
}

test("distinct admitted snapshots survive GC and repair through exact delivery and retirement", async () => {
  const { repository, contract, worktree } = await fixture(["true", "grep -qx candidate candidate.txt"]);
  const head = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  let concurrent: ReturnType<typeof contract.verify> | undefined;
  let atAdmission: string[] | undefined;
  const first = accepted(await contract.verify({ index: 1 }, { observe: (event) => {
    if (event.kind === "admitted" && event.fact.kind === "attestation") atAdmission = pinnedSnapshots(repository);
    if (event.kind !== "verification" || event.observation.kind !== "phase" || event.observation.state !== "started" ||
        event.observation.phase !== "materialize") return;
    repository.run(["gc"]);
    writeFileSync(join(worktree, "candidate.txt"), "changed\n");
    repository.run(["-C", worktree, "commit", "-aqm", "change the captured tree"]);
    concurrent = contract.verify({ index: 2 });
  } }));
  assert.ok(concurrent);
  const red = accepted(await concurrent);
  assert.ok(atAdmission?.includes(first.snapshot));
  const check = first.checks[0];
  assert.ok(check?.kind === "terminal" && check.index === 1 && check.verdict === "satisfied" && check.admission === "admitted");
  assert.ok(red.checks[0]?.kind === "terminal" && red.checks[0].verdict === "unsatisfied" && red.checks[0].admission === "admitted");
  const ref = (snapshot: typeof first.snapshot) => verificationSnapshotRef(first.contractId, snapshot);
  const expected = [first.snapshot, red.snapshot].sort();
  assert.deepEqual(pinnedSnapshots(repository).sort(), expected);
  const before = present(await contract.state());
  repository.run(["update-ref", "-d", ref(red.snapshot)]);
  const reused = accepted(await contract.verify({ index: 2 })).checks[0];
  assert.ok(reused?.kind === "terminal" && reused.admission === "reused" && reused.retainedPath);
  repository.run(["worktree", "remove", "--force", reused.retainedPath]);
  repository.run(["update-ref", "-d", ref(first.snapshot)]);
  await Keis.of(await Repo.at({ path: repository.path })).reconcile({ contract: first.contractId });
  assert.deepEqual(present(await contract.state()), before);
  collectGitObjects(repository);
  assert.deepEqual(pinnedSnapshots(repository).sort(), expected);
  for (const snapshot of expected) assert.equal(repository.run(["cat-file", "-t", snapshot]).trim(), "commit");

  repository.run(["-C", worktree, "reset", "--hard", head]);
  accepted(await contract.amend({ edits: "## Replace: Objective\n\nSame candidate with revised author intent.\n" }));
  const delivered = accepted(await contract.deliver());
  assert.equal(delivered.integration, first.snapshot);
  assert.ok(delivered.placement?.kind === "gates-unsatisfied");
  assert.equal(delivered.placement.unmet.some(({ requirement }) => requirement === check.requirement), false);
  repository.run(["update-ref", "refs/foreign/retain", red.snapshot]);
  const review = accepted(await contract.review({ verdict: "satisfied", summary: "Verification review passed" }));
  assert.equal(review.placement?.kind, "gates-unsatisfied");
  const final = accepted(await contract.verify({ index: 2 }));
  assert.ok(final.placement?.kind === "placed" && final.placement.integration === first.snapshot);
  assert.deepEqual(pinnedSnapshots(repository), []);
  assert.equal(repository.run(["rev-parse", "refs/heads/main", "refs/foreign/retain"]), `${first.snapshot}\n${red.snapshot}\n`);
});

for (const scenario of ["clean", "dirty", "lost"] as const) {
  test(`Verification custody at selection: ${scenario}`, async () => {
    const dirty = scenario === "dirty";
    const lost = scenario === "lost";
    const { repository, contract, worktree } = await fixture([`grep -qx ${dirty ? "dirty" : "candidate"} candidate.txt`], ["verified"], undefined, lost ? "refs/heads/main" : null);
    const before = present(await contract.state());
    const capture = join(repository.path, ".git", "capture");
    if (dirty) writeFileSync(join(worktree, "candidate.txt"), "dirty\n");
    if (scenario === "clean") {
      const head = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
      writeFileSync(capture, `${head}\n`);
      utimesSync(join(repository.path, ".git", "objects", head.slice(0, 2), head.slice(2)), 0, 0);
    }
    let declared = false;
    const result = accepted(await withGitShim(`
      case " $* " in
        " commit-tree "*)
          "$KEIYAKU_REAL_GIT" "$@" > "$CAPTURE" || exit "$?"
          if [ "$CASE" = lost ]; then "$KEIYAKU_REAL_GIT" prune --expire=now || exit "$?"; fi
          exec /bin/cat "$CAPTURE" ;;
        *" diff --no-ext-diff "*)
          [ "$CASE" = lost ] && exec "$KEIYAKU_REAL_GIT" "$@"
          read -r oid < "$CAPTURE"
          if [ "$CASE" = clean ]; then
            "$KEIYAKU_REAL_GIT" -C "$WORKTREE" update-ref --no-deref HEAD "$START" "$oid" || exit "$?"
          fi
          "$KEIYAKU_REAL_GIT" worktree list --porcelain | grep -Fqx "HEAD $oid" || exit 93
          "$KEIYAKU_REAL_GIT" gc || exit "$?"
          mv "$CAPTURE" "$CAPTURE.checked" || exit "$?" ;;
      esac
      exec "$KEIYAKU_REAL_GIT" "$@"
    `.trim(), { CAPTURE: capture, CASE: scenario, WORKTREE: worktree, START: before.coordinates.start },
    async (gitPath) => await Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({ id: before.id }).verify({ includeDirty: dirty }, { observe: (event) => {
      if (event.kind === "verification" && event.observation.kind === "phase" && event.observation.phase === "declaration") declared = true;
    } })));
    const check = result.checks[0];
    assert.equal(result.snapshot, readFileSync(lost ? capture : `${capture}.checked`, "utf8").trim());
    assert.equal(declared, !lost);
    if (lost) {
      assert.ok(check?.kind === "stopped" && check.stop.kind === "candidate-unavailable");
      assert.equal(repository.run(["cat-file", "--batch-check"], `${result.snapshot}\n`), `${result.snapshot} missing\n`);
      assert.deepEqual(present(await contract.state()), before);
    } else {
      assert.ok(check?.kind === "terminal" && check.verdict === "satisfied" && check.admission === "admitted");
    }
    assert.deepEqual(pinnedSnapshots(repository), lost ? [] : [result.snapshot]);
    assert.doesNotMatch(repository.run(["worktree", "list", "--porcelain"]), /keiyaku-v4-verify-/u);
  });
}

test("targeted dirty merge planning judges the committed workspace head against main", async () => {
  const repository = repositoryWithMain();
  mkdirSync(join(repository.path, ".keiyaku"));
  writeFileSync(join(repository.path, ".keiyaku", "settings.json"), JSON.stringify({
    git: { requireBranchesToBeUpToDate: true },
  }));
  const settings = await Settings.load({ cwd: repository.path, home: join(repository.path, ".git", "home") });
  const contract = accepted(await Keis.of(await Repo.at({ path: repository.path }), { settings }).bind({
    terms: document("true"), gates: ["verified"], target: "refs/heads/main",
  })).kei;
  try {
    const before = present(await contract.state());
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), before.id);
    commitCandidate(repository, worktree);
    const head = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
    writeFileSync(join(repository.path, "target.txt"), "main\n");
    repository.run(["add", "target.txt"]);
    repository.run(["commit", "--quiet", "-m", "advance main"]);
    const targetHead = repository.run(["rev-parse", "refs/heads/main"]).trim();
    repository.run(["-C", worktree, "merge", "--no-commit", targetHead]);
    assert.equal(repository.run(["merge-base", head, targetHead]).trim(), before.coordinates.start);
    assert.equal(repository.run(["-C", worktree, "rev-parse", "MERGE_HEAD"]).trim(), targetHead);

    const reason = { kind: "not-based-on-target", targetHead };
    const preview = await contract.previewDelivery({ includeDirty: true });
    assert.ok(preview.kind === "blocked", JSON.stringify(preview));
    assert.deepEqual(preview.reason, reason);
    const verified = await contract.verify({ index: 1, includeDirty: true });
    assert.ok(verified.kind === "refused", JSON.stringify(verified));
    assert.deepEqual(verified.reason, reason);
    assert.deepEqual(present(await contract.state()), before);
    assert.equal(repository.run(["-C", worktree, "rev-parse", "HEAD", "MERGE_HEAD"]), `${head}\n${targetHead}\n`);
  } finally {
    accepted(await contract.abandon());
  }
});

test("literal bytes govern checkout, admission, and repair in the presence of replacements", async () => {
  const { repository, contract } = await fixture(["true", "grep -qx candidate candidate.txt", "test -f candidate.txt"]);
  const { contractId, snapshot } = accepted(await contract.verify({ index: 1 }));
  const pin = verificationSnapshotRef(contractId, snapshot);
  const [tree, parent] = repository.run(["show", "-s", "--format=%T %P", snapshot]).trim().split(" ");
  assert.ok(tree && parent);
  repository.run(["replace", snapshot, parent]);
  const literal = accepted(await contract.verify({ index: 2 })).checks[0];
  assert.ok(literal?.kind === "terminal" && literal.verdict === "satisfied" && literal.admission === "admitted");
  const before = present(await contract.state());
  const replacement = repository.run(["commit-tree", tree, "-p", parent, "-m", "same tree, different commit"]).trim();
  repository.run(["replace", "-f", snapshot, replacement]);
  const loose = join(repository.path, ".git", "objects", snapshot.slice(0, 2), snapshot.slice(2));
  const displaced = `${loose}.displaced`;
  for (const index of [3, 1]) {
    const result = accepted(await contract.verify({ index }, { observe: (event) => {
      if (event.kind === "verification" && event.observation.kind === "phase" &&
          event.observation.phase === "cleanup" && event.observation.state === "finished") renameSync(loose, displaced);
    } }));
    const check = result.checks[0];
    assert.ok(check?.kind === "terminal" && check.verdict === "satisfied" && typeof check.admission !== "string");
    assert.equal(check.admission.kind, "candidate-unavailable");
    assert.equal(classifyVerb("verify", {}, { kind: "returned", value: result }), "failed");
    assert.equal(repository.run(["rev-parse", "--verify", pin]).trim(), snapshot);
    renameSync(displaced, loose);
    assert.deepEqual(present(await contract.state()), before);
  }
  repository.run(["update-ref", "-d", pin]);
  collectGitObjects(repository);
  assert.equal(repository.run(["--no-replace-objects", "cat-file", "--batch-check"], `${snapshot}\n`), `${snapshot} missing\n`);
  assert.equal(repository.run(["cat-file", "-t", snapshot]).trim(), "commit");
  const result = await Keis.of(await Repo.at({ path: repository.path })).reconcile({ contract: contractId });
  assert.ok(result.kind === "contract" && result.issues?.some((issue) =>
    "diagnostic" in issue && issue.diagnostic.includes(`Verification snapshot unavailable: ${snapshot}`)));
  assert.deepEqual(pinnedSnapshots(repository), []);
  const { integration } = accepted(await contract.deliver({ message: "Fresh delivery after literal object loss" }));
  assert.ok(integration !== snapshot && integration !== replacement);
  assert.equal(repository.run(["--no-replace-objects", "show", "-s", "--format=%T %P", integration]).trim(), `${tree} ${parent}`);
});

test("native pin publication failure leaves earlier Verification testimony intact", async () => {
  const { repository, contract } = await fixture(["true", "test -f candidate.txt", "exit 9"]);
  const { contractId, snapshot } = accepted(await contract.verify({ index: 2 }));
  const pin = verificationSnapshotRef(contractId, snapshot);
  const lock = join(repository.path, ".git", `${pin}.lock`);
  const before = present(await contract.state());
  for (const reuse of [false, true]) {
    const result = accepted(await contract.verify(reuse ? {} : { index: 1 }, { observe: (event) => {
      if (event.kind !== "verification" || event.observation.kind !== "phase" || event.observation.phase !== "cleanup" ||
          event.observation.state !== "finished" || event.observation.index !== (reuse ? 2 : 1)) return;
      repository.run(["update-ref", "-d", pin]);
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(lock, "", { flag: "wx" });
    } }));
    unlinkSync(lock);
    assert.deepEqual(result.checks.map((check) => check.index), reuse ? [1, 2] : [1]);
    const stopped = result.checks.at(-1);
    assert.ok(stopped?.kind === "terminal" && stopped.verdict === "satisfied" && typeof stopped.admission !== "string");
    assert.ok(stopped.admission.kind === "retry" && stopped.admission.reason === "publication-failed");
    assert.ok(stopped.admission.diagnostic.includes(`${pin}.lock`));
    const after = present(await contract.state());
    if (!reuse) assert.deepEqual(after, before);
    else {
      const first = result.checks[0];
      assert.ok(first?.kind === "terminal" && first.admission === "admitted");
      assert.deepEqual(after.attestations.map(({ data }) => data.requirement), [stopped.requirement, first.requirement]);
    }
    assert.deepEqual(pinnedSnapshots(repository), []);
  }
  assert.doesNotMatch(repository.run(["worktree", "list", "--porcelain"]), /keiyaku-v4-verify-/u);
});

test("each declaration executes in fresh scratch and terminal failure preserves later evidence and scenes", async () => {
  const { contract } = await fixture(["echo created > scratch-only", "test -f scratch-only", "exit 7", "true"]);
  const verified = accepted(await contract.verify());
  assertWireConformance(verifyNormalOutcomeSchema, verified);
  assert.deepEqual(verified.checks.map((check) => check.kind === "terminal" ? check.verdict : check.kind),
    ["satisfied", "unsatisfied", "unsatisfied", "satisfied"]);
  assert.equal(present(await contract.state()).attestations.length, 4);
  const scenes = verified.checks.flatMap((check) => check.retainedPath === undefined ? [] : [check.retainedPath]);
  assert.equal(scenes.length, 2);
  assert.notEqual(scenes[0], scenes[1]);
  assert.ok(scenes.every(existsSync));
  const repeated = accepted(await contract.verify({ index: 2 }));
  assertWireConformance(verifyNormalOutcomeSchema, repeated);
  const replay = repeated.checks[0];
  assert.ok(replay?.kind === "terminal" && replay.admission === "reused");
  assert.equal(present(await contract.state()).attestations.length, 4);
  assert.ok(existsSync(scenes[1]!));
  await contract.abandon();
  assert.ok(scenes.every((scene) => !existsSync(scene)));
});

test("a later setup stop preserves an earlier red admission and outranks its verdict", async () => {
  const { repository, contract, worktree } = await fixture(["exit 7", "true", "true"]);
  const marker = join(repository.path, ".git", "setup-once");
  mkdirSync(join(worktree, ".keiyaku"), { recursive: true });
  writeFileSync(join(worktree, ".keiyaku", "settings.json"), JSON.stringify({ worktree: { create: [{
    name: "prepare-once",
    argv: [process.execPath, "-e", `const fs=require('node:fs'); const path=${JSON.stringify(marker)}; if(fs.existsSync(path)) process.exit(9); fs.writeFileSync(path,'prepared');`],
    timeoutMs: 5_000,
  }] } }));
  repository.run(["-C", worktree, "add", ".keiyaku/settings.json"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "setup stops after the first declaration"]);
  const result = accepted(await contract.verify());
  assert.equal(result.checks.length, 2);
  const [red, stopped] = result.checks;
  assert.ok(red?.kind === "terminal" && red.verdict === "unsatisfied");
  assert.equal(red.admission, "admitted");
  assert.ok(stopped?.kind === "stopped" && stopped.stop.kind === "environment-hook-failure");
  assert.equal(stopped.stop.name, "prepare-once");
  assert.equal(stopped.index, 2);
  assert.ok(result.checks.every((check) => check.retainedPath !== undefined && existsSync(check.retainedPath)));
  const text = renderVerb("verify", {}, { kind: "returned", value: result }, { columns: 400, color: false });
  assert.match(text, /^  check {2}1\n  requirement {2}[^\n]+\n  verdict {2}unsatisfied\n  admission {2}admitted$/mu);
  assert.match(text, /^  check {2}2\n  requirement {2}[^\n]+\n  execution {2}stopped$/mu);
  assert.ok(text.includes("prepare-once"));
  assert.ok(result.checks.every((check) => text.includes(check.retainedPath!)));
  const testimony = present(await contract.state()).attestations;
  assert.equal(testimony.length, 1);
  assert.equal(testimony[0]?.data.requirement, red.requirement);
  assert.equal(classifyVerb("verify", {}, { kind: "returned", value: result }), "failed");
  const wire = JSON.parse(JSON.stringify(result));
  assert.deepEqual(verifyOutcomeSchema.parse(wire), wire);
  assertWireConformance(verifyNormalOutcomeSchema, result, false);
  await contract.abandon();
});

test("normal red checks retain optional retirement residue while required retirement remains an error", async () => {
  const { repository, contract, worktree } = await fixture(["exit 7"]);
  mkdirSync(join(worktree, ".keiyaku"), { recursive: true });
  writeFileSync(join(worktree, ".keiyaku", "settings.json"), JSON.stringify({ worktree: { destroy: [{
    name: "diagnostic-cleanup", argv: [process.execPath, "-e", "process.exit(9)"], timeoutMs: 5_000,
  }] } }));
  repository.run(["-C", worktree, "add", ".keiyaku/settings.json"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "retain cleanup diagnosis"]);
  try {
    const normal = accepted(await contract.verify());
    assert.ok(normal.issues?.some(issue => issue.severity === "optional" && issue.kind === "diagnostic"));
    assert.equal(classifyVerb("verify", {}, { kind: "returned", value: normal }), "unsatisfied");
    assertWireConformance(verifyNormalOutcomeSchema, normal);
    const trailing = new InvocationAccumulator();
    trailing.recordResidue(normal.contractId, { seatClose: [{
      kind: "private-state-seat-close-failed", diagnostic: "required admission retirement failed",
    }] });
    const { issues: _residue, ...conclusion } = normal;
    const projected = project<typeof normal>("verify", trailing.snapshot(), conclusion);
    assert.ok(projected.kind === "returned");
    const stopped = projected.outcome;
    assert.ok(stopped.checks.some(check => check.kind === "terminal" && check.verdict === "unsatisfied"));
    assert.ok(stopped.issues?.some(issue => issue.severity === "required"));
    assert.equal(classifyVerb("verify", {}, { kind: "returned", value: stopped }), "failed");
    assertWireConformance(verifyOutcomeSchema, stopped);
    assertWireConformance(verifyNormalOutcomeSchema, stopped, false);
  } finally { await contract.abandon(); }
});

test("strict currency keeps prior checks tied to their tested snapshot after target movement", async () => {
  const { repository, contract } = await fixture(["true", "test -f candidate.txt"], undefined, "strict");
  accepted(await contract.deliver());
  const original = accepted(await contract.verify());
  writeFileSync(join(repository.path, "target-only.txt"), "moved\n");
  repository.run(["add", "target-only.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance target"]);
  const reviewed = accepted(await contract.review({ verdict: "satisfied", summary: "Verification review passed" }));
  assert.ok(reviewed.placement?.kind === "gates-unsatisfied");
  const currentSnapshot = present(await contract.state()).currentIntegration!.snapshot;
  const reason = { kind: "snapshot-changed", previousSnapshot: original.snapshot, currentSnapshot };
  assert.ok(original.checks.every((check) => check.kind === "terminal" && check.verdict === "satisfied"));
  assert.deepEqual(reviewed.placement.unmet.map((problem) => problem.state === "stale" ? problem.reason : undefined), [reason, reason]);
  const receipt = renderVerb("review", { contract: reviewed.contractId, verdict: "satisfied",
    summary: "Verification review passed" }, { kind: "returned", value: reviewed }, { columns: 400, color: false });
  assert.ok(receipt.includes("stale reason  snapshot changed"));
  assert.ok(receipt.includes(`previous snapshot  ${original.snapshot}`));
  assert.ok(receipt.includes(`current snapshot  ${currentSnapshot}`));
  const detail = await Keis.of(await Repo.at({ path: repository.path })).observe({ id: reviewed.contractId });
  assertWireRoundTrip(contractObservationSchema, detail);
  assert.ok(detail.kind === "contract");
  const stale = { kind: "stale", priorVerdict: "satisfied", reason };
  assert.deepEqual(detail.gates?.find(({ gate }) => gate === "verified"), {
    gate: "verified",
    current: "stale",
    requirements: original.checks.map(({ requirement, index }) => ({ requirement, index, current: stale })),
  });
  const next = accepted(await contract.verify({ index: 1 }));
  assert.notEqual(next.snapshot, original.snapshot);
  assert.equal(next.placement?.kind, "gates-unsatisfied");
  const completed = accepted(await contract.verify({ index: 2 }));
  assert.equal(completed.placement?.kind, "placed");
});

test("optimistic currency preserves testimony across clean reintegration without executing checks again", async () => {
  const { repository, contract } = await fixture(["test -f candidate.txt"]);
  const original = accepted(await contract.verify());
  accepted(await contract.deliver());
  const before = present(await contract.state()).attestations;
  writeFileSync(join(repository.path, "target-only.txt"), "moved\n");
  repository.run(["add", "target-only.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance target"]);
  const preview = await contract.previewDelivery();
  assert.ok(preview.kind === "ready");
  assert.notEqual(preview.integration, original.snapshot);
  assert.deepEqual(preview.unmetGates?.map(({ gate }) => gate), ["reviewed"]);
  const reviewed = accepted(await contract.review({ verdict: "satisfied", summary: "Unchanged candidate after target movement" }));
  assert.ok(reviewed.placement?.kind === "placed");
  assert.notEqual(reviewed.placement.integration, original.snapshot);
  const final = present(await contract.state());
  assert.deepEqual(final.attestations.filter(({ data }) => data.gate === "verified"), before);
  assert.equal(final.terminal?.kind, "claimed");
});

test("cancellation after terminal execution retains the check and stops its admission", async () => {
  const { repository, contract } = await fixture(["true", "printf second", "printf never"]);
  const controller = new AbortController();
  let thirdExecuted = false;
  let result;
  let failure: KeiyakuError | undefined;
  try {
    result = await contract.verify({ signal: controller.signal }, { observe: (event) => {
      if (event.kind !== "verification" || event.observation.kind !== "phase") return;
      if (event.observation.index === 3 && event.observation.phase === "declaration") thirdExecuted = true;
      if (event.observation.index === 2 && event.observation.phase === "declaration" && event.observation.state === "finished")
        controller.abort(new Error("cancel after terminal execution"));
    } });
  } catch (error) {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "aborted");
    assert.ok(error.outcome?.kind === "contract");
    failure = error;
    result = error.outcome;
  }
  assert.ok(result && "checks" in result && result.checks);
  assert.deepEqual(result.checks.map((check) => check.kind === "terminal"
    ? [check.index, check.verdict, check.admission] : [check.index, check.kind]),
  [[1, "satisfied", "admitted"], [2, "satisfied", { kind: "cancelled" }]]);
  const text = result.kind === "contract"
    ? renderVerb("verify", {}, { kind: "threw", error: failure }, { columns: 400, color: false })
    : renderVerb("verify", {}, { kind: "returned", value: result }, { columns: 400, color: false });
  assert.match(text, /^  check {2}1\n  requirement {2}[^\n]+\n  verdict {2}satisfied\n  admission {2}admitted$/mu);
  assert.match(text, /^  check {2}2\n  requirement {2}[^\n]+\n  verdict {2}satisfied\n  admission {2}stopped$/mu);
  assert.match(text, /^  reason {2}cancelled$/mu);
  assert.equal(present(await contract.state()).attestations.length, 1);
  assert.deepEqual(pinnedSnapshots(repository), [result.snapshot]);
  assert.doesNotMatch(repository.run(["worktree", "list", "--porcelain"]), /keiyaku-v4-verify-/u);
  assert.equal(thirdExecuted, false);
  assertWireConformance(verifyNormalOutcomeSchema, result, false);
  await contract.abandon();
});

test("changed failure testimony admits a new attestation while identical testimony reuses it", async () => {
  const { repository, contract } = await fixture(["true"]);
  const output = join(repository.path, "failure-output");
  writeFileSync(output, "first failure");
  accepted(await contract.amend({ edits: `## Replace: Verification\n\n\`\`\`bash timeout=1m\ncat '${output}'; exit 1\n\`\`\`\n` }));
  accepted(await contract.deliver());
  const first = accepted(await contract.verify()).checks[0]!;
  assert.ok(first.kind === "terminal" && first.admission === "admitted");
  const firstState = present(await contract.state());
  writeFileSync(output, "second failure");
  const verified = accepted(await contract.verify());
  const second = verified.checks[0]!;
  assert.ok(second.kind === "terminal" && second.verdict === "unsatisfied" && second.admission === "admitted");
  assert.match(second.summary, /second failure/u);
  const state = present(await contract.state());
  assert.equal(state.attestations.length, 2);
  assert.notEqual(state.attestations.at(-1)?.entry, firstState.attestations.at(-1)?.entry);
  assert.equal(state.attestations.at(-1)?.data.summary, second.summary);
  assert.equal(verified.placement?.kind, "gates-unsatisfied");
  const repeated = accepted(await contract.verify());
  const check = repeated.checks[0]!;
  assert.ok(check.kind === "terminal");
  assert.equal(check.admission, "reused");
  assert.equal(present(await contract.state()).attestations.length, 2);
  await contract.abandon();
});

test("addressed status keeps native Verification evidence as declarations reorder and change", async () => {
  const passing = "test -f candidate.txt";
  const failing = "echo failed; exit 1";
  const { repository, contract } = await fixture([passing, failing]);
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  accepted(await contract.deliver());
  const { checks: [pass, fail] } = accepted(await contract.verify());
  assert.ok(pass?.kind === "terminal" && pass.verdict === "satisfied");
  assert.ok(fail?.kind === "terminal" && fail.verdict === "unsatisfied");
  const [passAttestation, failAttestation] = present(await contract.state()).attestations;
  assert.ok(passAttestation && failAttestation);
  const passed = { kind: "attested", verdict: "satisfied", at: passAttestation.at };
  const failed = { kind: "attested", verdict: "unsatisfied", at: failAttestation.at, summary: fail.summary };
  const checked = { gate: "verified", current: "unsatisfied" };
  const passedRequirement = { requirement: pass.requirement, current: passed };
  const failedRequirement = { requirement: fail.requirement, current: failed };
  const amend = async (...scripts: string[]) =>
    accepted(await contract.amend({ edits: `## Replace: Verification\n\n${verificationFences(scripts)}` }));
  const readGate = async (checkWire = false) => {
    const detail = await contracts.observe({ id: contract.id });
    if (checkWire) assertWireRoundTrip(contractObservationSchema, detail);
    assert.ok(detail.kind === "contract");
    return detail.gates?.find(({ gate }) => gate === "verified");
  };

  assert.deepEqual(await readGate(true), {
    ...checked,
    requirements: [{ ...passedRequirement, index: 1 }, { ...failedRequirement, index: 2 }],
  });
  await amend(failing, passing);
  assert.deepEqual(await readGate(), {
    ...checked,
    requirements: [{ ...failedRequirement, index: 1 }, { ...passedRequirement, index: 2 }],
  });
  await amend(passing, "echo changed");
  assert.deepEqual((await readGate())?.requirements.map(({ current }) => current.kind), ["attested", "missing"]);
  await amend(passing);
  assert.deepEqual(await readGate(), {
    gate: "verified",
    current: "satisfied",
    requirements: [{ ...passedRequirement, index: 1 }],
  });
  accepted(await contract.abandon());
});
