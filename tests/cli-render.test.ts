import assert from "node:assert/strict";
import test from "node:test";
import { contractId } from "../src/core/facts/types.js";
import type { InvocationResult } from "../src/cli/result.js";
import { renderText } from "../src/cli/render/text.js";
import { renderCatalogText } from "../src/cli/render/catalog.js";

const head = "0123456789abcdef0123456789abcdef01234567";
const entry = "01J00000000000000000000000";
const wide = { columns: 200, color: false } as const;
const narrow = { columns: 36, color: false } as const;

function assertJsonIdentity(result: InvocationResult): void {
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
}

function reconstructOpaque(text: string): string {
  const lines = text.split("\n");
  const rebuilt: string[] = [];
  for (const line of lines) {
    if (/^\s{4,}/u.test(line) && rebuilt.length > 0) rebuilt[rebuilt.length - 1] += line.trimStart();
    else rebuilt.push(line);
  }
  return rebuilt.join("\n");
}

function assertBefore(text: string, earlier: string, later: string): void {
  const left = text.indexOf(earlier);
  const right = text.indexOf(later);
  assert.notEqual(left, -1, `missing ${JSON.stringify(earlier)}\n${text}`);
  assert.notEqual(right, -1, `missing ${JSON.stringify(later)}\n${text}`);
  assert.equal(left < right, true, `${JSON.stringify(earlier)} should precede ${JSON.stringify(later)}\n${text}`);
}

test("guidance text is the exact Markdown projection", () => {
  const guidance = "---\ncontract: kei/show\n---\n\n# Show\n";
  assert.equal(renderText({ kind: "guidance", contract: contractId("kei/show"), guidance }), guidance);
});

test("accepted mutation receipts start with outcome, verb, and the complete Contract coordinate", () => {
  for (const verb of ["bind", "amend", "deliver", "review", "abandon"] as const) {
    const contract = contractId(`kei/render-${verb}`);
    const result: InvocationResult = {
      kind: "accepted",
      verb,
      contract,
      head,
      facts: [{ contract, entry, kind: verb === "review" ? "attestation" : verb }],
      effects: [],
      settlement: { actions: [], lags: [] },
    };
    const text = renderText(result);
    assert.equal(text.split("\n")[0], `✓ ${verb} accepted — ${contract}`);
    assert.match(text, new RegExp(`head ${head}`));
    assert.match(text, new RegExp(`journal ${entry}`));
    assertJsonIdentity(result);
  }
});

test("accepted text keeps facts before effects and changed effects before unchanged", () => {
  const contract = contractId("kei/render-effect");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract,
    head,
    facts: [{ contract, entry, kind: "deliver" }],
    effects: [{
      kind: "ref",
      name: "refs/heads/main",
      action: "unchanged",
      before: null,
      after: null,
    }, {
      kind: "ref",
      name: "refs/heads/main",
      action: "updated",
      before: "1111111111111111111111111111111111111111",
      after: "2222222222222222222222222222222222222222",
    }],
    settlement: { actions: [], lags: [] },
  };
  const text = renderText(result, wide);
  assertBefore(text, `journal ${entry} · deliver`, "✓ ref updated");
  assertBefore(text, "✓ ref updated", "· ref unchanged");
  assertJsonIdentity(result);
});

test("accepted text exposes target checkout alignment and retention", () => {
  const contract = contractId("kei/render-target-checkout");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract,
    head,
    facts: [],
    effects: [{
      kind: "target-checkout",
      path: "/repo",
      target: "refs/heads/main",
      action: "followed",
    }],
    lag: [{
      kind: "target-checkout-retained",
      path: "/repo/peer",
      target: "refs/heads/main",
      diagnostic: "local bytes overlap",
    }],
    settlement: { actions: [], lags: [] },
  };
  const text = renderText(result, wide);
  assertBefore(text, "! lag target-checkout-retained", "✓ target-checkout followed");
  assert.match(text, /✓ target-checkout followed refs\/heads\/main \/repo/);
  assert.match(text, /target-checkout-retained refs\/heads\/main \/repo\/peer/);
  assert.match(text, /diagnostic\n\nlocal bytes overlap/u);
});

