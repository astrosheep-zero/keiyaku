import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { appointedWorktreePath, cachedRepositoryAt } from "./support/git.js";
import { bind, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";

async function fixture() {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const state = await contract.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  commitCandidate(repository, worktree);
  return { repository, contract, state, worktree };
}

async function dependentFixture(diverged: boolean) {
  const { repository, contract: primary, state: initial } = await fixture();
  const dependent = (
    await Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: document().replace("# Library verbs", "# Completion dependent"),
      workspace: "worktree",
      gates: [],
      after: [initial.id],
    })
  ).keiyaku;
  const childState = await dependent.state();
  const childPath = await appointedWorktreePath(await cachedRepositoryAt(repository.path), childState.id);
  if (diverged) {
    writeFileSync(join(childPath, "dependent.txt"), "dependent\n");
    repository.run(["-C", childPath, "add", "dependent.txt"]);
    repository.run(["-C", childPath, "commit", "--quiet", "-m", "dependent candidate"]);
  }
  const childHead = repository.run(["-C", childPath, "rev-parse", "HEAD"]).trim();
  const delivered = await dependent.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("expected an accepted dependent delivery");
  const placement = delivered.value.placement;
  assert.equal(placement && "refusal" in placement ? placement.refusal.kind : undefined, "prerequisites-unsatisfied");
  await primary.deliver();
  return { repository, primary, initial, dependent, childState, childPath, childHead };
}

test("review before delivery records one leading fact and delivery later claims automatically", async () => {
  const { contract } = await fixture();
  const review = await contract.review({ verdict: "satisfied" });
  assert.deepEqual(
    review.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(review.value.completion, undefined);
  const placement = review.value.placement;
  assert.equal(placement && "refusal" in placement ? placement.refusal.kind : undefined, "delivery-missing");
  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("expected an accepted delivery");
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver", "claimed"],
  );
  assert.ok(delivered.value.completion);
  const state = await contract.state();
  assert.equal(state.terminal?.kind, "claimed");
  assert.equal(delivered.head, state.head);
});

test("review after delivery uses the same completion node without replaying delivery facts", async () => {
  const { contract } = await fixture();
  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("expected an accepted delivery");
  assert.equal(delivered.value.completion, undefined);
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver"],
  );
  const review = await contract.review({ verdict: "satisfied" });
  assert.deepEqual(
    review.facts.map((fact) => fact.kind),
    ["attestation", "claimed"],
  );
  assert.ok(review.value.completion);
  assert.equal(review.head, (await contract.state()).head);
});

