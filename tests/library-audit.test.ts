import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, Repo, type ContractId } from "../src/index.js";
import { withGitShim } from "./support/git.js";
import { bind, commitCandidate, document, refused, repositoryWithMain } from "./support/library-verbs.js";

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
