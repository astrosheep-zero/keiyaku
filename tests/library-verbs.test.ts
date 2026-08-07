import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Repo, type ContractId, type Keiyaku } from "../src/index.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { contractJournalPath } from "../src/carrier/identity.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { entryUlid, type JournalEntry } from "../src/core/facts/types.js";
import { makeGitRepository, type TestGitRepository, withGitShim } from "./support/git.js";

function repositoryWithMain(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function document(verification?: string): string {
  return [
    "# Library verbs",
    "",
    "## Context",
    "Exercise the public domain objects.",
    "",
    "## Objective",
    "Keep the CLI from owning a second lifecycle.",
    "",
    "## Design",
    "Call only the package-root API.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Public path",
    "The public path preserves fact payloads.",
    ...(verification === undefined ? [] : [
      "",
      "## Verification",
      "~~~bash",
      verification,
      "~~~",
    ]),
    "",
  ].join("\n");
}

async function bind(repository: TestGitRepository, verification?: string) {
  const result = await Repo.at({ path: repository.path }).bind({
    markdown: document(verification),
    workspace: "here",
    gates: verification === undefined ? ["reviewed"] : ["verified"],
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("bind was not accepted");
  return result.value;
}

function commitCandidate(repository: TestGitRepository): void {
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);
}

async function withImmediateVerificationTimeout<T>(run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let readings = 0;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => (readings++ === 0 ? 0 : 5 * 60 * 1_000 + 1) },
  });
  try {
    return await run();
  } finally {
    if (descriptor === undefined) delete (globalThis as { performance?: Performance }).performance;
    else Object.defineProperty(globalThis, "performance", descriptor);
  }
}

test("Delivery.diff freshly reads its pinned candidate diff", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  commitCandidate(repository);
  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was not accepted");

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
  const log = resolve(repository.path, "scope-discovery.log");
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
      const contract = Repo.at({ path: repository.path }).contract({ id });
      return [contract.state(), contract.deliver(), contract.reconcile()] as const;
    },
  );
  const [state, delivered] = await Promise.all(operations);

  assert.equal(state.id, id);
  assert.equal(delivered.kind, "accepted");
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
  assert.equal(arc.kind, "accepted");
  assert.equal((await contract.state()).currentArc?.data.seq, 1);

  commitCandidate(repository);
  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was not accepted");
  const recovered = await contract.delivery();
  assert.equal(recovered?.snapshotId, delivered.value.snapshotId);
  assert.equal(recovered?.changeId, delivered.value.changeId);

  const reviewed = await contract.review({ verdict: "unsatisfied",
    summary: "The candidate still needs one correction.",
  });
  assert.equal(reviewed.kind, "accepted");
  assert.equal((await contract.state()).attestations.at(-1)?.data.summary, "The candidate still needs one correction.");

  await assert.rejects(
    // @ts-expect-error The deleted reason enum is not an abandon options object.
    () => contract.abandon("manual"),
    /abandon input must be an object/,
  );
  const abandoned = await contract.abandon({ note: "Return the task to planning." });
  assert.equal(abandoned.kind, "accepted");
  assert.equal((await contract.state()).terminal?.kind, "abandoned");
  assert.deepEqual((await contract.state()).terminal?.data, { note: "Return the task to planning." });
  const terminalDelivery = await contract.delivery();
  assert.equal(terminalDelivery?.snapshotId, delivered.value.snapshotId);
  assert.deepEqual(await contract.review({ verdict: "satisfied" }), {
    kind: "refused",
    refusal: { kind: "terminal", contractId: (await contract.state()).id },
  });

  const terminalArc = await contract.arc({ markdown: [
    "# Late",
    "",
    "## Objective",
    "Too late.",
    "",
    "## Brief",
    "Must refuse.",
    "",
  ].join("\n") });
  assert.deepEqual(terminalArc, {
    kind: "refused",
    refusal: { kind: "terminal", contractId: (await contract.state()).id },
  });
});

