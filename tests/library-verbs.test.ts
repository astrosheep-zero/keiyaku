import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keiyaku, KeiyakuRefused, KeiyakuRetry, Repo, type ContractId, type KeiyakuRefusal } from "../src/index.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { contractJournalPath } from "../src/git/identity.js";
import { deliveryWorktreePath } from "../src/git/workspace.js";
import { repositoryAt } from "../src/git/repository.js";
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

function refused(expected: KeiyakuRefusal): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof KeiyakuRefused);
    assert.deepEqual(error.refusal, expected);
    return true;
  };
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
  const result = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
    markdown: document(verification),
    workspace: "here",
    gates: verification === undefined ? ["reviewed"] : ["verified"],
  });
  return result.keiyaku;
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
  await assert.rejects(
    contract.review({ verdict: "satisfied" }),
    refused({ kind: "terminal", contractId: (await contract.state()).id }),
  );

  await assert.rejects(
    contract.arc({ markdown: [
      "# Late",
      "",
      "## Objective",
      "Too late.",
      "",
      "## Brief",
      "Must refuse.",
      "",
    ].join("\n") }),
    refused({ kind: "terminal", contractId: (await contract.state()).id }),
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
  await dependent.keiyaku.abandon();
  const status = await Keiyaku.list({ repo: Repo.at({ path: repository.path }) });
  const dependentId = (await dependent.keiyaku.state()).id;
  const path = status.rows.find((contract) => contract.id === dependentId)?.worktreePath;
  assert.ok(path);
  assert.equal(existsSync(path), false);

  await assert.rejects(
    dependent.keiyaku.deliver(),
    refused({ kind: "terminal", contractId: (await dependent.keiyaku.state()).id }),
  );
});

test("review records before delivery and the same patch can be placed", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: ["reviewed"] });
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");

  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(reviewed.value.placement?.refusal.kind, "delivery-missing");
  const subject = (await result.keiyaku.state()).attestations.at(-1)?.data.subject;

  const delivered = await result.keiyaku.deliver();
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["deliver", "claimed"]);
  assert.equal((await result.keiyaku.state()).attestations.at(-1)?.data.subject, subject);
  assert.equal((await result.keiyaku.state()).terminal?.kind, "claimed");
});

test("a changed worktree patch leaves the reviewed placement pending", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: ["reviewed"] });
  writeFileSync(`${repository.path}/candidate.txt`, "first\n");
  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });
  writeFileSync(`${repository.path}/candidate.txt`, "second\n");

  const delivered = await result.keiyaku.deliver();
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["deliver"]);
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

  const delivered = await result.keiyaku.deliver();
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["deliver"]);
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
  assert.equal((await result.keiyaku.state()).attestations.at(-1)?.data.gate, "reviewed");
});

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
  await assert.rejects(
    withGitShim(
      [
      "if [ \"$1\" = \"update-ref\" ] && [ ! -e \"$KEIYAKU_AMEND_RACE_MARKER\" ]; then",
      "  touch \"$KEIYAKU_AMEND_RACE_MARKER\"",
      "  node --import \"$KEIYAKU_AMEND_RACE_LOADER\" --input-type=module -e 'const { Keiyaku, Repo } = await import(process.env.KEIYAKU_AMEND_RACE_MODULE); await Keiyaku.of({ repo: Repo.at({ path: process.env.KEIYAKU_AMEND_RACE_REPO }), id: process.env.KEIYAKU_AMEND_RACE_ID }).amend({ markdown: process.env.KEIYAKU_AMEND_RACE_MARKDOWN });' || exit $?",
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
    ),
    refused({ kind: "terms-moved", contractId: initial.id }),
  );
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

  let retry: KeiyakuRetry | undefined;
  await assert.rejects(
    withGitShim(
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
    ),
    (error: unknown) => {
      assert.ok(error instanceof KeiyakuRetry);
      retry = error;
      return true;
    },
  );
  assert.equal(retry?.code, "publication-failed");
  if (retry?.reason.kind === "publication-failed") assert.match(retry.reason.diagnostic, /forced hard publication failure/);
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
  assert.deepEqual(amended.facts.map((fact) => fact.kind), ["amend"]);
  assert.equal((await contract.state()).currentArc?.data.title, "Concurrent");
});

test("eligibility placement observes and binds every waiting dependent", async () => {
  const repository = repositoryWithMain();
  const sourceResult = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "here",
    gates: ["reviewed"],
  });
  const source = sourceResult.keiyaku;
  commitCandidate(repository);
  const delivered = await source.deliver();

  const dependents: Keiyaku[] = [];
  for (let index = 0; index < 4; index += 1) {
    const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
      markdown: document(),
      workspace: "here",
      after: [(await source.state()).id],
    });
    dependents.push(bound.keiyaku);
  }

  const reviewed = await source.review({ verdict: "satisfied" });
  assert.equal((await source.state()).terminal?.kind, "claimed");
  for (const dependent of dependents) {
    assert.equal((await dependent.state()).bound?.kind, "bound");
  }
});

test("review stops placement when its verified target premise moves", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "release"]);
  const result = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
    markdown: document(),
    target: "refs/heads/release",
    workspace: "worktree",
    gates: ["reviewed"],
  });
  const worktree = deliveryWorktreePath(repositoryAt(repository.path), result.keiyaku.id);
  writeFileSync(resolve(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const delivered = await result.keiyaku.deliver();
  commitCandidate(repository);

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
  }, () => result.keiyaku.review({ verdict: "satisfied" }));
  assert.deepEqual(reviewed.value.placement, {
    failure: "target-moved",
    contractId: result.keiyaku.id,
    target: "refs/heads/release",
    expected: delivered.value.integration.predecessor,
    observed: repository.run(["rev-parse", "HEAD"]).trim(),
  });
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  const state = await result.keiyaku.state();
  assert.equal(state.attestations.at(-1)?.data.verdict, "satisfied");
  assert.equal(state.terminal, null);
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
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
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
  const contract = Keiyaku.of({ repo: Repo.at({ path: repository.path }), id: "kei/missing" as ContractId });

  await assert.rejects(
    contract.audit(),
    refused({ kind: "contract-missing", contractId: "kei/missing" as ContractId }),
  );
});