test("typed refusal and retry keep structured facts without one-line JSON", () => {
  const contract = contractId("kei/render-refusal");
  const refused: InvocationResult = {
    kind: "refused",
    verb: "deliver",
    contract,
    refusal: { kind: "integration-failed", reason: "not-based-on-target", targetHead: "target-head", contractId: contract },
  };
  const refusedText = renderText(refused, wide);
  assert.equal(refusedText.split("\n")[0], `! deliver refused — ${contract}`);
  assert.match(refusedText, /integration-failed/);
  assert.match(refusedText, /reason=not-based-on-target/);
  assert.match(refusedText, /targetHead=target-head/);
  assert.equal(refusedText.split(contract).length - 1, 1);
  assert.equal(refusedText.includes("contractId="), false);
  assert.equal(refusedText.includes("{"), false);
  assertJsonIdentity(refused);

  const bindRetry: InvocationResult = { kind: "retry", verb: "bind", detail: { kind: "exhausted" } };
  assert.equal(renderText(bindRetry), ["? bind retry", "   exhausted"].join("\n"));
  assert.equal("contract" in bindRetry, false);

  const amendRetry: InvocationResult = {
    kind: "retry",
    verb: "amend",
    contract: contractId("kei/render-retry"),
    detail: { kind: "publication-failed", diagnostic: "lock held" },
  };
  const retryText = renderText(amendRetry, wide);
  assert.equal(retryText.split("\n")[0], `? amend retry — ${amendRetry.contract}`);
  assert.match(retryText, /kei\/render-retry/);
  assert.match(retryText, /publication-failed/u);
  assert.match(retryText, /diagnostic\n\nlock held/u);
  assert.equal(retryText.includes("{"), false);
});

test("dirty refusal and review workspace keep every classified path", () => {
  const contract = contractId("kei/render-dirty");
  const refused: InvocationResult = {
    kind: "refused",
    verb: "deliver",
    contract,
    refusal: {
      kind: "dirty-workspace",
      contractId: contract,
      staged: ["both.txt"],
      unstaged: ["both.txt"],
      untracked: ["new.txt"],
      submodules: [],
      shortStat: { filesChanged: 2, insertions: 3, deletions: 1 },
      option: { flag: "--include-dirty", available: true },
    },
  };
  const refusedText = renderText(refused, wide);
  assert.equal(refusedText.split("\n")[0], `! deliver refused — ${contract}`);
  assert.match(refusedText, /dirty-workspace/);
  assert.equal(refusedText.split("both.txt").length - 1, 2);
  assert.equal(refusedText.includes("new.txt"), true);
  assert.match(refusedText, /submodules 0/);
  assert.match(refusedText, /2 files changed, 3 insertions\(\+\), 1 deletion\(-\)/);
  assert.doesNotMatch(refusedText, /files=|insertions=|deletions=/);
  assert.doesNotMatch(refusedText, /\b[MADCU ]{1,2}\b both\.txt/);
  assert.match(refusedText, /option --include-dirty available/);
  assertJsonIdentity(refused);

  const review: InvocationResult = {
    kind: "accepted",
    verb: "review",
    contract: contractId("kei/render-dirty-review"),
    head,
    facts: [{ contract: contractId("kei/render-dirty-review"), entry, kind: "attestation" }],
    effects: [],
    settlement: { actions: [], lags: [] },
    workspace: {
      staged: ["both.txt", "tracked.txt"],
      unstaged: ["both.txt"],
      untracked: ["new.txt"],
      shortStat: { filesChanged: 2, insertions: 3, deletions: 1 },
    },
  };
  const reviewText = renderText(review, wide);
  assert.equal(reviewText.split("\n")[0], `✓ review accepted — ${review.contract}`);
  assertBefore(reviewText, `✓ review accepted — ${review.contract}`, "~ workspace 2 files changed, 3 insertions(+), 1 deletion(-)");
  assertBefore(reviewText, "~ workspace 2 files changed, 3 insertions(+), 1 deletion(-)", "  staged both.txt");
  assertBefore(reviewText, "  staged both.txt", "  staged tracked.txt");
  assertBefore(reviewText, "  staged tracked.txt", "  unstaged both.txt");
  assertBefore(reviewText, "  unstaged both.txt", "  untracked new.txt");
  assertBefore(reviewText, "  untracked new.txt", `journal ${entry}`);
  assert.equal(reviewText.split("both.txt").length - 1, 2);
  assert.doesNotMatch(reviewText, /unstaged=0|staged=0|untracked=0|files=|insertions=|deletions=/);
  assert.equal(reviewText.includes("--include-dirty"), false);
  assert.doesNotMatch(reviewText, /! gate /);
  assertJsonIdentity(review);

  const singular: InvocationResult = {
    kind: "accepted",
    verb: "review",
    contract: contractId("kei/render-singular-workspace"),
    head,
    facts: [{ contract: contractId("kei/render-singular-workspace"), entry, kind: "attestation" }],
    effects: [],
    settlement: { actions: [], lags: [] },
    workspace: {
      staged: ["one.txt"],
      unstaged: [],
      untracked: [],
      shortStat: { filesChanged: 1, insertions: 1, deletions: 1 },
    },
  };
  const singularText = renderText(singular, wide);
  assert.match(singularText, /~ workspace 1 file changed, 1 insertion\(\+\), 1 deletion\(-\)/);
  assert.match(singularText, /  staged one\.txt/);
  assert.doesNotMatch(singularText, /unstaged|untracked=0|files=/);

  const clean: InvocationResult = {
    kind: "accepted",
    verb: "review",
    contract: contractId("kei/render-clean-review"),
    head,
    facts: [{ contract: contractId("kei/render-clean-review"), entry, kind: "attestation" }],
    effects: [],
    settlement: { actions: [], lags: [] },
  };
  assert.doesNotMatch(renderText(clean, wide), /~ workspace/);
});