test("delivery terminal refusal outranks a missing managed worktree", async () => {
  const repository = repositoryWithMain();
  const prerequisite = await bind(repository);
  const prerequisiteId = (await prerequisite.state()).id;
  const dependent = await Repo.at({ path: repository.path }).bind({
    markdown: document(),
    workspace: "worktree",
    gates: ["reviewed"],
    after: [prerequisiteId],
  });
  assert.equal(dependent.kind, "accepted");
  if (dependent.kind !== "accepted") throw new Error("dependent bind was not accepted");
  assert.equal((await dependent.value.state()).bound, null);
  assert.equal((await dependent.value.abandon()).kind, "accepted");
  const status = await Repo.at({ path: repository.path }).status();
  const dependentId = (await dependent.value.state()).id;
  const path = status.contracts.find((contract) => contract.contractId === dependentId)?.worktreePath;
  assert.ok(path);
  assert.equal(existsSync(path), false);

  assert.deepEqual(await dependent.value.deliver(), {
    kind: "refused",
    refusal: { kind: "terminal", contractId: (await dependent.value.state()).id },
  });
});

test("review records before delivery and the same patch can be placed", async () => {
  const repository = repositoryWithMain();
  const result = await Repo.at({ path: repository.path }).bind({ markdown: document(), workspace: "here", gates: ["reviewed"] });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("bind was not accepted");
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");

  const reviewed = await result.value.review({ verdict: "satisfied" });
  assert.equal(reviewed.kind, "accepted");
  if (reviewed.kind !== "accepted") throw new Error("review was not accepted");
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(reviewed.value.placement?.refusal.kind, "delivery-missing");
  const subject = (await result.value.state()).attestations.at(-1)?.data.subject;

  const delivered = await result.value.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was not accepted");
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["deliver", "claimed"]);
  assert.equal((await result.value.state()).attestations.at(-1)?.data.subject, subject);
  assert.equal((await result.value.state()).terminal?.kind, "claimed");
});

test("a changed worktree patch leaves the reviewed placement pending", async () => {
  const repository = repositoryWithMain();
  const result = await Repo.at({ path: repository.path }).bind({ markdown: document(), workspace: "here", gates: ["reviewed"] });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("bind was not accepted");
  writeFileSync(`${repository.path}/candidate.txt`, "first\n");
  const reviewed = await result.value.review({ verdict: "satisfied" });
  assert.equal(reviewed.kind, "accepted");
  writeFileSync(`${repository.path}/candidate.txt`, "second\n");

  const delivered = await result.value.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was not accepted");
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["deliver"]);
  assert.equal(delivered.value.placement?.refusal.kind, "gates-unsatisfied");
  assert.equal((await result.value.state()).terminal, null);
});

test("review testimony is recorded when reviewed is not a placement gate", async () => {
  const repository = repositoryWithMain();
  const result = await Repo.at({ path: repository.path }).bind({ markdown: document(), workspace: "here", gates: [] });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("bind was not accepted");
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");

  const reviewed = await result.value.review({ verdict: "unsatisfied" });
  assert.equal(reviewed.kind, "accepted");
  if (reviewed.kind !== "accepted") throw new Error("review was not accepted");
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(reviewed.value.placement, undefined);
  assert.equal((await result.value.state()).attestations.at(-1)?.data.gate, "reviewed");
});

test("public deliver keeps its Verification admission in accepted facts", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);

  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was not accepted");
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["deliver", "attestation", "claimed"]);
  assert.equal(delivered.head, (await contract.state()).head);
  assert.equal(delivered.value.expectedPredecessor, (await contract.state()).delivery?.data.expectedPredecessor);
  assert.equal("verification" in delivered.value, false);
  assert.equal("placement" in delivered.value, false);
  assert.equal((await contract.state()).attestations.at(-1)?.data.verdict, "satisfied");
});

