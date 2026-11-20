import assert from "node:assert/strict";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
import type { ContractId } from "../src/core/facts/types.js";
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

test("empty amendments admit no fact; only explicit empties clear prerequisites and gates", async () => {
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

  accepted(await bound.kei.amend({ edits: "## Replace: Objective\n\nA sharpened objective.\n" }));
  const documented = await stateOf(repository, bound.contractId);
  assert.deepEqual(documented.terms.after, [prerequisite.contractId]);
  assert.deepEqual(documented.terms.gates, ["reviewed"]);

  accepted(await bound.kei.amend({ after: [], gates: [] }));
  const cleared = await stateOf(repository, bound.contractId);
  assert.deepEqual(cleared.terms.after, []);
  assert.deepEqual(cleared.terms.gates, []);
});

