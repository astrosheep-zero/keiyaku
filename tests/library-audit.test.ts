import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, Repo, type ContractId } from "../src/index.js";
import { adjudicateAuditTarget } from "../src/git/target-placement.js";
import { releaseManagedWorktrees } from "../src/workspace-place.js";
import { appointedWorktreePath, cachedRepoAt, cachedRepositoryAt, withGitShim } from "./support/git.js";
import { bind, commitCandidate, document, refused, repositoryWithMain } from "./support/library-verbs.js";

test("pre-delivery audit candidate matches a later unchanged deliver", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);

  const audited = await contract.audit();
  assert.equal(audited.value.candidate.kind, "ready");
  if (audited.value.candidate.kind !== "ready") return;
  assert.deepEqual(
    audited.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(
    audited.facts.some((fact) => fact.kind === "deliver" || fact.kind === "claimed" || fact.kind === "bound"),
    false,
  );
  assert.equal(audited.value.verification.kind, "satisfied");
  if (audited.value.verification.kind !== "satisfied") return;
  assert.equal(audited.value.verification.passed, 1);
  assert.equal(audited.value.verification.total, 1);
  assert.equal(audited.value.target.kind, "not-observed");
  assert.equal((await contract.state()).delivery, null);
  assert.equal((await contract.state()).terminal, null);

  const delivered = await contract.deliver();
  assert.equal(delivered.value.tenderSnapshot, audited.value.candidate.identity.tenderSnapshot);
  assert.deepEqual(delivered.value.integration, audited.value.candidate.identity.integration);
  assert.equal(delivered.value.method, audited.value.candidate.identity.method);
  assert.deepEqual(delivered.value.policy, audited.value.candidate.identity.policy);
  assert.equal(delivered.value.verificationReuse?.verdict, "satisfied");
  assert.deepEqual(delivered.value.completion, {
    integration: delivered.value.integration.snapshot,
    verification: { mode: "reused", verdict: "satisfied" },
  });
  assert.equal(
    delivered.facts.some((fact) => fact.kind === "attestation"),
    false,
  );
});

test("unchanged deliver reuses unsatisfied pre-delivery audit Verification", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 1");
  commitCandidate(repository);

  const audited = await contract.audit();
  assert.equal(audited.value.candidate.kind, "ready");
  if (audited.value.candidate.kind !== "ready") return;
  assert.deepEqual(
    audited.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(audited.facts[0]?.data.verdict, "unsatisfied");
  assert.equal(audited.value.verification.kind, "unsatisfied");
  if (audited.value.verification.kind !== "unsatisfied") return;
  assert.equal(audited.value.verification.passed, 0);
  assert.equal(audited.value.verification.total, 1);
  const reused = audited.facts[0];
  if (reused === undefined) return;

  const delivered = await contract.deliver();
  assert.deepEqual(delivered.value.integration, audited.value.candidate.identity.integration);
  assert.equal(delivered.value.verificationReuse?.verdict, "unsatisfied");
  assert.equal(delivered.value.verificationReuse?.entry, reused.entry);
  assert.equal(
    delivered.facts.some((fact) => fact.kind === "attestation"),
    false,
  );
  const placement = delivered.value.placement;
  assert.equal(placement?.refusal.kind, "gates-unsatisfied");
  if (placement?.refusal.kind !== "gates-unsatisfied") return;
  assert.deepEqual(
    placement.refusal.unmet.map(({ gate, current }) => ({
      gate,
      kind: current.kind,
      verdict: current.kind === "attested" ? current.verdict : undefined,
    })),
    [{ gate: "verified", kind: "attested", verdict: "unsatisfied" }],
  );
  const observed = await Keiyaku.observe({
    repo: await cachedRepoAt(repository.path),
    id: (await contract.state()).id,
  });
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") return;
  assert.equal(observed.row.gates.satisfied, false);
  const current = observed.row.gates.reports[0]?.current;
  assert.equal(current?.kind, "attested");
  if (current?.kind !== "attested") return;
  assert.equal(new Date(current.at).toISOString(), current.at);
  assert.deepEqual(observed.row.gates.reports, [
    {
      gate: "verified",
      current: { kind: "attested", verdict: "unsatisfied", summary: "[1 bash exit 1]", at: current.at },
    },
  ]);
});