test("status and audit expose only current Verification testimony", async () => {
  const repository = repositoryWithMain();
  const repo = Repo.at({ path: repository.path });
  const bound = await repo.bind({
    markdown: document('printf "checked"; printf "warning" >&2'),
    workspace: "here",
    gates: ["reviewed", "verified"],
  });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  commitCandidate(repository);

  const delivered = await bound.value.deliver();
  assert.equal(delivered.kind, "accepted");
  const state = await bound.value.state();
  const expected = {
    verdict: "satisfied" as const,
    summary: "[1 bash exit 0]\nstdout:\nchecked\nstderr:\nwarning",
  };
  assert.deepEqual((await repo.status({ contract: state.id })).contracts[0]?.verification, expected);

  const audited = await bound.value.audit();
  assert.equal(audited.kind, "accepted");
  if (audited.kind !== "accepted") throw new Error("audit was not accepted");
  assert.deepEqual(audited.value.timeline.at(-1)?.attestation, {
    gate: "verified",
    ...expected,
  });

  const amended = await bound.value.amend({
    markdown: "## Replace: Verification\n~~~bash\nprintf changed\n~~~\n",
  });
  assert.equal(amended.kind, "accepted");
  assert.equal((await repo.status({ contract: state.id })).contracts[0]?.verification, null);
});

test("amend preserves untouched Verification bytes and currentness", async () => {
  const repository = repositoryWithMain();
  const bound = await Repo.at({ path: repository.path }).bind({
    markdown: document("exit 0"),
    workspace: "here",
    gates: ["reviewed", "verified"],
  });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const verificationSegment = (await bound.value.state()).terms.segments.at(-1);
  commitCandidate(repository);
  const delivered = await bound.value.deliver();
  assert.equal(delivered.kind, "accepted");

  const amended = await bound.value.amend({ markdown: "## Replace: Objective\nA narrower objective.\n" });
  assert.equal(amended.kind, "accepted");
  const after = await bound.value.state();
  assert.equal(after.terms.segments.at(-1), verificationSegment);
  assert.match(after.terms.document.bytes, /~~~bash\nexit 0\n~~~/);

  const reviewed = await bound.value.review({ verdict: "satisfied" });
  assert.equal(reviewed.kind, "accepted");
  if (reviewed.kind !== "accepted") throw new Error("review was not accepted");
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation", "claimed"]);
});

