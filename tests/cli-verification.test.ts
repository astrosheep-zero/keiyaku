import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { BindOutcome, DeliverOutcome, VerifyOutcome } from "../src/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { appointedWorktreePath, makeGitRepository, observeContract } from "./support/git.js";
import { cliJson } from "./support/cli-fixtures.js";
import { accepted } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";

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