test("catalog text renders only the selected identity layer", () => {
  assert.equal(renderCatalogText({
    kind: "archetypes",
    rows: [{ name: "reviewer", model: "codex-5", description: "Read the complete change without truncation." }],
  }), [
    "reviewer - codex-5",
    "  Read the complete change without truncation.",
  ].join("\n"));
  assert.equal(renderCatalogText({
    kind: "akuma",
    root: "/world",
    archetype: "worker",
    rows: [{ id: "aku/worker/deadbeef" as never, life: "unborn" }],
    searched: ["/world/.keiyaku/akuma/run"],
  }), "aku/worker/deadbeef - unborn");
});

test("accepted text keeps named stops under an accepted header", () => {
  const contract = contractId("kei/render-steps");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract,
    head: null,
    facts: [{ contract, entry, kind: "deliver" }],
    verificationReuse: { entry: "01J00000000000000000000001" as never, verdict: "satisfied" },
    verification: { refusal: { kind: "terminal", contractId: contract } },
    placement: { retry: { kind: "exhausted" } },
    leak: { path: "/tmp/keiyaku-v4-verify-leak", diagnostic: "worktree remove failed" },
    effects: [{ kind: "ref", name: "refs/heads/main", action: "unchanged", before: null, after: null }],
    settlement: { actions: [], lags: [] },
  };
  const text = renderText(result, wide);
  assert.equal(text.split("\n")[0], `✓ deliver accepted — ${contract}`);
  assertBefore(text, "! verification terminal", "! claim exhausted");
  assertBefore(text, "! claim exhausted", "! leak");
  assertBefore(text, "! leak", `journal ${entry} · deliver`);
  assertBefore(text, `journal ${entry} · deliver`, "reuse verification");
  assertBefore(text, "reuse verification 01J00000000000000000000001 satisfied", "· ref unchanged");
  assert.doesNotMatch(text, /! gate /);
  assert.doesNotMatch(text, /refusal=|retry=|failure=/);
  assert.match(text, /terminal/);
  assert.equal(text.split(contract).length - 1, 1);
  assert.equal(text.includes("contractId="), false);
  assert.match(text, /exhausted/);
  assert.match(text, /! leak worktree \/tmp\/keiyaku-v4-verify-leak/u);
  assert.match(text, /diagnostic\n\nworktree remove failed/u);
  assert.equal(text.includes("{"), false);
  assertJsonIdentity(result);

  const claimStops: InvocationResult = {
    kind: "accepted",
    verb: "review",
    contract,
    head: null,
    facts: [{ contract, entry, kind: "attestation" }],
    placement: { refusal: { kind: "delivery-missing", contractId: contract } },
    effects: [],
    settlement: { actions: [], lags: [] },
  };
  const claimText = renderText(claimStops, wide);
  assert.match(claimText, /! claim delivery-missing/);
  assert.doesNotMatch(claimText, /! gate |refusal=/);
  assert.equal("placement" in claimStops, true);

  const moved: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract,
    head: null,
    facts: [],
    placement: {
      failure: "target-moved",
      contractId: contract,
      target: "refs/heads/main",
      expected: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      observed: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    effects: [],
    settlement: { actions: [], lags: [] },
  };
  const movedText = renderText(moved, wide);
  assert.match(movedText, /! claim target-moved/);
  assert.match(movedText, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -> bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.doesNotMatch(movedText, /failure=|expected=|observed=/);
});