test("Verification timeout never suppresses placement", async () => {
  const openRepository = repositoryWithMain();
  const open = await Repo.at({ path: openRepository.path }).bind({
    markdown: document("exit 0"),
    workspace: "here",
    gates: [],
  });
  assert.equal(open.kind, "accepted");
  if (open.kind !== "accepted") throw new Error("open contract was not accepted");
  commitCandidate(openRepository);
  const openDelivery = await withImmediateVerificationTimeout(() => open.value.deliver());
  assert.equal(openDelivery.kind, "accepted");
  if (openDelivery.kind !== "accepted") throw new Error("open delivery was not accepted");
  assert.deepEqual(openDelivery.facts.map((fact) => fact.kind), ["deliver", "claimed"]);
  assert.deepEqual(openDelivery.value.verification, { failure: "timeout" });
  assert.equal(openDelivery.value.placement, undefined);
  assert.equal((await open.value.state()).terminal?.kind, "claimed");

  const gatedRepository = repositoryWithMain();
  const gated = await Repo.at({ path: gatedRepository.path }).bind({
    markdown: document("exit 0"),
    workspace: "here",
    gates: ["verified"],
  });
  assert.equal(gated.kind, "accepted");
  if (gated.kind !== "accepted") throw new Error("gated contract was not accepted");
  commitCandidate(gatedRepository);
  const gatedDelivery = await withImmediateVerificationTimeout(() => gated.value.deliver());
  assert.equal(gatedDelivery.kind, "accepted");
  if (gatedDelivery.kind !== "accepted") throw new Error("gated delivery was not accepted");
  assert.deepEqual(gatedDelivery.facts.map((fact) => fact.kind), ["deliver"]);
  assert.deepEqual(gatedDelivery.value.verification, { failure: "timeout" });
  assert.deepEqual(gatedDelivery.value.placement, {
    refusal: { kind: "gates-unsatisfied", contractId: (await gated.value.state()).id },
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

  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") return;
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["deliver", "attestation", "claimed"]);
  assert.equal(delivered.value.leak?.path.startsWith("/"), true);
  assert.match(delivered.value.leak?.diagnostic ?? "", /worktree remove --force .*forced verification cleanup failure/);
  repository.run(["worktree", "remove", "--force", delivered.value.leak!.path]);
});

test("public amend returns the recovered journal head after unknown recovery", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const prior = await contract.state();
  const replacement = "## Replace: Context\nRecovered replacement.\n\n";
  const concurrent: JournalEntry = {
    v: 1,
    kind: "arc",
    contract: prior.id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB1"),
    at: "2026-08-06T00:00:02Z",
    data: { seq: 1, title: "Recovered race", objective: "Race", brief: "Append before recovery observes." },
  };
  const marker = `${repository.path}/unknown-recovery.marker`;

  const amended = await withGitShim(
    [
      "if [ \"$1\" = \"update-ref\" ] && [ ! -e \"$KEIYAKU_MARKER\" ]; then",
      "  \"$KEIYAKU_REAL_GIT\" \"$@\" || exit $?",
      "  current=$(\"$KEIYAKU_REAL_GIT\" rev-parse refs/heads/keiyaku-state)",
      "  tree=$(\"$KEIYAKU_REAL_GIT\" rev-parse \"$current^{tree}\")",
      "  line=$(\"$KEIYAKU_REAL_GIT\" ls-tree \"$tree\" -- \"$KEIYAKU_CONTRACT_PATH\")",
      "  oid=$(printf '%s\\n' \"$line\" | awk '{print $3}')",
      "  journal=$(mktemp)",
      "  \"$KEIYAKU_REAL_GIT\" cat-file blob \"$oid\" > \"$journal\"",
      "  printf '%s' \"$KEIYAKU_EXTRA_ENTRY\" >> \"$journal\"",
      "  next=$(\"$KEIYAKU_REAL_GIT\" hash-object -w --stdin < \"$journal\")",
      "  index=$(mktemp)",
      "  rm -f \"$index\"",
      "  GIT_INDEX_FILE=\"$index\" \"$KEIYAKU_REAL_GIT\" read-tree \"$tree\"",
      "  printf '100644 blob %s\\t%s\\n' \"$next\" \"$KEIYAKU_CONTRACT_PATH\" | GIT_INDEX_FILE=\"$index\" \"$KEIYAKU_REAL_GIT\" update-index --index-info",
      "  next_tree=$(GIT_INDEX_FILE=\"$index\" \"$KEIYAKU_REAL_GIT\" write-tree)",
      "  next_commit=$(\"$KEIYAKU_REAL_GIT\" commit-tree \"$next_tree\" -p \"$current\" < /dev/null)",
      "  \"$KEIYAKU_REAL_GIT\" update-ref refs/heads/keiyaku-state \"$next_commit\" \"$current\"",
      "  rm -f \"$journal\" \"$index\"",
      "  touch \"$KEIYAKU_MARKER\"",
      "  kill -TERM $$",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    {
      KEIYAKU_MARKER: marker,
      KEIYAKU_CONTRACT_PATH: contractJournalPath(prior.id),
      KEIYAKU_EXTRA_ENTRY: encodeEntry(concurrent),
    },
    () => contract.amend({ markdown: replacement }),
  );

  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("amend was not accepted");
  assert.deepEqual(amended.facts.map((fact) => fact.kind), ["amend"]);
  const live = await contract.state();
  assert.equal(live.currentArc?.data.title, "Recovered race");
  assert.equal(amended.head, live.head);
});

test("a concurrent amend redecides and returns terms-moved without replaying old input", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const initial = await contract.state();
  const marker = `${repository.path}/amend-race.marker`;
  const B = [
    "## Replace: Objective",
    "B's D0 amendment wins the admission race.",
    "",
  ].join("\n");

  const A = [
    "## Replace: Context",
    "A's D0 amendment must not be replayed against D1B.",
    "",
  ].join("\n");
  const amended = await withGitShim(
    [
      "if [ \"$1\" = \"update-ref\" ] && [ ! -e \"$KEIYAKU_AMEND_RACE_MARKER\" ]; then",
      "  touch \"$KEIYAKU_AMEND_RACE_MARKER\"",
      "  node --import \"$KEIYAKU_AMEND_RACE_LOADER\" --input-type=module -e 'const { Repo } = await import(process.env.KEIYAKU_AMEND_RACE_MODULE); const result = await Repo.at({ path: process.env.KEIYAKU_AMEND_RACE_REPO }).contract({ id: process.env.KEIYAKU_AMEND_RACE_ID }).amend({ markdown: process.env.KEIYAKU_AMEND_RACE_MARKDOWN }); if (result.kind !== \"accepted\") process.exit(1);' || exit $?",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    {
      KEIYAKU_AMEND_RACE_MARKER: marker,
      KEIYAKU_AMEND_RACE_LOADER: new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
      KEIYAKU_AMEND_RACE_MODULE: new URL("../src/index.ts", import.meta.url).href,
      KEIYAKU_AMEND_RACE_ID: initial.id,
      KEIYAKU_AMEND_RACE_REPO: repository.path,
      KEIYAKU_AMEND_RACE_MARKDOWN: B,
    },
    () => contract.amend({ markdown: A }),
  );

  assert.deepEqual(amended, {
    kind: "refused",
    refusal: { kind: "terms-moved", contractId: initial.id },
  });
  const current = await contract.state();
  const initialBody = decodeContractDocument(initial.terms.document.bytes);
  const currentBody = decodeContractDocument(current.terms.document.bytes);
  assert.equal(currentBody.context.trim(), initialBody.context.trim());
  assert.equal(currentBody.objective.trim(), "B's D0 amendment wins the admission race.");
  assert.equal(current.terms.document.key === initial.terms.document.key, false);
});

test("a hard publication failure is returned without replaying the operation", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const attempts = `${repository.path}/publication-attempts`;

  const amended = await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      '  cat >/dev/null',
      '  printf "attempt\\n" >> "$KEIYAKU_ATTEMPTS"',
      '  printf "forced hard publication failure\\n" >&2',
      '  exit 42',
      'fi',
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_ATTEMPTS: attempts },
    () => contract.amend({ markdown: "## Replace: Context\nNo coordinate moved.\n" }),
  );

  assert.equal(amended.kind, "retry");
  if (amended.kind !== "retry") return;
  assert.equal(amended.reason.kind, "publication-failed");
  if (amended.reason.kind === "publication-failed") {
    assert.match(amended.reason.diagnostic, /forced hard publication failure/);
  }
  assert.deepEqual(readFileSync(attempts, "utf8").trim().split("\n"), ["attempt"]);
});

