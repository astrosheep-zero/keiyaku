import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, Repo, type ContractId } from "../src/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { deliveryWorktreePath } from "../src/git/workspace.js";
import { withGitShim } from "./support/git.js";
import { bind, commitCandidate, document, refused, repositoryWithMain } from "./support/library-verbs.js";

test("pre-delivery audit preview matches a later unchanged deliver", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);

  const audited = await contract.audit();
  assert.equal(audited.value.preview?.kind, "ready");
  if (audited.value.preview?.kind !== "ready") return;
  assert.deepEqual(audited.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(audited.facts.some((fact) => fact.kind === "deliver" || fact.kind === "claimed" || fact.kind === "bound"), false);
  assert.equal("target" in audited.value.preview, false);
  assert.equal((await contract.state()).delivery, null);
  assert.equal((await contract.state()).terminal, null);

  const delivered = await contract.deliver();
  assert.equal(delivered.value.tenderSnapshot, audited.value.preview.candidate.tenderSnapshot);
  assert.deepEqual(delivered.value.integration, audited.value.preview.candidate.integration);
  assert.equal(delivered.value.method, audited.value.preview.candidate.method);
  assert.deepEqual(delivered.value.policy, audited.value.preview.candidate.policy);
  assert.equal(delivered.value.verificationReuse?.verdict, "satisfied");
  assert.equal(delivered.facts.some((fact) => fact.kind === "attestation"), false);
});

test("unchanged deliver reuses unsatisfied pre-delivery audit Verification", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 1");
  commitCandidate(repository);

  const audited = await contract.audit();
  assert.equal(audited.value.preview?.kind, "ready");
  if (audited.value.preview?.kind !== "ready") return;
  assert.deepEqual(audited.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(audited.facts[0]?.data.verdict, "unsatisfied");
  const reused = audited.facts[0];
  if (reused === undefined) return;

  const delivered = await contract.deliver();
  assert.deepEqual(delivered.value.integration, audited.value.preview.candidate.integration);
  assert.equal(delivered.value.verificationReuse?.verdict, "unsatisfied");
  assert.equal(delivered.value.verificationReuse?.entry, reused.entry);
  assert.equal(delivered.facts.some((fact) => fact.kind === "attestation"), false);
  assert.deepEqual(delivered.value.placement, {
    refusal: { kind: "gates-unsatisfied", contractId: (await contract.state()).id },
  });
  const observed = await Keiyaku.observe({ repo: await Repo.at({ path: repository.path }), id: (await contract.state()).id });
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") return;
  assert.equal(observed.row.gates.satisfied, false);
  const current = observed.row.gates.reports[0]?.current;
  assert.equal(current?.kind, "attested");
  if (current?.kind !== "attested") return;
  assert.equal(new Date(current.at).toISOString(), current.at);
  assert.deepEqual(observed.row.gates.reports, [
    { gate: "verified", current: { kind: "attested", verdict: "unsatisfied", summary: "[1 bash exit 1]", at: current.at } },
  ]);
});

test("audit showDiff belongs to this attempt and dirty failure is preview evidence", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");

  const blocked = await contract.audit();
  assert.deepEqual(blocked.facts, []);
  assert.equal(blocked.value.preview?.kind, "blocked");
  if (blocked.value.preview?.kind !== "blocked") return;
  assert.equal(blocked.value.preview.refusal.kind, "dirty-workspace");
  assert.equal(blocked.value.attempt, undefined);
  assert.equal((await contract.state()).attestations.length, 0);

  const hidden = await contract.audit({ includeDirty: true });
  assert.equal(hidden.value.preview?.kind, "ready");
  if (hidden.value.preview?.kind !== "ready") return;
  assert.equal("diff" in hidden.value.preview, false);

  const shown = await contract.audit({ includeDirty: true, showDiff: true });
  assert.equal(shown.value.preview?.kind, "ready");
  if (shown.value.preview?.kind !== "ready") return;
  assert.equal(typeof shown.value.preview.diff, "string");
  assert.match(shown.value.preview.diff ?? "", /candidate/);
});

