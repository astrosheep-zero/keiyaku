import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CARRIER_REF, readRef, repositoryAt } from "../src/carrier/repository.js";
import { Delivery, Keiyaku, type ContractId } from "../src/index.js";
import { observeContract } from "../src/carrier/observe.js";
import { candidatePinRefFor, deliveryRefFor, deliveryWorktreePath, reconcile } from "../src/carrier/reconcile.js";
import { invoke } from "../src/cli/invoke.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { makeGitRepository } from "./support/git.js";

function repositoryWithMain() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function contractDocument(title: string, extra = ""): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Current facts.",
    "",
    "## Objective",
    "Ship the edge.",
    "",
    "## Design",
    "Decode once.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Uses one document",
    "The typed body reaches the journal.",
    "",
    extra,
  ].join("\n");
}

async function invokeWithDocument(repositoryPath: string, argv: readonly string[], source: string) {
  return invoke(parseArgv(argv), {
    cwd: repositoryPath,
    environment: {},
    readStdin: () => source,
  });
}

function acceptedContract(result: Awaited<ReturnType<typeof invoke>>): ContractId {
  if (result.kind !== "accepted") throw new Error(`expected accepted result, got ${result.kind}`);
  return result.contract;
}

test("journal-writing commands preserve optional actor testimony", async () => {
  const repository = repositoryWithMain();
  const command = (argv: readonly string[], environment: NodeJS.ProcessEnv) => invoke(parseArgv(argv), {
    cwd: repository.path,
    environment,
    readStdin: () => contractDocument("Optional Actor"),
  });

  const unsigned = await command(["bind", "-"], {});
  const unsignedEntries = observeContract(repositoryAt(repository.path), acceptedContract(unsigned)).entries;
  assert.equal(unsignedEntries.length, 2);
  assert.equal(unsignedEntries.every((entry) => !("actor" in entry)), true);

  const environmentActor = "projection/codex";
  const fromEnvironment = await command(["bind", "-"], {
    KEIYAKU_PROJECTION_ID: environmentActor,
  });
  assert.equal(observeContract(repositoryAt(repository.path), acceptedContract(fromEnvironment)).entries[0]?.actor, environmentActor);

  const explicitActor = " external \u{1f9d1}\u{1f3fd}\u200d\u{1f4bb} ";
  const explicit = await command(["bind", "--actor", explicitActor, "-"], {
    KEIYAKU_PROJECTION_ID: "different projection",
  });
  const persisted = observeContract(repositoryAt(repository.path), acceptedContract(explicit)).entries[0]?.actor;
  assert.equal(persisted, explicitActor);
  assert.deepEqual(Buffer.from(persisted ?? "", "utf8"), Buffer.from(explicitActor, "utf8"));

  const beforeBlank = readRef(repositoryAt(repository.path), CARRIER_REF);
  await assert.rejects(
    () => command(["bind", "--actor", " \t", "-"], { KEIYAKU_PROJECTION_ID: "aku/environment" }),
    (error: unknown) => error instanceof CliUsageError && /actor must be a nonblank string/.test(error.message),
  );
  assert.equal(readRef(repositoryAt(repository.path), CARRIER_REF), beforeBlank);
});

test("bind decodes Markdown and records a targetless current snapshot", async () => {
  const repository = repositoryWithMain();
  const start = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const source = contractDocument("Markdown Bind", "## Rollout Notes\nfirst\n\n- second\n");

  const result = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    source,
  );

  const state = observeContract(repositoryAt(repository.path), acceptedContract(result)).state;
  assert.deepEqual(state?.coordinates, {
    start,
    workspace: "worktree",
  });
  assert.equal(state?.body?.title, "Markdown Bind");
  assert.deepEqual(state?.body?.extensions, [{ title: "Rollout Notes", content: "first\n\n- second\n" }]);
});