test("accepted head excludes an append made after admission", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const prior = await contract.state();
  const replacement = "## Replace: Context\nAccepted replacement.\n\n";
  const concurrent: JournalEntry = {
    v: 1,
    kind: "arc",
    contract: prior.id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
    at: "2026-08-06T00:00:01Z",
    data: { seq: 1, title: "Concurrent", objective: "Race", brief: "Append after admission." },
  };
  const marker = `${repository.path}/post-admission.marker`;
  const amended = await withGitShim(
    [
      "if [ \"$1\" = \"update-ref\" ] && [ ! -e \"$KEIYAKU_MARKER\" ]; then",
      "  \"$KEIYAKU_REAL_GIT\" \"$@\" || exit $?",
      "  current=$(\"$KEIYAKU_REAL_GIT\" rev-parse refs/heads/keiyaku-state)",
      "  tree=$(\"$KEIYAKU_REAL_GIT\" rev-parse \"$current^{tree}\")",
      "  line=$(\"$KEIYAKU_REAL_GIT\" ls-tree \"$tree\" -- \"$KEIYAKU_CONTRACT_PATH\")",
      "  oid=$(printf '%s\\n' \"$line\" | awk '{print $3}')",
      "  journal=$(mktemp)",
      "  \"$KEIYAKU_REAL_GIT\" cat-file blob \"$oid\" > \"$journal\"",
      "  printf '%s' \"$KEIYAKU_EXTRA_ENTRY\" >> \"$journal\"",
      "  next=$(\"$KEIYAKU_REAL_GIT\" hash-object -w --stdin < \"$journal\")",
      "  index=$(mktemp)",
      "  rm -f \"$index\"",
      "  GIT_INDEX_FILE=\"$index\" \"$KEIYAKU_REAL_GIT\" read-tree \"$tree\"",
      "  printf '100644 blob %s\\t%s\\n' \"$next\" \"$KEIYAKU_CONTRACT_PATH\" | GIT_INDEX_FILE=\"$index\" \"$KEIYAKU_REAL_GIT\" update-index --index-info",
      "  next_tree=$(GIT_INDEX_FILE=\"$index\" \"$KEIYAKU_REAL_GIT\" write-tree)",
      "  next_commit=$(\"$KEIYAKU_REAL_GIT\" commit-tree \"$next_tree\" -p \"$current\" < /dev/null)",
      "  \"$KEIYAKU_REAL_GIT\" update-ref refs/heads/keiyaku-state \"$next_commit\" \"$current\"",
      "  rm -f \"$journal\" \"$index\"",
      "  touch \"$KEIYAKU_MARKER\"",
      "  exit 0",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    {
      KEIYAKU_MARKER: marker,
      KEIYAKU_CONTRACT_PATH: contractJournalPath(prior.id),
      KEIYAKU_EXTRA_ENTRY: encodeEntry(concurrent),
    },
    () => contract.amend({ markdown: replacement }),
  );

  assert.equal(amended.kind, "accepted", JSON.stringify(amended));
  if (amended.kind !== "accepted") throw new Error("amend was not accepted");
  assert.deepEqual(amended.facts.map((fact) => fact.kind), ["amend"]);
  assert.equal((await contract.state()).currentArc?.data.title, "Concurrent");
});

