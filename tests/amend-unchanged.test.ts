import assert from "node:assert/strict";
import test from "node:test";
import { Keis, Keiyaku, Repo } from "../src/index.js";
import type { ContractId } from "../src/core/facts/types.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import type { TestGitRepository } from "./support/git.js";

async function bind(
  repository: TestGitRepository,
  terms: Readonly<{ gates?: readonly string[]; after?: readonly ContractId[] }> = {},
) {
  const repo = await Repo.at({ path: repository.path });
  return accepted(await Keis.of(repo).bind({ terms: document(), target: null, ...terms }));
}

async function stateOf(repository: TestGitRepository, id: ContractId) {
  const repo = await Repo.at({ path: repository.path });
  return present(await Keis.of(repo).kei({ id }).state());
}

test("an amendment that names no edit answers unchanged without admitting a fact", async () => {
  const repository = repositoryWithMain();
  const prerequisite = await bind(repository, { gates: [] });
  const bound = await bind(repository, { gates: ["reviewed"], after: [prerequisite.contractId] });
  const before = await stateOf(repository, bound.contractId);

  const outcome = await bound.kei.amend({});

  assert.deepEqual(outcome, { kind: "accepted", contractId: bound.contractId });
  const after = await stateOf(repository, bound.contractId);
  assert.equal(after.head, before.head, "an unchanged amendment admits no journal entry");
  assert.deepEqual(after.terms, before.terms);
  assert.deepEqual(after.terms.after, [prerequisite.contractId]);
  assert.deepEqual(after.terms.gates, ["reviewed"]);
});

test("omitted amendment fields retain prerequisites and gates, explicit empties clear them", async () => {
  const repository = repositoryWithMain();
  const prerequisite = await bind(repository, { gates: [] });
  const bound = await bind(repository, { gates: ["reviewed"], after: [prerequisite.contractId] });

  accepted(await bound.kei.amend({ edits: "## Replace: Objective\n\nA sharpened objective.\n" }));
  const documented = await stateOf(repository, bound.contractId);
  assert.deepEqual(documented.terms.after, [prerequisite.contractId]);
  assert.deepEqual(documented.terms.gates, ["reviewed"]);

  accepted(await bound.kei.amend({ after: [], gates: [] }));
  const cleared = await stateOf(repository, bound.contractId);
  assert.deepEqual(cleared.terms.after, []);
  assert.deepEqual(cleared.terms.gates, []);
});

test("an empty amendment keeps the owner's missing and terminal refusal", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const missing = Keis.of(repo).kei({ id: "kei/missing" as ContractId });
  assert.deepEqual(await missing.amend({}), {
    kind: "refused",
    contractId: "kei/missing",
    reason: { kind: "contract-missing" },
  });

  const bound = await bind(repository, { gates: [] });
  accepted(await bound.kei.abandon());
  assert.deepEqual(await bound.kei.amend({}), {
    kind: "refused",
    contractId: bound.contractId,
    reason: { kind: "terminal" },
  });
});

test("the invocation facet answers an empty amendment from the Contract selector alone", async () => {
  const repository = repositoryWithMain();
  const bound = await bind(repository, { gates: [] });
  const before = await stateOf(repository, bound.contractId);
  const facet = Keiyaku.for({ cwd: repository.path, environment: {} });
  const worktree = bound.worktreePath;
  assert.ok(worktree, "a targetless Contract reports its appointed worktree");

  for (const outcome of [
    await facet.run("amend", { contract: bound.contractId }),
    await facet.amend({ contract: bound.contractId }),
    await Keiyaku.for({ cwd: worktree, environment: {} }).amend(),
  ]) {
    assert.deepEqual(outcome, { kind: "accepted", contractId: bound.contractId });
  }
  assert.equal((await stateOf(repository, bound.contractId)).head, before.head);
});

test("CLI amendment without options reports the Contract unchanged and reads no stdin", async () => {
  const repository = repositoryWithMain();
  const prerequisite = await bind(repository, { gates: [] });
  const streamed = await cliJson<Readonly<{ kind: string; contractId?: string }>>(
    ["-C", repository.path, "bind", "--after", prerequisite.contractId, "--gates", "reviewed", "-"],
    { environment: {}, readStdin: async () => document() },
  );
  assert.equal(streamed.value.kind, "accepted");
  const id = streamed.value.contractId as ContractId;
  const before = await stateOf(repository, id);

  const text = await runCli(["-C", repository.path, "amend", id], {
    environment: {},
    readStdin: async () => {
      throw new Error("an option-free amendment reads no stdin");
    },
  });

  assert.equal(text.exit, 0);
  assert.match(text.stdout, /terms {2}unchanged/u);
  const after = await stateOf(repository, id);
  assert.equal(after.head, before.head);
  assert.deepEqual(after.terms, before.terms);
});