test("bind observes an explicit target rather than the checked-out branch", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "release"]);
  const start = repository.run(["rev-parse", "refs/heads/release"]).trim();

  const result = await invokeWithDocument(
    repository.path,
    ["bind", "--target", "refs/heads/release", "--actor", "external-test", "-"],
    contractDocument("Explicit Target"),
  );

  assert.deepEqual(
    observeContract(repositoryAt(repository.path), acceptedContract(result)).state?.coordinates,
    { start, target: "refs/heads/release", workspace: "worktree" },
  );
});

test("targetless bind accepts detached HEAD without a reward operation", async () => {
  const repository = repositoryWithMain();
  repository.run(["checkout", "--quiet", "--detach"]);

  const result = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Detached"),
  );
  const coordinates = observeContract(repositoryAt(repository.path), acceptedContract(result)).state?.coordinates;
  assert.equal(coordinates?.target, undefined);
});

test("amend applies H2 operations into a complete Markdown replacement", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Original"),
  );
  const id = acceptedContract(bound);

  const amended = await invokeWithDocument(
    repository.path,
    ["amend", id, "--actor", "external-test", "-"],
    [
      "## Replace: Context",
      "Replacement context.",
      "",
      "## Add: Decision Log",
      "kept exactly",
      "",
    ].join("\n"),
  );
  assert.equal(amended.kind, "accepted");
  const body = observeContract(repositoryAt(repository.path), id).state?.body;
  assert.equal(body?.title, "Original");
  assert.equal(body?.context, "Replacement context.\n\n");
  assert.deepEqual(body?.extensions, [{ title: "Decision Log", content: "kept exactly\n" }]);
  assert.match(amended.diff ?? "", /-Current facts\./);
  assert.match(amended.diff ?? "", /\+Replacement context\./);

  const retried = await invokeWithDocument(
    repository.path,
    ["amend", id, "--actor", "external-test", "-"],
    "## Replace: Context\nSecond context.\n",
  );
  assert.equal(retried.kind, "accepted");
  assert.doesNotMatch(retried.diff ?? "", /-Current facts\./);
  assert.match(retried.diff ?? "", /-Replacement context\./);
  assert.match(retried.diff ?? "", /\+Second context\./);

    await assert.rejects(
    () => invokeWithDocument(
      repository.path,
      ["amend", id, "--actor", "external-test", "-"],
      '{"title":"legacy JSON"}',
    ),
    /amend operations contain bytes outside H2 sections/,
  );
});

test("amend refuses changed prerequisites after bound without appending", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Consumed prerequisites"),
  );
  const id = acceptedContract(bound);
  const before = readRef(repositoryAt(repository.path), CARRIER_REF);

  const amended = await invokeWithDocument(
    repository.path,
    ["amend", id, "--after", "kei/unclaimed", "--actor", "external-test", "-"],
    "## Append: Context\nMust refuse.\n",
  );

  assert.deepEqual(amended, {
    kind: "refused",
    verb: "amend",
    contract: id,
    refusal: { kind: "prerequisites-already-consumed", contractId: id },
  });
  assert.equal(readRef(repositoryAt(repository.path), CARRIER_REF), before);

  const selfDependent = await invokeWithDocument(
    repository.path,
    ["amend", id, "--after", id, "--actor", "external-test", "-"],
    "## Append: Context\nMust also refuse.\n",
  );
  assert.deepEqual(selfDependent, {
    kind: "refused",
    verb: "amend",
    contract: id,
    refusal: { kind: "invalid-after", contractId: id },
  });
  assert.equal(readRef(repositoryAt(repository.path), CARRIER_REF), before);
});

