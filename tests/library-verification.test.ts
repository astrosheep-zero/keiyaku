import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { withGitShim } from "./support/git.js";
import { bind, commitCandidate, document, repositoryWithMain, withImmediateVerificationTimeout } from "./support/library-verbs.js";

test("public deliver keeps its Verification admission in accepted facts", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);

  const delivered = await contract.deliver();
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["deliver", "attestation", "claimed"]);
  assert.equal(delivered.head, (await contract.state()).head);
  assert.equal(delivered.value.integration.predecessor, (await contract.state()).delivery?.data.integration.predecessor);
  assert.equal("verification" in delivered.value, false);
  assert.equal("placement" in delivered.value, false);
  assert.equal((await contract.state()).attestations.at(-1)?.data.verdict, "satisfied");
});

test("status and audit expose only current Verification testimony", async () => {
  const repository = repositoryWithMain();
  const repo = Repo.at({ path: repository.path });
  const bound = await Keiyaku.bind({ repo,
    markdown: document('printf "checked"; printf "warning" >&2'),
    workspace: "here",
    gates: ["reviewed", "verified"],
  });
  commitCandidate(repository);

  const delivered = await bound.keiyaku.deliver();
  const state = await bound.keiyaku.state();
  const expected = {
    verdict: "satisfied" as const,
    summary: "[1 bash exit 0]\nstdout:\nchecked\nstderr:\nwarning",
  };
  const observed = await Keiyaku.observe({ repo, id: state.id });
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") throw new Error("contract was not observed");
  assert.deepEqual(observed.row.gates, {
    reports: [
      { gate: "reviewed", current: { kind: "missing" } },
      { gate: "verified", current: { kind: "attested", ...expected } },
    ],
    satisfied: false,
  });

  const audited = await bound.keiyaku.audit();
  assert.deepEqual(audited.value.timeline.at(-1)?.attestation, {
    gate: "verified",
    ...expected,
  });

  const amended = await bound.keiyaku.amend({
    markdown: "## Replace: Verification\n~~~bash\nprintf changed\n~~~\n",
  });
  const after = await Keiyaku.observe({ repo, id: state.id });
  assert.equal(after.kind, "present");
  if (after.kind !== "present") throw new Error("contract was not observed");
  assert.deepEqual(after.row.gates, {
    reports: [
      { gate: "reviewed", current: { kind: "missing" } },
      { gate: "verified", current: { kind: "stale", priorVerdict: "satisfied" } },
    ],
    satisfied: false,
  });
});

test("amend preserves untouched Verification bytes and currentness", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
    markdown: document("exit 0"),
    workspace: "here",
    gates: ["reviewed", "verified"],
  });
  const verificationSegment = (await bound.keiyaku.state()).terms.segments.at(-1);
  commitCandidate(repository);
  const delivered = await bound.keiyaku.deliver();

  const amended = await bound.keiyaku.amend({ markdown: "## Replace: Objective\nA narrower objective.\n" });
  const after = await bound.keiyaku.state();
  assert.equal(after.terms.segments.at(-1), verificationSegment);
  assert.match(after.terms.document.bytes, /~~~bash\nexit 0\n~~~/);

  const reviewed = await bound.keiyaku.review({ verdict: "satisfied" });
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation", "claimed"]);
});

test("Verification timeout never suppresses placement", async () => {
  const openRepository = repositoryWithMain();
  const open = await Keiyaku.bind({ repo: Repo.at({ path: openRepository.path }),
    markdown: document("exit 0"),
    workspace: "here",
    gates: [],
  });
  commitCandidate(openRepository);
  const openDelivery = await withImmediateVerificationTimeout(() => open.keiyaku.deliver());
  assert.deepEqual(openDelivery.facts.map((fact) => fact.kind), ["deliver", "claimed"]);
  assert.deepEqual(openDelivery.value.verification, { failure: "timeout" });
  assert.equal(openDelivery.value.placement, undefined);
  assert.equal((await open.keiyaku.state()).terminal?.kind, "claimed");

  const gatedRepository = repositoryWithMain();
  const gated = await Keiyaku.bind({ repo: Repo.at({ path: gatedRepository.path }),
    markdown: document("exit 0"),
    workspace: "here",
    gates: ["verified"],
  });
  commitCandidate(gatedRepository);
  const gatedDelivery = await withImmediateVerificationTimeout(() => gated.keiyaku.deliver());
  assert.deepEqual(gatedDelivery.facts.map((fact) => fact.kind), ["deliver"]);
  assert.deepEqual(gatedDelivery.value.verification, { failure: "timeout" });
  assert.deepEqual(gatedDelivery.value.placement, {
    refusal: { kind: "gates-unsatisfied", contractId: (await gated.keiyaku.state()).id },
  });
});

test("public deliver preserves admission when Verification cleanup leaks a worktree", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);
  const delivered = await withGitShim(
    [
      "if [ \"$1\" = \"worktree\" ] && [ \"$2\" = \"remove\" ]; then",
      "  printf 'forced verification cleanup failure\\n' >&2",
      "  exit 17",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    {},
    () => contract.deliver(),
  );
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["deliver", "attestation", "claimed"]);
  assert.equal(delivered.value.leak?.path.startsWith("/"), true);
  assert.match(delivered.value.leak?.diagnostic ?? "", /worktree remove --force .*forced verification cleanup failure/);
  repository.run(["worktree", "remove", "--force", delivered.value.leak!.path]);
});