test("accepted audit deviations and diagnostics keep their slots and bytes", () => {
  const contract = contractId("kei/render-audit-payloads");
  const cleanup = {
    phase: "destroy",
    command: 2,
    detail: { kind: "spawn-error", diagnostic: "cleanup first\ncleanup second" },
  } as const;
  const result: InvocationResult = {
    kind: "accepted",
    verb: "audit",
    contract,
    head,
    facts: [{ contract, entry, kind: "attestation" }],
    placement: { failure: "target-placement-failed", diagnostic: "stop first\nstop second" },
    cleanup,
    leak: { path: "/tmp/leaked", diagnostic: "leak first\nleak second" },
    report: {
      reworks: 0,
      reviews: 0,
      timeline: [],
      targetObservation: { head, drift: true },
      cleanup,
      leak: { path: "/tmp/leaked", diagnostic: "leak first\nleak second" },
    },
    effects: [],
    settlement: { actions: [], lags: [] },
  };
  const text = renderText(result, wide);
  assertBefore(text, "! claim target-placement-failed", "! cleanup");
  assertBefore(text, "! cleanup", "~ target");
  assertBefore(text, "~ target", "head");
  assert.doesNotMatch(text, /! gate |failure=/);
  assert.equal(text.split("report cleanup").length, 1);
  assert.equal(text.split("report leak").length, 1);
  for (const payload of ["stop first\nstop second", "cleanup first\ncleanup second", "leak first\nleak second"]) {
    assert.equal(text.includes(`diagnostic\n\n${payload}\n`), true, payload);
  }
  assertJsonIdentity(result);
});