test("an unsatisfied review never requests trailing placement", async () => {
  const { contract } = await fixture();
  await contract.deliver();
  const review = await contract.review({ verdict: "unsatisfied", summary: "not accepted" });
  assert.deepEqual(
    review.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(review.value.completion, undefined);
  assert.equal(review.value.placement, undefined);
  assert.equal((await contract.state()).terminal, null);
});

test("automatic dependent completion retains only new facts and the primary contract head", async () => {
  const { primary, initial, dependent, childState } = await dependentFixture(false);
  const review = await primary.review({ verdict: "satisfied" });
  assert.deepEqual(review.value.continuation?.claimed, [childState.id], JSON.stringify(review.value.continuation));
  assert.deepEqual(
    review.facts.filter((fact) => fact.contract === initial.id).map((fact) => fact.kind),
    ["attestation", "claimed"],
  );
  assert.equal(
    review.facts.some((fact) => fact.kind === "deliver" || fact.kind === "bound"),
    false,
  );
  assert.equal(new Set(review.facts.map((fact) => `${fact.contract}:${fact.entry}`)).size, review.facts.length);
  assert.equal((await dependent.state()).terminal?.kind, "claimed");
  assert.equal(review.head, (await primary.state()).head);
});

test("a diverged dependent keeps its worktree and does not counterfeit completion", async () => {
  const { repository, primary, initial, dependent, childPath, childHead } = await dependentFixture(true);
  const review = await primary.review({ verdict: "satisfied" });
  assert.ok(review.value.completion);
  assert.deepEqual(review.value.continuation?.claimed, []);
  assert.ok(review.lags.some((lag) => "path" in lag && lag.path === childPath));
  assert.equal(
    review.facts.every((fact) => fact.contract === initial.id),
    true,
  );
  assert.equal((await dependent.state()).terminal, null);
  assert.equal(repository.run(["-C", childPath, "rev-parse", "HEAD"]).trim(), childHead);
  assert.equal(readFileSync(join(childPath, "dependent.txt"), "utf8"), "dependent\n");
  assert.equal(review.head, (await primary.state()).head);
});

// These tests exercise the real admission boundary, not a synthetic accepted object.
import { executeLocalReview, withContractExecution } from "../src/library/contract-execution.js";
import { requireLeadingAdmission } from "../src/library/refusal.js";
import { admitReviewOperation } from "../src/protocol/review.js";
import { executionReceipt } from "../src/library/execution-result.js";
import { acquireTargetPlacementFence } from "../src/git/target-placement.js";
import { withGitShim } from "./support/git.js";
import { EMPTY_WORKTREE_HOOKS } from "../src/git/hooks.js";
import { type ContractId } from "../src/core/facts/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("review cancellation after admission stops fenced placement and retains the real receipt", async () => {
  const repository = repositoryWithMain();
  const primary = (
    await Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: document(),
      target: "refs/heads/main",
      workspace: "worktree",
      gates: ["reviewed"],
    })
  ).keiyaku;
  const state = await primary.state();
  await primary.deliver();
  const scope = await cachedRepositoryAt(repository.path);
  const held = await acquireTargetPlacementFence(scope, "refs/heads/main");
  const committed = deferred(),
    controller = new AbortController();
  try {
    const pending = executeLocalReview({
      scope: { ...scope, onPrivateStateSeatClose: committed.resolve },
      contractId: state.id,
      verdict: "satisfied",
      signal: controller.signal,
      hooks: EMPTY_WORKTREE_HOOKS,
    });
    await committed.promise;
    controller.abort(new Error("cancel review after its receipt"));
    const reviewed = await pending;
    assert.deepEqual(
      reviewed.facts.map((fact) => fact.kind),
      ["attestation"],
    );
    assert.equal(reviewed.head, (await primary.state()).head);
    assert.equal(reviewed.value.completion, undefined);
    assert.ok(reviewed.executionStops.some((stop) => stop.stage === "placement" && stop.reason === "cancelled"));
    assert.equal((await primary.state()).terminal, null);
  } finally {
    held.close();
  }
  const reacquired = await acquireTargetPlacementFence(scope, "refs/heads/main");
  reacquired.close();
});