test("concurrent amend diff uses the accepted predecessor after a competing amend", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Concurrent original"),
  );
  const id = acceptedContract(bound);
  const contract = Keiyaku.of({ id, repo: repository.path });
  const amend = Keiyaku.prototype.amend;
  let injected = false;

  Keiyaku.prototype.amend = async function(input) {
    if (!injected) {
      injected = true;
      const intervening = await amend.call(this, {
        ...input,
        markdown: "## Replace: Context\nIntervening context.\n",
      });
      assert.equal(intervening.kind, "accepted");
    }
    return amend.call(this, input);
  };
  try {
    const later = await invokeWithDocument(
      repository.path,
      ["amend", id, "--actor", "external-test", "-"],
      "## Replace: Context\nLater context.\n",
    );
    assert.equal(later.kind, "accepted");
    assert.match(later.diff ?? "", /-Intervening context\./);
    assert.match(later.diff ?? "", /\+Later context\./);
    assert.doesNotMatch(later.diff ?? "", /-Current facts\./);
  } finally {
    Keiyaku.prototype.amend = amend;
  }
});

test("bind freezes selected gates and augments them for Verification", async () => {
  const repository = repositoryWithMain();
  mkdirSync(resolve(repository.path, ".keiyaku"), { recursive: true });
  writeFileSync(resolve(repository.path, ".keiyaku", "settings.json"), JSON.stringify({
    gates: { default: ["reviewed"], strict: ["reviewed", "verified"] },
  }));

  const result = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    `${contractDocument("Gate Freeze")}## Verification\n\`\`\`bash\ntrue\n\`\`\`\n`,
  );

  assert.deepEqual(
    observeContract(repositoryAt(repository.path), acceptedContract(result)).state?.body?.gates,
    ["reviewed", "verified"],
  );
});

test("audit --show-diff-body retains its Delivery across a terminal transition", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--here", "--actor", "external-test", "-"],
    contractDocument("Audit terminal diff"),
  );
  const id = acceptedContract(bound);
  writeFileSync(resolve(repository.path, "candidate.txt"), "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);
  const delivered = await invokeWithDocument(repository.path, ["deliver", id, "--actor", "external-test"], "");
  assert.equal(delivered.kind, "accepted");

  const contract = Keiyaku.of({ id, repo: repository.path });
  const pinned = await contract.delivery();
  if (pinned === null) throw new Error("delivery was not available before audit");
  const delivery = Keiyaku.prototype.delivery;
  const audit = Keiyaku.prototype.audit;
  let deliveryReads = 0;

  Keiyaku.prototype.delivery = async function() {
    deliveryReads += 1;
    return delivery.call(this);
  };
  Keiyaku.prototype.audit = async function(options) {
    const reviewed = await pinned.review({ verdict: "satisfied", ...options });
    assert.equal(reviewed.kind, "accepted");
    return audit.call(this, options);
  };
  try {
    const result = await invokeWithDocument(
      repository.path,
      ["audit", id, "--show-diff-body", "--actor", "external-test"],
      "",
    );
    assert.equal(result.kind, "observation");
    assert.match(result.diff ?? "", /\+candidate/);
    assert.equal(deliveryReads, 1);
  } finally {
    Keiyaku.prototype.delivery = delivery;
    Keiyaku.prototype.audit = audit;
  }
  assert.equal((await contract.state()).terminal?.kind, "claimed");
});

test("audit renders an unavailable public delivery diff as an observation", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--here", "--actor", "external-test", "-"],
    contractDocument("Unavailable audit diff"),
  );
  const id = acceptedContract(bound);
  writeFileSync(resolve(repository.path, "candidate.txt"), "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);
  const delivered = await invokeWithDocument(repository.path, ["deliver", id, "--actor", "external-test"], "");
  assert.equal(delivered.kind, "accepted");

  const contract = Keiyaku.of({ id, repo: repository.path });
  const delivery = await contract.delivery();
  if (delivery === null) throw new Error("delivery was not available for audit");
  const diff = Delivery.prototype.diff;
  Delivery.prototype.diff = async function() {
    return null;
  };
  try {
    const result = await invokeWithDocument(repository.path, ["audit", id, "--show-diff-body"], "");
    assert.equal(result.kind, "observation");
    if (result.kind !== "observation") return;
    assert.deepEqual(result.diff, {
      reason: "transport-unavailable",
      snapshotId: delivery.snapshotId,
      changeId: delivery.changeId,
    });
  } finally {
    Delivery.prototype.diff = diff;
  }
});

