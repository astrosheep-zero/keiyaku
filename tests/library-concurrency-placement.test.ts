import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keiyaku, KeiyakuRetry, Repo } from "../src/index.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { entryUlid, type JournalEntry } from "../src/core/facts/types.js";
import { contractJournalPath } from "../src/git/identity.js";
import { repositoryAt } from "../src/git/repository.js";
import { deliveryWorktreePath } from "../src/git/workspace.js";
import { withGitShim } from "./support/git.js";
import { bind, commitCandidate, document, refused, repositoryWithMain } from "./support/library-verbs.js";

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

test("claim does not mutate eligible dependents", async () => {
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

  await source.review({ verdict: "satisfied" });
  assert.equal((await source.state()).terminal?.kind, "claimed");
  for (const dependent of dependents) {
    const state = await dependent.state();
    assert.equal(state.bound, null);
    assert.equal(state.terminal, null);
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
