import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keiyaku, type ContractId } from "../src/index.js";
import { contractJournalPath } from "../src/carrier/identity.js";
import { repositoryAt } from "../src/carrier/repository.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { entryUlid, type JournalEntry } from "../src/core/facts/types.js";
import { decideAttestation } from "../src/core/verbs/attestation.js";
import { currentSubject } from "../src/core/subject.js";
import { admitReview, admitPlacement } from "../src/protocol/intent.js";
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
  const result = await Keiyaku.bind({
    markdown: document(verification),
    repo: repository.path,
    workspace: "here",
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
      const contract = Keiyaku.of({ id, repo: repository.path });
      return [contract.state(), contract.deliver(), contract.reconcile()] as const;
    },
  );
  const [state, delivered, reconciled] = await Promise.all(operations);

  assert.equal(state.id, id);
  assert.equal(delivered.kind, "accepted");
  assert.equal(reconciled.worktreePath, null);
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

  const reviewed = await delivered.value.review({ verdict: "unsatisfied",
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
  assert.deepEqual((await contract.state()).abandon?.data, { note: "Return the task to planning." });
  const terminalDelivery = await contract.delivery();
  assert.equal(terminalDelivery?.snapshotId, delivered.value.snapshotId);
  assert.deepEqual(await terminalDelivery?.review({ verdict: "satisfied" }), {
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

test("public deliver keeps its Verification admission in the composite receipt", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);

  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was not accepted");
  assert.deepEqual(delivered.receipt.facts.map((fact) => fact.kind), ["deliver", "attestation"]);
  assert.equal(delivered.receipt.prior?.delivery, null);
  assert.equal(delivered.receipt.snapshot.delivery?.data.candidate, delivered.value.snapshotId);
  assert.equal(delivered.receipt.snapshot.attestations.at(-1)?.data.verdict, "satisfied");
});

test("public amend preserves its deciding prior after unknown recovery", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const prior = await contract.state();
  if (prior.body === null) throw new Error("bound contract body is absent");
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
  assert.equal(amended.receipt.prior?.body?.context, prior.body.context);
  assert.equal(amended.receipt.snapshot.body?.context, "Recovered replacement.\n\n");
  assert.equal(amended.receipt.snapshot.currentArc, undefined);
  const live = await contract.state();
  assert.equal(live.currentArc?.data.title, "Recovered race");
  assert.notEqual(amended.receipt.snapshot.head, live.head);
});

test("receipt snapshot excludes an append made after admission", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const prior = await contract.state();
  if (prior.body === null) throw new Error("bound contract body is absent");
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
  assert.equal(amended.receipt.prior?.body?.context, prior.body.context);
  assert.equal(amended.receipt.snapshot.body?.context, "Accepted replacement.\n\n");
  assert.equal(amended.receipt.snapshot.currentArc, undefined);
  assert.equal((await contract.state()).currentArc?.data.title, "Concurrent");
});

test("eligibility placement observes and binds every waiting dependent", async () => {
  const repository = repositoryWithMain();
  const sourceResult = await Keiyaku.bind({
    markdown: document(),
    repo: repository.path,
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

  const sourceState = await source.state();
  const reviewSubject = currentSubject(sourceState, "reviewed");
  if (reviewSubject === null) throw new Error("review subject is absent");
  const reviewed = admitReview(repositoryAt(repository.path), {
    contractId: (await source.state()).id,
    at: "2026-08-06T00:00:00Z",
    data: { gate: "reviewed", subject: reviewSubject, verdict: "satisfied" },
  }, decideAttestation);
  assert.equal(reviewed.kind, "handoff");

  const dependents: Keiyaku[] = [];
  for (let index = 0; index < 4; index += 1) {
    const bound = await Keiyaku.bind({
      markdown: document(),
      repo: repository.path,
      workspace: "here",
      after: [(await source.state()).id],
    });
    assert.equal(bound.kind, "accepted");
    if (bound.kind !== "accepted") throw new Error("dependent bind was not accepted");
    dependents.push(bound.value);
  }

  const placed = admitPlacement(repositoryAt(repository.path), {
    contractId: (await source.state()).id,
    at: "2026-08-06T00:00:01Z",
  });
  assert.equal(placed.kind, "handoff");
  assert.equal((await source.state()).terminal?.kind, "claimed");
  for (const dependent of dependents) {
    assert.equal((await dependent.state()).bound?.kind, "bound");
  }
});

test("review surfaces a placement retry after its attestation is admitted", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "release"]);
  const result = await Keiyaku.bind({
    markdown: document(),
    repo: repository.path,
    target: "refs/heads/release",
    workspace: "here",
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("bind was not accepted");
  commitCandidate(repository);
  const delivered = await result.value.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was not accepted");

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
    '  exit "$status"',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const reviewed = await withGitShim(shim, {}, () => delivered.value.review({ verdict: "satisfied" }));
  assert.equal(reviewed.kind, "retry");
  const state = await result.value.state();
  assert.equal(state.attestations.at(-1)?.data.verdict, "satisfied");
  assert.equal(state.terminal, null);
});

test("public audit exposes admitted verified attestations through the receipt", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 1");
  commitCandidate(repository);

  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  const audited = await contract.audit();
  assert.equal(audited.kind, "accepted");
  if (audited.kind !== "accepted") throw new Error("audit was not accepted");
  assert.deepEqual(audited.receipt.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(audited.value.reworks, 1);
  assert.equal(audited.value.reviewed, 0);
  assert.equal(audited.value.timeline.at(-1)?.kind, "attestation");
  assert.equal(audited.value.attempt, undefined);
});

test("public read-only audit returns an empty receipt without a second outcome kind", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);

  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  const audited = await contract.audit();
  assert.equal(audited.kind, "accepted");
  if (audited.kind !== "accepted") throw new Error("audit was not accepted");
  assert.deepEqual(audited.receipt.facts, []);
  assert.equal(audited.value.attempt, undefined);
});

test("public audit refuses a missing contract without escaping Outcome", async () => {
  const repository = repositoryWithMain();
  const contract = Keiyaku.of({ id: "kei/missing" as ContractId, repo: repository.path });

  assert.deepEqual(await contract.audit(), {
    kind: "refused",
    refusal: { kind: "contract-missing", contractId: "kei/missing" },
  });
});

test("a Delivery handle refuses review after a replacement tender", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  commitCandidate(repository);
  const first = await contract.deliver();
  assert.equal(first.kind, "accepted");
  if (first.kind !== "accepted") throw new Error("first delivery was not accepted");

  writeFileSync(`${repository.path}/candidate.txt`, "replacement\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "replacement"]);
  const replacement = await contract.deliver();
  assert.equal(replacement.kind, "accepted");

  const refused = await first.value.review({ verdict: "satisfied" });
  assert.equal(refused.kind, "refused");
  if (refused.kind === "refused") assert.equal(refused.refusal.kind, "stale-subject");
});

test("a Delivery handle refuses review after an amendment and redelivery", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  commitCandidate(repository);
  const first = await contract.deliver();
  assert.equal(first.kind, "accepted");
  if (first.kind !== "accepted") throw new Error("first delivery was not accepted");

  const amended = await contract.amend({ markdown: [
    "## Replace: Objective",
    "Require a current delivery subject.",
    "",
  ].join("\n") });
  assert.equal(amended.kind, "accepted");
  const redelivered = await contract.deliver();
  assert.equal(redelivered.kind, "accepted");

  const refused = await first.value.review({ verdict: "satisfied" });
  assert.equal(refused.kind, "refused");
  if (refused.kind === "refused") assert.equal(refused.refusal.kind, "stale-subject");
});
