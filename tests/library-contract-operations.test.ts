import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { deliveryWorktreePath } from "../src/git/workspace.js";
import { withGitShim } from "./support/git.js";
import { bind, commitCandidate, document, refused, repositoryWithMain } from "./support/library-verbs.js";

function appoint(repositoryPath: string, contract: string): string {
  const root = realpathSync(repositoryPath);
  const path = resolve(root, ".keiyaku", "KEIYAKU.md");
  mkdirSync(resolve(root, ".keiyaku"), { recursive: true });
  writeFileSync(path, `---\ncontract: ${contract}\n---\n`);
  return path;
}

test("here bind preserves and refuses an appointment whose journal is missing", async () => {
  const repository = repositoryWithMain();
  const contract = "kei/missing-appointment";
  const path = appoint(repository.path, contract);
  const before = readFileSync(path, "utf8");

  await assert.rejects(
    Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: document(), workspace: "here" }),
    refused({ kind: "here-worktree-appointed", path, contract }),
  );

  assert.equal(readFileSync(path, "utf8"), before);
});

test("here bind preserves and refuses a residual terminal appointment", async () => {
  const repository = repositoryWithMain();
  const terminal = await bind(repository);
  const contract = (await terminal.state()).id;
  await terminal.abandon();
  const path = appoint(repository.path, contract);
  const before = readFileSync(path, "utf8");

  await assert.rejects(
    Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: document(), workspace: "here" }),
    refused({ kind: "here-worktree-appointed", path, contract }),
  );

  assert.equal(readFileSync(path, "utf8"), before);
});

test("Delivery.diff freshly reads its pinned candidate diff", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  commitCandidate(repository);
  const delivered = await contract.deliver();

  const log = resolve(repository.path, "delivery-diff.log");
  writeFileSync(log, "");
  const shim = "if [ \"$1\" = \"diff\" ]; then printf 'diff\\n' >> \"$KEIYAKU_DELIVERY_DIFF_LOG\"; fi\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"";
  const variables = { KEIYAKU_DELIVERY_DIFF_LOG: log };
  const first = await withGitShim(shim, variables, () => delivered.value.diff());
  const second = await withGitShim(shim, variables, () => delivered.value.diff());

  assert.match(first, /diff --git a\/candidate\.txt b\/candidate\.txt/);
  assert.equal(second, first);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
});

test("one public handle reuses its resolved repository scope", async () => {
  const repository = repositoryWithMain();
  const initial = await bind(repository);
  const id = (await initial.state()).id;
  commitCandidate(repository);
  const log = resolve(repository.path, ".git", "scope-discovery.log");
  writeFileSync(log, "");

  const operations = withGitShim(
    [
      "if [ \"$1\" = \"worktree\" ] && [ \"$2\" = \"list\" ]; then",
      "  printf 'discovery\\n' >> \"$KEIYAKU_SCOPE_DISCOVERY_LOG\"",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_SCOPE_DISCOVERY_LOG: log },
    () => {
      const contract = Keiyaku.of({ repo: Repo.at({ path: repository.path }), id });
      return [contract.state(), contract.deliver(), contract.reconcile()] as const;
    },
  );
  const [state, delivered] = await Promise.all(operations);

  assert.equal(state.id, id);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["discovery"]);
});

test("public review, abandon, and Arc preserve their ruled testimony", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  assert.equal(await contract.delivery(), null);

  const arc = await contract.arc({ markdown: [
    "# Implementation",
    "",
    "## Objective",
    "Complete the public path.",
    "",
    "## Brief",
    "Keep the change bounded.",
    "",
  ].join("\n") });
  assert.equal((await contract.state()).currentArc?.data.seq, 1);

  commitCandidate(repository);
  const delivered = await contract.deliver();
  const recovered = await contract.delivery();
  assert.equal(recovered?.integration.snapshot, delivered.value.integration.snapshot);
  assert.equal(recovered?.integration.changeId, delivered.value.integration.changeId);

  const reviewed = await contract.review({ verdict: "unsatisfied",
    summary: "The candidate still needs one correction.",
  });
  assert.equal((await contract.state()).attestations.at(-1)?.data.summary, "The candidate still needs one correction.");

  await assert.rejects(
    // @ts-expect-error The deleted reason enum is not an abandon options object.
    () => contract.abandon("manual"),
    /abandon input must be an object/,
  );
  const abandoned = await contract.abandon({ note: "Return the task to planning." });
  assert.equal((await contract.state()).terminal?.kind, "abandoned");
  assert.deepEqual((await contract.state()).terminal?.data, { note: "Return the task to planning." });
  const terminalDelivery = await contract.delivery();
  assert.equal(terminalDelivery?.integration.snapshot, delivered.value.integration.snapshot);
  const contractId = (await contract.state()).id;
  await assert.rejects(
    () => contract.review({ verdict: "satisfied" }),
    refused({ kind: "terminal", contractId }),
  );

  await assert.rejects(
    () => contract.arc({ markdown: [
      "# Late",
      "",
      "## Objective",
      "Too late.",
      "",
      "## Brief",
      "Must refuse.",
      "",
    ].join("\n") }),
    refused({ kind: "terminal", contractId }),
  );
});