test("Verification declarations receive ambient environment and reuse matching testimony", async () => {
  const environmentName = "KEIYAKU_TEST_VERIFICATION_HOST_ENVIRONMENT";
  const prior = process.env[environmentName];
  try {
    const repository = repositoryWithMain();
    const contract = await bind(repository, `test "\${${environmentName}-}" = first`);
    commitCandidate(repository);

    process.env[environmentName] = "first";
    const first = await contract.audit();
    process.env[environmentName] = "second";
    const second = await contract.audit();

    assert.equal(first.value.verification.kind, "satisfied");
    assert.equal(second.value.verification.kind, "unsatisfied");
    assert.deepEqual(
      first.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    assert.deepEqual(
      second.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    assert.deepEqual(second.facts[0]?.data.subject, first.facts[0]?.data.subject);

    const delivered = await contract.deliver();
    assert.equal(delivered.value.verificationReuse?.entry, second.facts[0]?.entry);
    assert.equal(delivered.value.verificationReuse?.verdict, "unsatisfied");
    assert.equal(
      delivered.facts.some((fact) => fact.kind === "attestation"),
      false,
    );
    assert.equal(JSON.stringify(second.facts[0]?.data).includes("second"), false);
  } finally {
    if (prior === undefined) delete process.env[environmentName];
    else process.env[environmentName] = prior;
  }
});

test("audit showDiff belongs to this attempt and dirty failure is blocked evidence", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), contract.id);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");

  const blocked = await contract.audit();
  assert.deepEqual(blocked.facts, []);
  assert.equal(blocked.value.candidate.kind, "blocked");
  if (blocked.value.candidate.kind !== "blocked") return;
  assert.equal(blocked.value.candidate.refusal.kind, "dirty-workspace");
  assert.equal(blocked.value.verification.kind, "not-run");
  assert.equal(blocked.value.target.kind, "not-observed");
  assert.equal((await contract.state()).attestations.length, 0);

  const hidden = await contract.audit({ includeDirty: true });
  assert.equal(hidden.value.candidate.kind, "ready");
  if (hidden.value.candidate.kind !== "ready") return;
  assert.equal("diff" in hidden.value.candidate, false);
  assert.equal("paths" in hidden.value.candidate.scope, false);

  const shown = await contract.audit({ includeDirty: true, showDiff: true });
  assert.equal(shown.value.candidate.kind, "ready");
  if (shown.value.candidate.kind !== "ready") return;
  assert.equal(typeof shown.value.candidate.diff, "string");
  assert.match(shown.value.candidate.diff ?? "", /candidate/);
  assert.ok(shown.value.candidate.scope.paths !== undefined);
});

test("ready targeted audit reports checkout collisions without placing", async () => {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "shared.txt"), "base\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "base"]);
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document("exit 0"),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["verified"],
  });
  const state = await bound.keiyaku.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  const collision = "literal[1].tmp";
  writeFileSync(join(repository.path, ".gitignore"), "literal*.tmp\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore literal candidate"]);
  writeFileSync(join(repository.path, collision), "local\n");
  writeFileSync(join(worktree, collision), "candidate\n");
  repository.run(["-C", worktree, "add", collision]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "literal candidate"]);
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const indexBefore = repository.run(["diff", "--cached", "--binary"]);
  const worktreeBefore = repository.run(["status", "--porcelain=v1", "--untracked-files=all"]);

  const audited = await bound.keiyaku.audit();
  assert.equal(audited.value.candidate.kind, "ready");
  assert.equal(audited.value.target.kind, "refused");
  if (audited.value.target.kind !== "refused") return;
  assert.equal(audited.value.target.refusal.kind, "checkout-not-followable");
  if (audited.value.target.refusal.kind !== "checkout-not-followable") return;
  assert.equal(audited.value.target.refusal.reason, "untracked");
  assert.deepEqual(audited.value.target.refusal.paths, [collision]);
  assert.equal(
    audited.facts.some((fact) => fact.kind === "claimed" || fact.kind === "deliver"),
    false,
  );
  assert.equal((await bound.keiyaku.state()).delivery, null);
  assert.equal((await bound.keiyaku.state()).terminal, null);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), target);
  assert.equal(repository.run(["diff", "--cached", "--binary"]), indexBefore);
  assert.equal(repository.run(["status", "--porcelain=v1", "--untracked-files=all"]), worktreeBefore);
});

