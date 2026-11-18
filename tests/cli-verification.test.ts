import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  Kanshi,
  Keis,
  Keiyaku,
  Repo,
  World,
  type BindOutcome,
  type ContractCatalogue,
  type ContractKanshiDetail,
  type DeliveryPreviewOutcome,
  type DeliverOutcome,
  type KanshiReport,
  type VerifyOutcome,
} from "../src/index.js";
import { renderAccepted } from "../src/cli/render/contract.js";
import { renderDeliveryPreview } from "../src/cli/render/delivery-preview.js";
import { repositoryAt } from "../src/git/repository.js";
import { appointedWorktreePath, makeGitRepository, observeContract } from "./support/git.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { accepted } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { temporaryDirectory } from "./support/process.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";

function markdown(scripts: readonly string[]): string {
  return contractMarkdown("CLI verification", {
    Context: "A CLI result exposes independent verification owner facts.",
    Objective: "Execute explicit checks and retain each requirement's evidence.",
    Design: "Invoke the public Contract operation once.",
    Region: "src/**",
    Criteria: "### Check\nThe verification runs only when requested.",
    Verification: scripts.map((script) => `~~~bash timeout=5m\n${script}\n~~~`).join("\n\n"),
  });
}

async function bindCandidate(scripts: readonly string[], gates: readonly string[] = ["verified"]) {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  mkdirSync(resolve(raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(
    resolve(raw.path, ".keiyaku", "settings.json"),
    JSON.stringify({ gates: { default: { kind: "bundle", gates } } }),
  );
  const bound = await cliJson<BindOutcome>(["-C", raw.path, "bind", "--target", "refs/heads/main", "-"], {
    environment: {},
    readStdin: async () => markdown(scripts),
  });
  const id = accepted(bound.value).contractId;
  const repository = await repositoryAt(raw.path);
  const worktree = await appointedWorktreePath(repository, id);
  writeFileSync(resolve(worktree, "candidate.txt"), "candidate\n");
  raw.run(["-C", worktree, "add", "candidate.txt"]);
  raw.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  return { raw, id, worktree, repository };
}

test("contextual verify accumulates selected checks and completes an already delivered candidate", async () => {
  const { raw, id, worktree, repository } = await bindCandidate(["printf 'first-live-output\\n'", "true"]);
  const delivered = accepted(
    (await cliJson<DeliverOutcome>(["-C", raw.path, "deliver", id], { environment: {} })).value,
  );
  assert.equal(delivered.placement?.kind, "gates-unsatisfied");
  assert.equal((await observeContract(repository, id)).state?.terminal, null);
  const first = await cliJson<VerifyOutcome>(["-C", worktree, "verify", "--index", "1"], { environment: {} });
  const value = accepted(first.value);
  assert.equal(first.stderr, "", "JSON emits no text activity");
  assert.equal(value.checks.length, 1);
  assert.equal(value.checks[0]?.index, 1);
  assert.equal(value.snapshot, delivered.integration);
  assert.equal(value.placement?.kind, "gates-unsatisfied");
  if (value.placement?.kind !== "gates-unsatisfied") assert.fail("missing unmet requirement");
  assert.deepEqual(
    value.placement.unmet.map((item) => item.state),
    ["missing"],
  );
  const text = renderAccepted("verify", value, { columns: 400, color: false });
  assert.match(text, /✓ check 1\s+satisfied · recorded/u);
  assert.match(text, /awaiting verification/u);
  const status = await runCli(["-C", raw.path, "status", id], { environment: {} });
  assert.match(status.stdout, /verification 1 · current · satisfied/u);
  assert.match(status.stdout, /verification 2 · missing/u);
  const history = await runCli(["-C", raw.path, "history", id], { environment: {} });
  assert.ok(history.stdout.includes(value.checks[0]!.requirement));
  const second = accepted(
    (await cliJson<VerifyOutcome>(["-C", worktree, "verify", "--index", "2"], { environment: {} })).value,
  );
  assert.equal(second.snapshot, value.snapshot);
  assert.equal(second.placement?.kind, "placed");
  if (second.placement?.kind !== "placed") assert.fail("candidate did not land");
  assert.equal(second.placement.integration, delivered.integration);
  assert.equal((await observeContract(repository, id)).state?.terminal?.kind, "claimed");
  assert.equal(existsSync(worktree), false);
});

test("pre-delivery verify always executes and distinguishes admission reuse from execution", async (t) => {
  const external = temporaryDirectory(t, "cli-verify-rerun-");
  const runs = resolve(external, "runs");
  const { raw, id, repository } = await bindCandidate([`echo run >> '${runs}'`]);
  const verify = async () =>
    accepted((await cliJson<VerifyOutcome>(["-C", raw.path, "verify", id], { environment: {} })).value);
  const first = await verify();
  assert.equal(first.checks[0]?.kind, "terminal");
  assert.equal(first.placement?.kind, "delivery-missing");
  assert.equal((await observeContract(repository, id)).state?.delivery, null);
  const second = await verify();
  assert.equal(readFileSync(runs, "utf8"), "run\nrun\n");
  const check = second.checks[0]!;
  assert.equal(check.kind, "terminal");
  if (check.kind !== "terminal") assert.fail("verification did not finish");
  assert.equal(check.admission, "reused");
  assert.match(
    renderAccepted("verify", second, { columns: 400, color: false }),
    /✓ check 1\s+satisfied · reused/u,
  );
  const delivered = accepted(
    (await cliJson<DeliverOutcome>(["-C", raw.path, "deliver", id], { environment: {} })).value,
  );
  assert.equal(delivered.placement?.kind, "placed");
  assert.equal(delivered.integration, first.snapshot);
  assert.equal(readFileSync(runs, "utf8"), "run\nrun\n", "delivery consumes standing evidence");
});

test("pre-delivery reads separate recorded verdicts from pending applicability and known mismatches", async (t) => {
  const runs = resolve(temporaryDirectory(t, "cli-pending-applicability-"), "runs");
  const { raw, id, repository } = await bindCandidate(
    [`echo green >> '${runs}'`, `echo red >> '${runs}'; exit 1`],
    ["reviewed", "verified"],
  );
  raw.run(["branch", "other", "main"]);
  const args = ["-C", raw.path];
  const env = { environment: {} };
  const repo = await Repo.at({ path: raw.path });
  const keis = Keis.of(repo);
  const contract = keis.kei({ id });
  const verify = () => contract.verify().then(accepted);
  const review = () => contract.review({ verdict: "satisfied", summary: "Candidate reviewed" }).then(accepted);
  const status = async () => (await cliJson<ContractKanshiDetail>([...args, "status", id], env)).value;
  const evidence = (detail: Pick<ContractKanshiDetail, "gates">, gate: string) =>
    detail.gates?.find((report) => report.gate === gate)?.requirements.map(({ current }) => current);

  const verified = await verify();
  await review();
  const before = await observeContract(repository, id);
  const first = await status();
  assertWireRoundTrip(Keiyaku.verbs.status.normal, first);
  assert.equal(first.delivery, undefined);
  const pending = (priorVerdict: "satisfied" | "unsatisfied") => ({ kind: "applicability-pending", priorVerdict });
  const reviewPending = [pending("satisfied")];
  const checksPending = [pending("satisfied"), pending("unsatisfied")];
  assert.deepEqual(evidence(first, "reviewed"), reviewPending);
  assert.deepEqual(evidence(first, "verified"), checksPending);
  const native = await keis.observe({ id });
  const selected = await Kanshi.of({ repo, world: await World.at(raw.path) }).contract(id);
  assert.equal(native.kind, "present");
  assert.equal(selected.kind, "contract");
  assert.deepEqual([first.gates, selected.gates], [native.row.gates, native.row.gates]);
  const exactText = (await runCli([...args, "status", id], env)).stdout;
  assert.match(exactText, /verification 2 · recorded unsatisfied · applicability pending/u);

  const { value: catalogue } = await cliJson<ContractCatalogue>([...args, "ls", "kei/"], env);
  const { value: world } = await cliJson<KanshiReport>([...args, "kanshi"], env);
  assertWireRoundTrip(Keiyaku.verbs.ls.normal, catalogue);
  assert.equal(world.contracts.kind, "present");
  const row = catalogue.rows?.find((row) => row.id === id);
  assert.deepEqual(row?.gates, ["reviewed", "verified"].map((name) => ({ name, verdict: "applicability-pending" })));
  assert.deepEqual(world.contracts.rows?.find((row) => row.id === id)?.gates, row?.gates);
  assert.match((await runCli([...args, "ls", "kei/"], env)).stdout, /verification applicability pending/u);

  const preview = await contract.previewDelivery();
  assert.equal(preview.kind, "ready");
  assert.deepEqual(preview.unmetGates?.map(({ requirement, state }) => [requirement, state]), [
    [verified.checks[1]!.requirement, "unsatisfied"],
  ]);
  assert.equal(before.state?.delivery, null);
  assert.deepEqual(await observeContract(repository, id), before);
  assert.equal(readFileSync(runs, "utf8"), "green\nred\n");

  accepted(await contract.amend({ target: "other" }));
  const retargeted = await status();
  assert.deepEqual(evidence(retargeted, "verified"), [
    { kind: "stale", priorVerdict: "satisfied" },
    { kind: "stale", priorVerdict: "unsatisfied" },
  ]);
  assert.deepEqual(evidence(retargeted, "reviewed"), reviewPending);
  await verify();
  accepted(await contract.amend({ edits: "## Replace: Objective\n\nSame candidate, revised author intent.\n" }));
  const amended = await status();
  assert.deepEqual(evidence(amended, "reviewed"), [{ kind: "stale", priorVerdict: "satisfied" }]);
  assert.deepEqual(evidence(amended, "verified"), checksPending);

  await review();
  const delivery = accepted(await contract.deliver());
  assert.equal(delivery.placement?.kind, "gates-unsatisfied");
  assert.deepEqual(delivery.placement.unmet, preview.unmetGates);
  assert.equal(readFileSync(runs, "utf8"), "green\nred\ngreen\nred\n");
});

test("full verify exposes mixed verdicts, independent scratches, and requirement-scoped retention", async () => {
  const { raw, id } = await bindCandidate(["echo owned > own-file; exit 1", "test ! -f own-file"]);
  const result = accepted((await cliJson<VerifyOutcome>(["-C", raw.path, "verify", id], { environment: {} })).value);
  assert.deepEqual(
    result.checks.map((check) => (check.kind === "terminal" ? check.verdict : check.kind)),
    ["unsatisfied", "satisfied"],
  );
  const failed = result.checks[0]!;
  assert.ok(failed.retainedPath);
  assert.equal(readFileSync(resolve(failed.retainedPath, "own-file"), "utf8"), "owned\n");
  const text = renderAccepted("verify", result, { columns: 400, color: false });
  assert.match(text, /× check 1\s+unsatisfied · recorded/u);
  assert.match(text, /✓ check 2\s+satisfied · recorded/u);
  assert.equal(text.split("\n").filter((line) => line.trimStart().startsWith("snapshot ")).length, 1);
  const wire = JSON.parse(JSON.stringify(result));
  assert.deepEqual(wire.checks.map((check: { requirement: string }) => check.requirement), result.checks.map((check) => check.requirement));
  assert.equal(wire.snapshot, result.snapshot);
  assert.ok(text.includes(failed.retainedPath));
  accepted(
    await Keis.of(await Repo.at({ path: raw.path }))
      .kei({ id })
      .abandon(),
  );
  assert.equal(existsSync(failed.retainedPath), false);
});

test("verify refuses out-of-range checks before execution or admission", async (t) => {
  const external = temporaryDirectory(t, "cli-verify-refusal-");
  const marker = resolve(external, "ran");
  const { raw, id, repository } = await bindCandidate([`touch '${marker}'`]);
  const before = await observeContract(repository, id);
  const result = await cliJson<VerifyOutcome>(["-C", raw.path, "verify", id, "--index", "2"], { environment: {} });
  assert.equal(result.exit, 1);
  assert.equal(result.value.kind, "refused");
  if (result.value.kind !== "refused") assert.fail("invalid index was accepted");
  assert.deepEqual(result.value.reason, {
    kind: "verification-index-out-of-range",
    total: 1,
  });
  const text = await runCli(["-C", raw.path, "verify", id, "--index", "2"], { environment: {} });
  assert.match(text.stdout, /reason\s+Verification declaration index is out of range/u);
  assert.match(text.stdout, /declarations\s+1/u);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(await observeContract(repository, id), before);
});

test("review-only verify executes selected and full checks without recording testimony", async (t) => {
  const external = temporaryDirectory(t, "cli-verify-ungated-");
  const runs = resolve(external, "runs");
  const { raw, id, repository } = await bindCandidate([
    `echo first >> '${runs}'; touch scratch-only; exit 3`,
    `test ! -f scratch-only && echo second >> '${runs}'`,
  ], ["reviewed"]);
  const before = await observeContract(repository, id);
  const selected = accepted((await cliJson<VerifyOutcome>(
    ["-C", raw.path, "verify", id, "--index", "2"], { environment: {} },
  )).value);
  assert.equal(readFileSync(runs, "utf8"), "second\n");
  assert.deepEqual(selected.checks.map(({ index, kind }) => [index, kind]), [[2, "terminal"]]);
  const full = accepted((await cliJson<VerifyOutcome>(
    ["-C", raw.path, "verify", id], { environment: {} },
  )).value);
  assert.deepEqual(full.checks.map((check) => check.kind === "terminal" ? check.verdict : check.kind),
    ["unsatisfied", "satisfied"]);
  assert.ok([...selected.checks, ...full.checks].every((check) =>
    check.kind === "terminal" && check.admission === "unrecorded"));
  assert.equal(readFileSync(runs, "utf8"), "second\nfirst\nsecond\n");
  assert.deepEqual(await observeContract(repository, id), before);
  assert.equal(full.placement, undefined);
  const unrecorded = renderAccepted("verify", full, { columns: 400, color: false });
  assert.match(unrecorded, /× check 1\s+unsatisfied · not recorded/u);
  assert.match(unrecorded, /✓ check 2\s+satisfied · not recorded/u);
  const delivered = accepted((await cliJson<DeliverOutcome>(
    ["-C", raw.path, "deliver", id], { environment: {} },
  )).value);
  assert.ok(delivered.placement?.kind === "gates-unsatisfied");
  assert.deepEqual(delivered.placement.unmet.map(({ gate }) => gate), ["reviewed"]);
  writeFileSync(resolve(raw.path, "target.txt"), "target moved\n");
  raw.run(["add", "target.txt"]);
  raw.run(["commit", "--quiet", "-m", "advance target"]);
  const deliveredState = await observeContract(repository, id);
  const refreshed = accepted((await cliJson<VerifyOutcome>(
    ["-C", raw.path, "verify", id, "--index", "2"], { environment: {} },
  )).value);
  assert.notEqual(refreshed.snapshot, full.snapshot);
  assert.equal(refreshed.placement, undefined);
  assert.deepEqual(await observeContract(repository, id), deliveredState);
  await cliJson(["-C", raw.path, "review", id, "--satisfied", "--summary", "reviewed"], { environment: {} });
  assert.equal((await observeContract(repository, id)).state?.terminal?.kind, "claimed");
  assert.equal(readFileSync(runs, "utf8"), "second\nfirst\nsecond\nsecond\n");
});

test("verify captures dirty bytes only with explicit authorization and streams per-check progress", async () => {
  const { raw, id, worktree, repository } = await bindCandidate(["cat candidate.txt; grep -q dirty candidate.txt"]);
  writeFileSync(resolve(worktree, "candidate.txt"), "dirty\n");
  const refused = await runCli(["-C", worktree, "verify"], { environment: {} });
  assert.equal(refused.exit, 1);
  assert.match(refused.stdout, /--include-dirty/u);
  const index = raw.run(["-C", worktree, "ls-files", "--stage"]);
  const result = await runCli(["-C", worktree, "verify", "--include-dirty"], { environment: {} });
  assert.equal(result.exit, 0, result.stderr);
  assert.match(result.stdout, /✓ check 1\s+satisfied · recorded/u);
  assert.match(result.stderr, /dirty/u);
  assert.match(result.stderr, /✓ declaration 1\/1 · \d+s/u);
  assert.equal(raw.run(["-C", worktree, "ls-files", "--stage"]), index);
  assert.equal((await observeContract(repository, id)).state?.delivery, null);
});

test("delivery, review and preview consume standing requirement evidence without executing checks", async (t) => {
  const external = temporaryDirectory(t, "cli-verify-standing-");
  const runs = resolve(external, "runs");
  const { raw, id, repository } = await bindCandidate(
    [`echo run >> '${runs}'; exit 1`, "true"],
    ["reviewed", "verified"],
  );
  const verified = accepted((await cliJson<VerifyOutcome>(["-C", raw.path, "verify", id], { environment: {} })).value);
  const beforeRuns = readFileSync(runs, "utf8");
  const delivered = accepted(
    (await cliJson<DeliverOutcome>(["-C", raw.path, "deliver", id], { environment: {} })).value,
  );
  assert.equal(delivered.placement?.kind, "gates-unsatisfied");
  const preview = (
    await cliJson<DeliveryPreviewOutcome>(["-C", raw.path, "deliver", id, "--dry-run"], { environment: {} })
  ).value;
  assert.equal(preview.kind, "ready");
  if (preview.kind !== "ready") assert.fail("preview not ready");
  const verification = preview.unmetGates?.filter((problem) => problem.gate === "verified");
  assert.deepEqual(
    verification?.map((problem) => problem.state),
    ["unsatisfied"],
  );
  const text = renderDeliveryPreview(preview, { columns: 400, color: false });
  assert.match(text, /verification[\s\S]*unsatisfied/u);
  await cliJson(["-C", raw.path, "review", id, "--satisfied", "--summary", "reviewed"], { environment: {} });
  assert.equal(readFileSync(runs, "utf8"), beforeRuns);
  const after = (await observeContract(repository, id)).state!;
  assert.equal(after.terminal, null);
  assert.equal(after.attestations.filter((entry) => entry.data.gate === "verified").length, verified.checks.length);
});