test("delivery terminal refusal outranks a missing managed worktree", async () => {
  const repository = repositoryWithMain();
  const prerequisite = await bind(repository);
  const prerequisiteId = (await prerequisite.state()).id;
  const dependent = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    gates: ["reviewed"],
    after: [prerequisiteId],
  });
  assert.equal((await dependent.keiyaku.state()).bound, null);
  const dependentId = (await dependent.keiyaku.state()).id;
  const path = deliveryWorktreePath(repositoryAt(repository.path), dependentId);
  await dependent.keiyaku.abandon();
  assert.equal(existsSync(path), false);

  const terminalContractId = (await dependent.keiyaku.state()).id;
  await assert.rejects(
    () => dependent.keiyaku.deliver(),
    refused({ kind: "terminal", contractId: terminalContractId }),
  );
});

test("review records before delivery and the same patch can be placed", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: ["reviewed"] });
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");

  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  assert.deepEqual(reviewed.value.workspace, {
    staged: [],
    unstaged: [],
    untracked: ["candidate.txt"],
    shortStat: { filesChanged: 1, insertions: 1, deletions: 0 },
  });
  assert.equal(reviewed.value.placement?.refusal.kind, "delivery-missing");
  const subject = (await result.keiyaku.state()).attestations.at(-1)?.data.subject;
  const testimony = JSON.stringify((await result.keiyaku.state()).attestations.at(-1)?.data);
  assert.equal(testimony.includes("workspace"), false);
  assert.equal(testimony.includes("dirty"), false);

  const delivered = await result.keiyaku.deliver({ includeDirty: true });
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "claimed"]);
  assert.equal((await result.keiyaku.state()).attestations.at(-1)?.data.subject, subject);
  assert.equal((await result.keiyaku.state()).terminal?.kind, "claimed");
});

test("a changed worktree patch leaves the reviewed placement pending", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: ["reviewed"] });
  writeFileSync(`${repository.path}/candidate.txt`, "first\n");
  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });
  assert.deepEqual(reviewed.value.workspace?.untracked, ["candidate.txt"]);
  writeFileSync(`${repository.path}/candidate.txt`, "second\n");

  const delivered = await result.keiyaku.deliver({ includeDirty: true });
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver"]);
  assert.equal(delivered.value.placement?.refusal.kind, "gates-unsatisfied");
  assert.equal((await result.keiyaku.state()).terminal, null);
});

test("a changed document leaves an otherwise unchanged reviewed patch pending", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: ["reviewed"] });
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");
  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });

  const amended = await result.keiyaku.amend({
    markdown: "## Replace: Objective\nRequire review of the current contract document.\n",
  });

  const delivered = await result.keiyaku.deliver({ includeDirty: true });
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver"]);
  assert.equal(delivered.value.placement?.refusal.kind, "gates-unsatisfied");
  assert.equal((await result.keiyaku.state()).terminal, null);
});

test("review testimony is recorded when reviewed is not a placement gate", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: [] });
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");

  const reviewed = await result.keiyaku.review({ verdict: "unsatisfied" });
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(reviewed.value.placement, undefined);
  assert.deepEqual(reviewed.value.workspace?.untracked, ["candidate.txt"]);
  assert.equal((await result.keiyaku.state()).attestations.at(-1)?.data.gate, "reviewed");
});