test("managed delivery reads and reconcile realigns its deterministic worktree", async () => {
  const repository = repositoryWithMain();
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Managed Worktree"),
  );
  const id = acceptedContract(bound);
  const path = deliveryWorktreePath(repositoryAt(repository.path), id);
  const managedRepository = repositoryAt(path);
  assert.equal(managedRepository.effectiveCwd, path);
  assert.equal(managedRepository.primaryWorktree, repositoryAt(repository.path).primaryWorktree);
  const fromManaged = (argv: readonly string[], source = "") => invoke(
    parseArgv(["-C", path, ...argv]),
    { environment: {}, readStdin: () => source },
  );
  assert.equal(deliveryWorktreePath(managedRepository, id), path);
  assert.notEqual(path, resolve(path, ".keiyaku-v4", "worktrees", "managed-worktree"));
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "managed candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();

  const deliver = await fromManaged(["deliver", "--actor", "external-test"]);
  assert.equal(deliver.kind, "accepted");
  const state = observeContract(repositoryAt(repository.path), id).state;
  assert.equal(state?.delivery?.data.candidate, candidate);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)), candidate);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)), candidate);
  const audit = await fromManaged(["audit"]);
  assert.equal(audit.kind, "observation");
  if (audit.kind !== "observation") throw new Error("audit was not an observation");
  assert.equal(audit.attempt, undefined);

  repository.run(["-C", path, "reset", "--hard", target]);
  const reconciled = reconcile({ repository: repositoryAt(repository.path), state });
  assert.equal(reconciled.effects.some((effect) => effect.kind === "worktree" && effect.action === "updated"), true);
  assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), candidate);

  const satisfiedReview = await fromManaged(["review", id, "--satisfied", "--actor", "external-test"]);
  assert.equal(satisfiedReview.kind, "accepted");
  assert.equal("lag" in satisfiedReview, false);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)), null);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)), null);
  assert.equal(existsSync(path), false);
});

test("managed abandonment cleans terminal resources from its own worktree cwd", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Managed Abandonment"),
  );
  const id = acceptedContract(bound);

  const path = deliveryWorktreePath(repositoryAt(repository.path), id);
  const fromManaged = (argv: readonly string[], source = "") => invoke(
    parseArgv(["-C", path, ...argv]),
    { environment: {}, readStdin: () => source },
  );
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "managed candidate"]);
  const delivered = await fromManaged(["deliver", "--actor", "external-test"]);
  assert.equal(delivered.kind, "accepted");
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)) !== null, true);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)) !== null, true);

  const abandoned = await fromManaged([
    "abandon", id, "--note", "scope changed", "--actor", "external-test",
  ]);
  assert.equal(abandoned.kind, "accepted");
  assert.equal("lag" in abandoned, false);
  assert.equal(observeContract(repositoryAt(repository.path), id).state?.abandon?.data.note, "scope changed");
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)), null);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)), null);
  assert.equal(existsSync(path), false);
});

test("reconcile world command adapts the public repository report", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(repository.path, ["bind", "-"], contractDocument("Reconcile world"));
  assert.equal(bound.kind, "accepted");

  const result = await invoke(parseArgv(["reconcile"]), {
    cwd: repository.path,
    environment: {},
  });
  assert.equal(result.kind, "observation");
  if (result.kind !== "observation") return;
  assert.ok(Array.isArray(result.effects));
  assert.equal("contracts" in result, false);
});