test("later target checkout mutation is reobserved at placement", async () => {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "shared.txt"), "base\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "base"]);
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document("exit 0"),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["verified"],
  });
  const state = await bound.keiyaku.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "disjoint candidate"]);

  const audited = await bound.keiyaku.audit();
  assert.equal(audited.value.candidate.kind, "ready");
  assert.equal(audited.value.target.kind, "placeable");
  assert.equal((await bound.keiyaku.state()).delivery, null);

  writeFileSync(join(repository.path, "candidate.txt"), "local\n");
  const delivered = await bound.keiyaku.deliver();
  assert.equal(audited.value.candidate.kind, "ready");
  if (audited.value.candidate.kind !== "ready") return;
  assert.deepEqual(delivered.value.integration, audited.value.candidate.identity.integration);
  assert.equal(delivered.value.verificationReuse?.verdict, "satisfied");
  assert.equal(delivered.value.placement?.refusal?.kind, "checkout-not-followable");
  if (delivered.value.placement?.refusal?.kind !== "checkout-not-followable") return;
  assert.equal(delivered.value.placement.refusal.reason, "untracked");
  assert.deepEqual(delivered.value.placement.refusal.paths, ["candidate.txt"]);
  assert.equal((await bound.keiyaku.state()).terminal, null);
  assert.equal(existsSync(join(repository.path, "candidate.txt")), true);
  assert.equal(readFileSync(join(repository.path, "candidate.txt"), "utf8"), "local\n");
});

test("operational target observation failure is target.failed", async () => {
  const repository = repositoryWithMain();
  const git = await cachedRepositoryAt(repository.path);
  const predecessor = repository.run(["rev-parse", "HEAD"]).trim();
  const answer = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
      '  printf "forced worktree list failure\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) =>
      adjudicateAuditTarget(
        { ...git, gitPath },
        {
          contractId: "kei/target-observation",
          coordinates: { workspace: "worktree", target: "refs/heads/main" },
          predecessor,
          candidate: predecessor,
        },
      ),
  );
  assert.equal(answer.kind, "failed");
  if (answer.kind !== "failed") return;
  assert.match(answer.diagnostic, /forced worktree list failure/);
});

test("moved target wins over placeability", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(
      [
        'NEW=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p refs/heads/main -m move-target)',
        'git update-ref refs/heads/main "$NEW"',
        "exit 0",
      ].join("\n"),
    ),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["verified"],
  });
  commitCandidate(repository);

  const audited = await bound.keiyaku.audit();
  assert.equal(audited.value.candidate.kind, "ready");
  if (audited.value.candidate.kind !== "ready") return;
  assert.equal(audited.value.verification.kind, "satisfied");
  const expected = audited.value.candidate.identity.integration.predecessor;
  const observed = repository.run(["rev-parse", "refs/heads/main"]).trim();
  assert.notEqual(observed, expected);
  assert.deepEqual(audited.value.target, {
    kind: "moved",
    ref: "refs/heads/main",
    expected,
    observed,
  });
});