test("a continuation discovery failure cannot conceal the review and claim already admitted", async () => {
  const { repository, contract, state } = await fixture();
  await contract.deliver();
  const fail = join(repository.path, "fail-after-claim");
  const reviewed = await withGitShim(
    [
      'if [ -f "$FAIL_AFTER_CLAIM" ] && [ "$*" = "rev-parse --verify --quiet refs/heads/keiyaku-state" ]; then',
      '  printf "injected continuation observation failure\\n" >&2; exit 128',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { FAIL_AFTER_CLAIM: fail },
    async (gitPath) => {
      const scope = await cachedRepositoryAt(repository.path, gitPath);
      let publications = 0;
      return executeLocalReview({
        scope: {
          ...scope,
          onPrivateStateSeatClose: () => {
            publications += 1;
            if (publications === 2) writeFileSync(fail, "fail");
          },
        },
        contractId: state.id,
        verdict: "satisfied",
        hooks: EMPTY_WORKTREE_HOOKS,
      });
    },
  );
  assert.deepEqual(
    reviewed.facts.map((fact) => fact.kind),
    ["attestation", "claimed"],
  );
  assert.ok(reviewed.value.completion);
  assert.equal((await contract.state()).terminal?.kind, "claimed");
  assert.ok(reviewed.executionStops.some((stop) => stop.stage === "continuation" && /injected/u.test(stop.diagnostic)));
  assert.equal(reviewed.head, (await contract.state()).head);
});

test("fatal post-admission errors retain their identity and real journal receipts", async () => {
  const { repository, contract, state } = await fixture();
  const scope = await cachedRepositoryAt(repository.path),
    original = new TypeError("injected trailing bug");
  let caught: unknown;
  try {
    await withContractExecution(
      { scope, contractId: state.id, hooks: EMPTY_WORKTREE_HOOKS },
      "review",
      async (context) => {
        requireLeadingAdmission(await admitReviewOperation({ ...context, verdict: "unsatisfied" }));
        throw original;
      },
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, original);
  const receipt = executionReceipt(caught);
  assert.ok(receipt);
  assert.equal(receipt.operation, "review");
  assert.equal(receipt.head, (await contract.state()).head);
  assert.deepEqual(
    receipt.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.deepEqual(
    (await contract.history()).events
      .filter((event) => event.source === "journal" && event.fact.kind === "attestation")
      .map((event) => (event.source === "journal" ? event.fact.entry : null)),
    receipt.facts.map((fact) => fact.entry),
  );
});

test("diamond continuation revisits unready candidates and admits each dependent only once", async () => {
  const { repository, contract: primary, state } = await fixture();
  const repo = await Repo.at({ path: repository.path });
  const child = async (title: string, after: readonly ContractId[]) =>
    (
      await Keiyaku.bind({
        repo,
        markdown: document().replace("# Library verbs", `# ${title}`),
        workspace: "worktree",
        gates: [],
        after,
      })
    ).keiyaku;
  const left = await child("Diamond a", [state.id]),
    right = await child("Diamond b", [state.id]);
  const leftId = (await left.state()).id,
    rightId = (await right.state()).id;
  const leaf = await child("Diamond leaf", [leftId, rightId]),
    leafId = (await leaf.state()).id;
  await left.deliver();
  await right.deliver();
  await leaf.deliver();
  await primary.deliver();
  const reviewed = await primary.review({ verdict: "satisfied" });
  assert.deepEqual(reviewed.value.continuation?.claimed, [leftId, rightId, leafId]);
  assert.deepEqual(reviewed.value.continuation?.stopped, []);
  assert.equal(reviewed.facts.filter((fact) => fact.contract === leafId && fact.kind === "claimed").length, 1);
  assert.equal(reviewed.head, (await primary.state()).head);
  assert.equal((await leaf.state()).terminal?.kind, "claimed");
});

test("dependent verification leaks are accumulated with their owners instead of discarded", async () => {
  const { repository, contract: primary, state } = await fixture();
  const repo = await Repo.at({ path: repository.path });
  const children = [];
  for (const name of ["Cleanup a", "Cleanup b"]) {
    const child = (
      await Keiyaku.bind({
        repo,
        markdown: document("exit 0").replace("# Library verbs", `# ${name}`),
        gates: [],
        after: [state.id],
        workspace: "worktree",
      })
    ).keiyaku;
    await child.deliver();
    await child.amend({ markdown: "## Replace: Verification\n~~~bash\nprintf fresh\n~~~\n" });
    children.push(child);
  }
  await primary.deliver();
  const reviewed = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
      '  case "$*" in *keiyaku-v4-verify-*) printf "retained test scratch\\n" >&2; exit 17;; esac',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) =>
      Keiyaku.of({ repo: await Repo.at({ path: repository.path, gitPath }), id: state.id }).review({
        verdict: "satisfied",
      }),
  );
  const leaked = reviewed.cleanup.filter((issue) => issue.kind === "worktree-leak");
  try {
    const ids = await Promise.all(children.map(async (child) => (await child.state()).id));
    assert.equal(leaked.length, 2);
    assert.deepEqual(leaked.map((issue) => issue.contractId).sort(), ids.sort());
    assert.equal(new Set(leaked.map((issue) => issue.leak.path)).size, 2);
    assert.deepEqual(reviewed.value.continuation?.claimed.slice().sort(), ids);
    assert.ok(leaked.every((issue) => issue.snapshot !== undefined));
    assert.equal("cleanup" in reviewed.value, false);
    assert.equal("leak" in reviewed.value, false);
    assert.ok(reviewed.pending.some((pending) => pending.surface === "cleanup" && !pending.required));
  } finally {
    for (const issue of leaked) repository.run(["worktree", "remove", "--force", issue.leak.path]);
  }
});

test("audit may record verification without running the automatic placement node", async () => {
  const repository = repositoryWithMain();
  const primary = (
    await Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: document("exit 0"),
      workspace: "worktree",
      gates: [],
    })
  ).keiyaku;
  const audited = await primary.audit();
  assert.equal(audited.operation, "audit");
  assert.equal(audited.facts.filter((fact) => fact.kind === "attestation").length, 1);
  assert.equal(
    audited.facts.some((fact) => fact.kind === "claimed"),
    false,
  );
  assert.equal((await primary.state()).terminal, null);
});