test("repeated overlap grouping stays lossless and wraps without dropping coordinates", () => {
  const contract = contractId("kei/preserve-failed-bind-inputs-and-normalize-region");
  const shared = [
    { mine: "src/body/region.ts", theirs: "src/**" },
    { mine: "src/cli/draft.ts", theirs: "src/**" },
    { mine: "src/cli/invoke.ts", theirs: "src/**" },
    { mine: "src/cli/main.ts", theirs: "src/**" },
    { mine: "src/cli/result.ts", theirs: "src/**" },
    { mine: "src/cli/render/refusal.ts", theirs: "src/**" },
  ] as const;
  const unique = [
    { mine: "docs/cli.md", theirs: "docs/cli.md" },
    { mine: "src/cli/invoke.ts", theirs: "src/cli/invoke.ts" },
    { mine: "tests/cli-invoke.test.ts", theirs: "tests/cli-invoke.test.ts" },
  ] as const;
  const peers = [
    "kei/first-status-row",
    "kei/second-status-row",
    "kei/blocked-reconcile",
    "kei/healthy-reconcile",
  ] as const;
  const uniqueId = "kei/enforce-exact-and-nonblank-cli-input-sources";
  const diff = "===================================================================\n--- before\n+++ after\n@@ -1 +1,2 @@\n docs/cli.md\n+scripts/architecture/policy.ts\n";
  const worktree = "/repo/.git/keiyaku/wt/kei-preserve-failed-bind-inputs-and-normalize-region";
  const result: InvocationResult = {
    kind: "accepted",
    verb: "amend",
    contract,
    head: "dc01450ebf6c758c95d834c33def7837aae6ad04",
    facts: [{ contract, entry: "01M02EKRKQ6A2DDDNF4BGVJ753", kind: "amend" }],
    effects: [
      { kind: "contract-file", path: "/repo/.keiyaku/KEIYAKU.md", action: "updated" },
      { kind: "ref", name: "refs/heads/keiyaku-delivery/kei-preserve-failed-bind-inputs-and-normalize-region", action: "unchanged", before: head, after: head },
      { kind: "worktree", path: worktree, action: "unchanged" },
    ],
    settlement: { actions: [{ kind: "namespace-context", path: worktree, action: "kept" }], lags: [] },
    overlaps: [
      ...peers.map((id) => ({ contract: contractId(id), patterns: [...shared] })),
      { contract: contractId(uniqueId), patterns: [...unique] },
    ],
    diff,
  };

  const text = renderText(result, wide);
  assert.equal(text.split("\n")[0], `✓ amend accepted — ${contract}`);
  assertBefore(text, "~ overlap", "diff");
  assertBefore(text, "diff", "✓ contract-file updated");
  assertBefore(text, "✓ contract-file updated", "· ref unchanged");
  assertBefore(text, "· worktree unchanged", "· settle namespace-context");
  for (const id of peers) assert.equal(text.includes(id), true, `missing ${id}`);
  for (const pattern of shared) {
    assert.equal(text.includes(`${pattern.mine} ~ ${pattern.theirs}`), true, `missing ${pattern.mine}`);
  }
  assert.equal(text.includes(uniqueId), true);
  for (const pattern of unique) {
    assert.equal(text.includes(`${pattern.mine} ~ ${pattern.theirs}`), true, `missing ${pattern.mine}`);
  }
  assert.equal(text.includes(diff), true);
  assert.equal(text.includes("namespace-context kept"), true);
  assertJsonIdentity(result);

  const wrapped = renderText(result, narrow);
  assert.equal(wrapped.split("\n")[0], "✓ amend accepted —");
  const reconstructed = reconstructOpaque(wrapped);
  for (const token of [contract, uniqueId, ...peers, ...shared.map((pattern) => pattern.mine)]) {
    assert.equal(reconstructed.includes(token), true, `wrapped away ${token}\n${wrapped}`);
  }
});

test("unavailable Region observation stays accepted", () => {
  const contract = contractId("kei/render-region");
  const unavailable: InvocationResult = {
    kind: "accepted",
    verb: "amend",
    contract,
    head: null,
    facts: [],
    effects: [],
    settlement: { actions: [], lags: [] },
    overlapFailure: "kei/peer: malformed document",
  };
  const text = renderText(unavailable);
  assert.equal(text.split("\n")[0], `✓ amend accepted — ${contract}`);
  assert.match(text, /~ overlap unavailable/);
  assert.match(text, /kei\/peer: malformed document/);
  assertJsonIdentity(unavailable);
});

test("document diff text is labeled and byte-faithful", () => {
  const diff = "===================================================================\n--- before\n+++ after\n@@ -1 +1 @@\n-old\n+new\n";
  const result: InvocationResult = {
    kind: "accepted",
    verb: "amend",
    contract: contractId("kei/render-diff"),
    head: null,
    facts: [],
    effects: [],
    settlement: { actions: [], lags: [] },
    diff,
  };
  const text = renderText(result);
  assert.equal(text.includes(`diff\n\n${diff}\n`), true);
});

test("opaque coordinates keep consecutive spaces and hang their continuation", () => {
  const contract = contractId("kei/render-opaque-path");
  const spaced = "/repo/a  spaced file.txt";
  const result: InvocationResult = {
    kind: "accepted",
    verb: "amend",
    contract,
    head: null,
    facts: [],
    effects: [{ kind: "contract-file", path: spaced, action: "updated" }],
    settlement: { actions: [], lags: [] },
  };
  const wideText = renderText(result, wide);
  assert.equal(wideText.includes(spaced), true);
  assert.equal(wideText.includes("/repo/a spaced"), false);

  const wrapped = renderText(result, narrow).split("\n");
  const owner = wrapped.findIndex((line) => line.includes("✓ contract-file updated"));
  assert.notEqual(owner, -1);
  assert.equal(wrapped[owner]!.startsWith("✓"), true);
  assert.equal(wrapped[owner + 1]!.startsWith("  "), true);
  const reconstructed = [wrapped[owner]!.slice(2), ...wrapped.slice(owner + 1).map((line) => line.slice(2))].join("");
  assert.equal(reconstructed.includes(spaced), true);
  assertJsonIdentity(result);
});