test("eligibility placement observes and binds every waiting dependent", async () => {
  const repository = repositoryWithMain();
  const sourceResult = await Repo.at({ path: repository.path }).bind({
    markdown: document(),
    workspace: "here",
    gates: ["reviewed"],
  });
  assert.equal(sourceResult.kind, "accepted");
  if (sourceResult.kind !== "accepted") throw new Error("source bind was not accepted");
  const source = sourceResult.value;
  commitCandidate(repository);
  const delivered = await source.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("delivery was not accepted");

  const dependents: Keiyaku[] = [];
  for (let index = 0; index < 4; index += 1) {
    const bound = await Repo.at({ path: repository.path }).bind({
      markdown: document(),
      workspace: "here",
      after: [(await source.state()).id],
    });
    assert.equal(bound.kind, "accepted");
    if (bound.kind !== "accepted") throw new Error("dependent bind was not accepted");
    dependents.push(bound.value);
  }

  const reviewed = await source.review({ verdict: "satisfied" });
  assert.equal(reviewed.kind, "accepted");
  assert.equal((await source.state()).terminal?.kind, "claimed");
  for (const dependent of dependents) {
    assert.equal((await dependent.state()).bound?.kind, "bound");
  }
});

test("review exhausts placement after its target premise moves", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "release"]);
  const result = await Repo.at({ path: repository.path }).bind({
    markdown: document(),
    target: "refs/heads/release",
    workspace: "here",
    gates: ["reviewed"],
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("bind was not accepted");
  commitCandidate(repository);
  const delivered = await result.value.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was not accepted");

  const failed = `${repository.path}/publication-failed.marker`;
  const shim = [
    'if [ "$1" = "update-ref" ]; then',
    '  input_file=$(mktemp)',
    '  cat >"$input_file"',
    '  if grep -q "refs/heads/release" "$input_file"; then',
    '    candidate=$("$KEIYAKU_REAL_GIT" rev-parse HEAD)',
    '    "$KEIYAKU_REAL_GIT" update-ref refs/heads/release "$candidate"',
    '  fi',
    '  "$KEIYAKU_REAL_GIT" "$@" <"$input_file"',
    '  status=$?',
    '  rm -f "$input_file"',
    '  touch "$KEIYAKU_PUBLICATION_FAILED"',
    '  exit "$status"',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const reviewed = await withGitShim(shim, {
    KEIYAKU_PUBLICATION_FAILED: failed,
  }, () => result.value.review({ verdict: "satisfied" }));
  assert.equal(reviewed.kind, "accepted");
  if (reviewed.kind === "accepted") {
    assert.ok(reviewed.value.placement?.retry);
    assert.equal("kind" in reviewed.value.placement!, false);
    const retry = reviewed.value.placement!.retry!;
    assert.equal(retry.kind, "exhausted");
    assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  }
  const state = await result.value.state();
  assert.equal(state.attestations.at(-1)?.data.verdict, "satisfied");
  assert.equal(state.terminal, null);
});

test("public audit exposes admitted verified attestations through facts", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 1");
  commitCandidate(repository);

  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  const audited = await contract.audit();
  assert.equal(audited.kind, "accepted");
  if (audited.kind !== "accepted") throw new Error("audit was not accepted");
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
  const bound = await Repo.at({ path: repository.path }).bind({
    markdown: document("exit 0"),
    workspace: "here",
    gates: ["reviewed"],
  });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  commitCandidate(repository);
  const delivered = await bound.value.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was not accepted");
  repository.run(["reset", "--hard", delivered.value.expectedPredecessor]);
  repository.run(["reflog", "expire", "--expire=now", "--all"]);
  repository.run(["prune", "--expire=now"]);

  const audited = await bound.value.audit();
  assert.equal(audited.kind, "accepted");
  if (audited.kind !== "accepted") throw new Error("audit was not accepted");
  assert.deepEqual(audited.facts, []);
  assert.equal(audited.value.attempt?.failure, "candidate-unavailable");
  if (audited.value.attempt && "diagnostic" in audited.value.attempt) {
    assert.match(audited.value.attempt.diagnostic, /worktree add --detach/);
  }
  assert.equal(audited.value.timeline.some((entry) => entry.kind === "deliver"), true);
});

test("public read-only audit returns empty facts without a second outcome kind", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);

  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  const audited = await contract.audit();
  assert.equal(audited.kind, "accepted");
  if (audited.kind !== "accepted") throw new Error("audit was not accepted");
  assert.deepEqual(audited.facts, []);
  assert.deepEqual(audited.value.attempt, {
    refusal: { kind: "terminal", contractId: (await contract.state()).id },
  });
});

test("public audit refuses a missing contract without escaping Outcome", async () => {
  const repository = repositoryWithMain();
  const contract = Repo.at({ path: repository.path }).contract({ id: "kei/missing" as ContractId });

  assert.deepEqual(await contract.audit(), {
    kind: "refused",
    refusal: { kind: "contract-missing", contractId: "kei/missing" },
  });
});