test("--here delivers the caller worktree without owning it or its branch", async () => {
  const repository = repositoryWithMain();
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();
  repository.run(["checkout", "--quiet", "-b", "feature"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "feature candidate"]);
  const candidate = repository.run(["rev-parse", "HEAD"]).trim();
  const command = (argv: readonly string[], source = contractDocument("Here Worktree")) => invoke(
    parseArgv(["-C", repository.path, ...argv]),
    { environment: {}, readStdin: () => source },
  );

  const bound = await command(["bind", "--target", "refs/heads/main", "--here", "--actor", "external-test", "-"]);
  const id = acceptedContract(bound);
  assert.deepEqual(observeContract(repositoryAt(repository.path), id).state?.coordinates, {
    start: target,
    target: "refs/heads/main",
    workspace: "here",
  });

  await assert.rejects(
    () => command(["deliver", "--actor", "external-test"]),
    (error: unknown) => error instanceof CliUsageError && /explicit full or @ contract selector/.test(error.message),
  );

  const deliver = await command(["deliver", id, "--actor", "external-test"]);
  assert.equal(deliver.kind, "accepted");
  const state = observeContract(repositoryAt(repository.path), id).state;
  assert.equal(state?.delivery?.data.expectedPredecessor, target);
  assert.equal(state?.delivery?.data.candidate, candidate);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)), candidate);
  assert.equal(readRef(repositoryAt(repository.path), "refs/heads/main"), target);
  assert.equal(repository.run(["symbolic-ref", "--short", "HEAD"]).trim(), "feature");
  assert.equal(repository.run(["rev-parse", "HEAD"]).trim(), candidate);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)), null);
  assert.equal(existsSync(deliveryWorktreePath(repositoryAt(repository.path), id)), false);
  const reconciled = reconcile({ repository: repositoryAt(repository.path), state });
  assert.equal(reconciled.effects.some((effect) => effect.kind === "worktree"), false);

  const changesRequested = await command(
    ["review", id, "--unsatisfied", "--actor", "external-test", "-"],
    "summary from stdin\r\n",
  );
  assert.equal(changesRequested.kind, "accepted");
  assert.equal(
    observeContract(repositoryAt(repository.path), id).state?.attestations.at(-1)?.data.summary,
    "summary from stdin\r\n",
  );
  const abandoned = await command(["abandon", id, "--actor", "external-test"]);
  assert.equal(abandoned.kind, "accepted");
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)), null);
  assert.equal(readRef(repositoryAt(repository.path), "refs/heads/main"), target);
  assert.equal(repository.run(["symbolic-ref", "--short", "HEAD"]).trim(), "feature");
  assert.equal(repository.run(["rev-parse", "HEAD"]).trim(), candidate);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)), null);
  assert.equal(existsSync(deliveryWorktreePath(repositoryAt(repository.path), id)), false);
});

test("selector refusal does not use sole-active fallback and accepts only active @short", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(repository.path, ["bind", "--actor", "external-test", "-"], contractDocument("Selector Check"));
  const id = acceptedContract(bound);

  await assert.rejects(
    () => invokeWithDocument(repository.path, ["deliver", "--actor", "external-test"], ""),
    (error: unknown) => error instanceof CliUsageError && /explicit full or @ contract selector/.test(error.message),
  );
  await assert.rejects(
    () => invokeWithDocument(repository.path, ["deliver", "@unknown", "--actor", "external-test"], ""),
    (error: unknown) => error instanceof CliUsageError && /unknown contract selector/.test(error.message),
  );
  await assert.rejects(
    () => invokeWithDocument(repository.path, ["deliver", `@${id}`, "--actor", "external-test"], ""),
    (error: unknown) => error instanceof CliUsageError && /redundant/.test(error.message),
  );
  await assert.rejects(
    () => invokeWithDocument(repository.path, ["deliver", "selector-check", "--actor", "external-test"], ""),
    (error: unknown) => error instanceof CliUsageError && /must be kei\//.test(error.message),
  );
});