test("ready targeted audit previews checkout collisions without placing", async () => {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "shared.txt"), "base\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "base"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document("exit 0"),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["verified"],
  });
  const state = await bound.keiyaku.state();
  const worktree = deliveryWorktreePath(await repositoryAt(repository.path), state.id);
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
  assert.equal(audited.value.preview?.kind, "ready");
  if (audited.value.preview?.kind !== "ready") return;
  assert.equal(audited.value.preview.target?.kind, "refused");
  if (audited.value.preview.target?.kind !== "refused") return;
  assert.equal(audited.value.preview.target.refusal.kind, "checkout-not-followable");
  if (audited.value.preview.target.refusal.kind !== "checkout-not-followable") return;
  assert.equal(audited.value.preview.target.refusal.reason, "untracked");
  assert.deepEqual(audited.value.preview.target.refusal.paths, [collision]);
  assert.equal(audited.facts.some((fact) => fact.kind === "claimed" || fact.kind === "deliver"), false);
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
    repo: await Repo.at({ path: repository.path }),
    markdown: document("exit 0"),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["verified"],
  });
  const state = await bound.keiyaku.state();
  const worktree = deliveryWorktreePath(await repositoryAt(repository.path), state.id);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "disjoint candidate"]);

  const audited = await bound.keiyaku.audit();
  assert.equal(audited.value.preview?.kind, "ready");
  if (audited.value.preview?.kind !== "ready") return;
  assert.equal(audited.value.preview.target?.kind, "ready");
  assert.equal((await bound.keiyaku.state()).delivery, null);

  writeFileSync(join(repository.path, "candidate.txt"), "local\n");
  const delivered = await bound.keiyaku.deliver();
  assert.deepEqual(delivered.value.integration, audited.value.preview.candidate.integration);
  assert.equal(delivered.value.verificationReuse?.verdict, "satisfied");
  assert.equal(delivered.value.placement?.refusal?.kind, "checkout-not-followable");
  if (delivered.value.placement?.refusal?.kind !== "checkout-not-followable") return;
  assert.equal(delivered.value.placement.refusal.reason, "untracked");
  assert.deepEqual(delivered.value.placement.refusal.paths, ["candidate.txt"]);
  assert.equal((await bound.keiyaku.state()).terminal, null);
  assert.equal(existsSync(join(repository.path, "candidate.txt")), true);
  assert.equal(readFileSync(join(repository.path, "candidate.txt"), "utf8"), "local\n");
});

test("operational target observation failure is preview.target.failed", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document("exit 0"),
    workspace: "here",
    target: "refs/heads/main",
    gates: ["verified"],
  });
  commitCandidate(repository);

  const audited = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
      '  printf "forced worktree list failure\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    () => bound.keiyaku.audit(),
  );
  assert.equal(audited.value.preview?.kind, "ready");
  if (audited.value.preview?.kind !== "ready") return;
  assert.equal(audited.value.preview.target?.kind, "failed");
  if (audited.value.preview.target?.kind !== "failed") return;
  assert.match(audited.value.preview.target.diagnostic, /forced worktree list failure/);
  assert.equal((await bound.keiyaku.state()).delivery, null);
});

test("public audit exposes admitted verified attestations through facts", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 1");
  commitCandidate(repository);

  const delivered = await contract.deliver();
  const audited = await contract.audit();
  assert.deepEqual(audited.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(audited.value.reworks, 1);
  assert.equal(audited.value.reviews, 0);
  assert.equal(audited.value.timeline.at(-1)?.kind, "attestation");
  assert.deepEqual(audited.value.timeline.at(-1)?.attestation, {
    gate: "verified",
    verdict: "unsatisfied",
    summary: "[1 bash exit 1]",
  });
  assert.equal(audited.value.attempt, undefined);
});

test("audit keeps its leading observation when the delivery candidate is unavailable", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }),
    markdown: document("exit 0"),
    workspace: "here",
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
    () => bound.keiyaku.audit(),
  );
  assert.deepEqual(audited.facts, []);
  assert.equal(audited.value.attempt?.failure, "candidate-unavailable");
  const attempt = audited.value.attempt;
  assert.ok(attempt && "diagnostic" in attempt);
  if (attempt === undefined || !("diagnostic" in attempt)) throw new Error("candidate materialization failure is missing its diagnostic");
  assert.match(attempt.diagnostic, /worktree add --detach .*forced candidate materialization failure/);
  assert.equal(audited.value.timeline.some((entry) => entry.kind === "deliver"), true);
});

test("public read-only audit returns empty facts without a second outcome kind", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);

  const delivered = await contract.deliver();
  const audited = await contract.audit();
  assert.deepEqual(audited.facts, []);
  assert.deepEqual(audited.value.attempt, {
    refusal: { kind: "terminal", contractId: (await contract.state()).id },
  });
});

test("public audit rejects a missing contract with a typed refusal", async () => {
  const repository = repositoryWithMain();
  const contract = Keiyaku.of({ repo: await Repo.at({ path: repository.path }), id: "kei/missing" as ContractId });

  await assert.rejects(
    contract.audit(),
    refused({ kind: "contract-missing", contractId: "kei/missing" as ContractId }),
  );
});