test("stopped Verification forces target not-observed", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document("kill -TERM $$"),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["verified"],
  });
  commitCandidate(repository);

  const audited = await bound.keiyaku.audit();
  assert.equal(audited.value.candidate.kind, "ready");
  assert.equal(audited.value.verification.kind, "stopped");
  if (audited.value.verification.kind !== "stopped") return;
  assert.equal(audited.value.verification.stop.failure, "unknown-exit");
  assert.equal(audited.value.target.kind, "not-observed");
});

test("completeMutation preserves accepted cleanup and leak", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);
  const cleanupFailure = [
    'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
    "  printf 'forced verification cleanup failure\\n' >&2",
    "  exit 17",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const audited = await withGitShim(cleanupFailure, {}, async (gitPath) =>
    (
      await Keiyaku.of({
        repo: await Repo.at({ path: repository.path, gitPath }),
        id: contract.id,
      })
    ).audit(),
  );
  assert.equal(audited.value.candidate.kind, "ready");
  assert.match(audited.leak?.diagnostic ?? "", /forced verification cleanup failure/);
  assert.equal("leak" in audited.value, false);
  assert.equal("cleanup" in audited.value, false);
  repository.run(["worktree", "remove", "--force", audited.leak!.path]);
});

test("public audit exposes admitted verified attestations through facts", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 1");
  commitCandidate(repository);

  await contract.deliver();
  const audited = await contract.audit();
  assert.deepEqual(
    audited.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(audited.value.verification.kind, "unsatisfied");
  if (audited.value.verification.kind !== "unsatisfied") return;
  assert.equal(audited.value.verification.passed, 0);
  assert.equal(audited.value.verification.total, 1);
});

test("audit keeps its leading observation when the delivery candidate is unavailable", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document("exit 0"),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  commitCandidate(repository);
  await bound.keiyaku.deliver();

  const audited = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "add" ] && [ "$3" = "--detach" ]; then',
      '  case "$4" in',
      '    */keiyaku-v4-verify-*) printf "forced candidate materialization failure\\n" >&2; exit 1 ;;',
      "  esac",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) =>
      (
        await Keiyaku.of({
          repo: await Repo.at({ path: repository.path, gitPath }),
          id: bound.keiyaku.id,
        })
      ).audit(),
  );
  assert.deepEqual(audited.facts, []);
  assert.equal(audited.value.candidate.kind, "ready");
  assert.equal(audited.value.verification.kind, "stopped");
  if (audited.value.verification.kind !== "stopped") return;
  assert.equal(audited.value.verification.stop.failure, "candidate-unavailable");
  const stop = audited.value.verification.stop;
  assert.ok("diagnostic" in stop);
  if (!("diagnostic" in stop)) return;
  assert.match(stop.diagnostic, /worktree add --detach .*forced candidate materialization failure/);
  assert.equal(audited.value.target.kind, "not-observed");
});

test("public audit refuses a terminal contract before reading its released workspace", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);

  await contract.deliver();
  await assert.rejects(() => contract.audit(), refused({ kind: "terminal", contractId: (await contract.state()).id }));
});

test("audit blocks an active unappointed workspace without inventing a path", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  const state = await bound.keiyaku.state();
  await releaseManagedWorktrees(await cachedRepositoryAt(repository.path), [state.id]);

  const audited = await bound.keiyaku.audit();
  assert.deepEqual(audited.value.candidate, {
    kind: "blocked",
    refusal: { kind: "worktree-missing", contractId: state.id },
  });
  assert.equal("workspace" in audited.value.candidate, false);
  assert.deepEqual(audited.value.verification, { kind: "not-run" });
  assert.deepEqual(audited.value.target, { kind: "not-observed" });
});

test("public audit rejects a missing contract with a typed refusal", async () => {
  const repository = repositoryWithMain();
  const contract = Keiyaku.of({ repo: await cachedRepoAt(repository.path), id: "kei/missing" as ContractId });

  await assert.rejects(
    contract.audit(),
    refused({ kind: "contract-missing", contractId: "kei/missing" as ContractId }),
  );
});