test("addressed Contract ID appears once on a refusal receipt", () => {
  const contract = contractId("kei/render-once");
  const refused: InvocationResult = {
    kind: "refused",
    verb: "deliver",
    contract,
    refusal: {
      kind: "dirty-workspace",
      contractId: contract,
      staged: [],
      unstaged: ["dirty.txt"],
      untracked: [],
      submodules: [],
      shortStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      option: { flag: "--include-dirty", available: true },
    },
  };
  const text = renderText(refused, wide);
  assert.equal(text.split("\n")[0], `! deliver refused — ${contract}`);
  assert.equal(text.split(contract).length - 1, 1);
  assert.equal(text.includes("contractId="), false);
  assert.match(text, /1 file changed, 1 insertion\(\+\)/);
  assert.doesNotMatch(text, /files=|insertions=|deletions=/);
  assertJsonIdentity(refused);
});

test("audit text emits a requested diff body once and omits it without the presentation field", () => {
  const contract = contractId("kei/render-audit-diff");
  const candidate = {
    tenderSnapshot: "tender" as never,
    integration: {
      predecessor: "predecessor" as never,
      snapshot: "snapshot" as never,
      changeId: "change" as never,
    },
    method: "squash" as const,
    policy: { requireBranchesToBeUpToDate: false },
  };
  const body = "diff --git a/candidate.txt b/candidate.txt\n+unique-audit-diff-marker\n";
  const shown: InvocationResult = {
    kind: "accepted",
    verb: "audit",
    contract,
    head: null,
    facts: [],
    effects: [],
    settlement: { actions: [], lags: [] },
    report: {
      reworks: 0,
      reviews: 0,
      timeline: [],
      preview: { kind: "ready", candidate, diff: body },
    },
  };
  const shownText = renderText(shown, wide);
  assert.equal("diff" in shown, false);
  assert.equal(shownText.split("\n")[0], `✓ audit accepted — ${contract}`);
  assert.match(shownText, /preview ready tender snapshot change/);
  assert.equal(shownText.split("unique-audit-diff-marker").length - 1, 1);
  assert.match(shownText, /^\+unique-audit-diff-marker$/m);
  assert.equal(shown.report?.preview?.kind === "ready" ? shown.report.preview.diff : undefined, body);
  assert.doesNotMatch(shownText, /"diff":"diff --git/);

  const unavailable: InvocationResult = {
    kind: "accepted",
    verb: "audit",
    contract,
    head: null,
    facts: [],
    effects: [],
    settlement: { actions: [], lags: [] },
    report: {
      reworks: 0,
      reviews: 0,
      timeline: [],
      preview: { kind: "ready", candidate, diff: null },
    },
  };
  const unavailableText = renderText(unavailable, wide);
  assert.equal("diff" in unavailable, false);
  assert.equal(unavailable.report?.preview?.kind === "ready" ? unavailable.report.preview.diff : undefined, null);
  assert.match(unavailableText, /git-unavailable integrationSnapshot=snapshot changeId=change/);
  assert.doesNotMatch(unavailableText, /"diff":null/);

  const hidden: InvocationResult = {
    kind: "accepted",
    verb: "audit",
    contract,
    head: null,
    facts: [],
    effects: [],
    settlement: { actions: [], lags: [] },
    report: {
      reworks: 0,
      reviews: 0,
      timeline: [],
      preview: { kind: "ready", candidate },
    },
  };
  const hiddenText = renderText(hidden, wide);
  assert.match(hiddenText, /preview ready tender snapshot change/);
  assert.equal(hiddenText.includes("unique-audit-diff-marker"), false);
  assert.equal(hiddenText.includes("diff --git"), false);
});

test("observation text keeps the command and view data together", () => {
  const result: InvocationResult = { kind: "observation", command: "status", contracts: [] };
  assert.equal(renderText(result), 'observation status\n{\n  "contracts": []\n}');
});