import { waitForFile } from "./support/git.js";

test("cancellation during an unknown Git publication recovers its receipt with independent read custody", async () => {
  const { repository, contract, state } = await fixture();
  const marker = join(repository.path, "publication-confirmed"),
    controller = new AbortController();
  const result = await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      '  input_file=$(mktemp); cat > "$input_file"',
      '  "$KEIYAKU_REAL_GIT" "$@" < "$input_file" || exit "$?"',
      '  rm -f "$input_file"; touch "$CONFIRMED_MARKER"',
      "  while :; do sleep 1; done",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { CONFIRMED_MARKER: marker },
    async (gitPath) => {
      const pending = executeLocalReview({
        scope: await cachedRepositoryAt(repository.path, gitPath),
        contractId: state.id,
        verdict: "satisfied",
        signal: controller.signal,
        hooks: EMPTY_WORKTREE_HOOKS,
      });
      try {
        await waitForFile(marker);
      } finally {
        controller.abort(new Error("cancel after physical publication"));
      }
      return await pending;
    },
  );
  assert.equal(result.operation, "review");
  assert.deepEqual(
    result.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(result.head, (await contract.state()).head);
  assert.equal((await contract.state()).attestations.length, 1);
  assert.equal((await contract.state()).terminal, null);
  assert.ok(result.executionStops.some((stop) => stop.reason === "cancelled"));
});

test("reintegrated candidates retain every scratch leak instead of replacing the earlier one", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "release"]);
  const primary = (
    await Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: document("exit 0"),
      target: "refs/heads/release",
      workspace: "worktree",
      gates: ["verified"],
    })
  ).keiyaku;
  const id = (await primary.state()).id,
    path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), id);
  commitCandidate(repository, path);
  writeFileSync(join(repository.path, "external.txt"), "moved\n");
  repository.run(["add", "external.txt"]);
  repository.run(["commit", "--quiet", "-m", "external target move"]);
  const raced = join(repository.path, "raced");
  const delivered = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
      '  case "$*" in *keiyaku-v4-verify-*) printf "retained test scratch\\n" >&2; exit 17;; esac',
      "fi",
      'if [ "$1" = "update-ref" ]; then',
      '  input_file=$(mktemp); cat > "$input_file"',
      '  if grep -q "update refs/heads/release" "$input_file" && [ ! -f "$RACED" ]; then',
      '    "$KEIYAKU_REAL_GIT" update-ref refs/heads/release "$EXTERNAL_HEAD"; touch "$RACED"',
      "  fi",
      '  "$KEIYAKU_REAL_GIT" "$@" < "$input_file"; result=$?; rm -f "$input_file"; exit "$result"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { RACED: raced, EXTERNAL_HEAD: repository.run(["rev-parse", "HEAD"]).trim() },
    async (gitPath) => Keiyaku.of({ repo: await Repo.at({ path: repository.path, gitPath }), id }).deliver(),
  );
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("expected delivery");
  const leaked = delivered.cleanup.filter((issue) => issue.kind === "worktree-leak");
  try {
    assert.equal(leaked.length, 2);
    assert.equal(new Set(leaked.map((issue) => issue.snapshot)).size, 2);
    assert.ok(leaked.every((issue) => issue.contractId === id));
    assert.equal(delivered.facts.filter((fact) => fact.kind === "attestation").length, 2);
    assert.equal(delivered.facts.filter((fact) => fact.kind === "reintegrated").length, 1);
    assert.equal(delivered.value.completion?.verification?.verdict, "satisfied");
    assert.equal(delivered.value.completion?.integration, repository.run(["rev-parse", "refs/heads/release"]).trim());
  } finally {
    for (const issue of leaked) repository.run(["worktree", "remove", "--force", issue.leak.path]);
  }
});
