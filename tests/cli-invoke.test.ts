import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GIT_REF, readRef, repositoryAt } from "../src/git/repository.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { Delivery, Keiyaku, KeiyakuRefused, KeiyakuRetry, Repo, type ContractId } from "../src/index.js";
import { reconcile } from "../src/git/reconcile.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { deliveryWorktreePath } from "../src/git/workspace.js";
import { invoke } from "../src/cli/invoke.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";
import { makeGitRepository, observeContract, withGitShim } from "./support/git.js";

function repositoryWithMain() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  mkdirSync(resolve(repository.path, ".keiyaku"), { recursive: true });
  writeFileSync(resolve(repository.path, ".keiyaku", "settings.json"), JSON.stringify({ gates: { default: ["reviewed"] } }));
  repository.run(["add", ".keiyaku/settings.json"]);
  repository.run(["commit", "--quiet", "-m", "initial"]);
  return repository;
}

function deliveryRefFor(contract: ContractId): string {
  return `refs/heads/keiyaku-delivery/kei-${contract.slice("kei/".length)}`;
}

function candidatePinRefFor(contract: ContractId): string {
  return `refs/heads/keiyaku-candidate/kei-${contract.slice("kei/".length)}`;
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

test("a missing invocation cwd is a typed usage refusal", async () => {
  const repository = repositoryWithMain();
  await assert.rejects(
    () => invoke(parseArgv(["-C", "missing", "settings"]), { cwd: repository.path, environment: {} }),
    (error: unknown) => error instanceof CliUsageError
      && /invocation cwd is not an existing directory/u.test(error.message),
  );
});

function acceptedContract(result: Awaited<ReturnType<typeof invoke>>): ContractId {
  if (result.kind !== "accepted") throw new Error(`expected accepted result, got ${result.kind}`);
  return result.contract;
}

test("show returns the canonical Contract guidance in text and JSON projections", async () => {
  const repository = repositoryWithMain();
  const source = contractDocument("Show Guidance");
  const bound = await invokeWithDocument(repository.path, ["bind", "-"], source);
  const id = acceptedContract(bound);
  const expected = await Keiyaku.of({ repo: Repo.at({ path: repository.path }), id }).guidance();

  const text = await invokeWithDocument(repository.path, ["show", id], "");
  assert.deepEqual(text, { kind: "guidance", contract: id, guidance: expected });

  const json = await invokeWithDocument(repository.path, ["show", `@${id.slice("kei/".length)}`, "--json"], "");
  assert.deepEqual(json, { kind: "guidance", contract: id, guidance: expected });

  await assert.rejects(
    () => invokeWithDocument(repository.path, ["show", "kei/missing"], ""),
    (error: unknown) => error instanceof KeiyakuRefused
      && assert.deepEqual(error.refusal, { kind: "contract-missing", contractId: "kei/missing" }) === undefined,
  );
});

test("one CLI invocation reuses its Repo for selector, settings, and contract lookup", async () => {
  const repository = repositoryWithMain();
  mkdirSync(resolve(repository.path, ".keiyaku"), { recursive: true });
  writeFileSync(resolve(repository.path, ".keiyaku", "settings.json"), JSON.stringify({ gates: { default: ["reviewed"] } }));
  const bound = await invokeWithDocument(repository.path, ["bind", "-"], contractDocument("Single public repo"));
  const id = acceptedContract(bound);
  const at = Repo.at;
  let constructions = 0;
  Repo.at = function(input) {
    constructions += 1;
    return at.call(this, input);
  };
  try {
    const result = await invokeWithDocument(
      repository.path,
      ["amend", `@${id.slice("kei/".length)}`, "--gates", "default", "-"],
      "## Append: Context\nReuse the one pinned repository.\n",
    );
    assert.equal(result.kind, "accepted");
    assert.equal(constructions, 1);
  } finally {
    Repo.at = at;
  }
});

test("explicit Repo selects Contract storage without replacing the invocation World", async () => {
  const invocationRepository = repositoryWithMain();
  const contractRepository = repositoryWithMain();
  writeFileSync(
    resolve(contractRepository.path, ".keiyaku", "settings.json"),
    JSON.stringify({ gates: { default: ["verified"] } }),
  );
  contractRepository.run(["add", ".keiyaku/settings.json"]);
  contractRepository.run(["commit", "--quiet", "-m", "distinct contract settings"]);

  const result = await invoke(parseArgv([
    "-C", invocationRepository.path,
    "--repo", contractRepository.path,
    "bind", "-",
  ]), {
    environment: {},
    readStdin: () => contractDocument("Orthogonal coordinates"),
  });
  const id = acceptedContract(result);
  const invocationRepo = Repo.at({ path: invocationRepository.path });
  const contractRepo = Repo.at({ path: contractRepository.path });

  assert.deepEqual((await Keiyaku.list({ repo: invocationRepo })).rows, []);
  assert.deepEqual((await Keiyaku.list({ repo: contractRepo })).rows.map((row) => row.id), [id]);
  assert.deepEqual((await observeContract(repositoryAt(contractRepository.path), id)).state?.terms.gates, ["reviewed"]);
});

test("composite status refuses an explicit Repo that could create a mixed-World report", async () => {
  const invocationRepository = repositoryWithMain();
  const contractRepository = repositoryWithMain();
  await assert.rejects(
    () => invoke(parseArgv([
      "-C", invocationRepository.path,
      "--repo", contractRepository.path,
      "status",
    ])),
    (error: unknown) => error instanceof CliUsageError
      && /--repo has no consumer for status/u.test(error.message),
  );
  await assert.rejects(
    () => invoke(parseArgv([
      "-C", invocationRepository.path,
      "--repo", contractRepository.path,
      "ls", "kei/",
    ])),
    (error: unknown) => error instanceof CliUsageError
      && /--repo has no consumer for ls/u.test(error.message),
  );
});

test("an explicit status selector projects one Kanshi report without changing section shape", async () => {
  const repository = repositoryWithMain();
  const tasks = Tasks.of(await World.at(repository.path));
  const associated = await tasks.add({ title: "Associated" });
  const unrelated = await tasks.add({ title: "Unrelated" });
  assert.equal(associated.kind, "accepted");
  assert.equal(unrelated.kind, "accepted");
  if (associated.kind !== "accepted") throw new Error("associated Task was not accepted");
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--task", associated.value.id, "-"],
    contractDocument("Targeted status"),
  );
  const id = acceptedContract(bound);

  const result = await invokeWithDocument(repository.path, ["status", id], "");

  assert.equal(result.kind, "status");
  if (result.kind !== "status") return;
  assert.equal(result.selection, "contract");
  assert.equal(result.report.contracts.kind, "present");
  assert.equal(result.report.tasks.kind, "present");
  assert.equal(result.report.akuma.kind, "present");
  if (result.report.akuma.kind === "present") assert.deepEqual(result.report.akuma.value.rows, []);
  if (result.report.contracts.kind !== "present" || result.report.tasks.kind !== "present") return;
  assert.deepEqual(result.report.contracts.value.rows.map((row) => row.id), [id]);
  assert.deepEqual(result.report.tasks.value.rows.map((row) => row.contract?.id), [id]);
});

test("addressed retry renders the selected contract coordinate", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Retry addressed"),
  );
  const id = acceptedContract(bound);
  const amend = Keiyaku.prototype.amend;
  const reason = { kind: "exhausted" as const };
  Keiyaku.prototype.amend = async () => { throw new KeiyakuRetry(reason); };
  try {
    const result = await invokeWithDocument(
      repository.path,
      ["amend", id, "--actor", "external-test", "-"],
      "## Replace: Context\nRetry without an outcome coordinate.\n",
    );
    assert.deepEqual(result, { kind: "retry", verb: "amend", contract: id, detail: reason });
  } finally {
    Keiyaku.prototype.amend = amend;
  }
});

test("post-admission reconcile failure remains accepted with a physical lag", async () => {
  const repository = repositoryWithMain();
  const result = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then',
      '  printf "forced CLI worktree failure\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    () => invokeWithDocument(repository.path, ["bind", "-"], contractDocument("CLI reconcile failure")),
  );

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("post-admission result was not accepted");
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["bind"]);
  assert.notEqual(result.head, null);
  assert.deepEqual(result.effects.map((effect) => [effect.kind, effect.action]), [["ref", "created"]]);
  assert.equal(result.lag?.[0]?.kind, "reconcile-failed");
  if (result.lag?.[0]?.kind === "reconcile-failed") {
    assert.equal(result.lag[0].stage, "effect");
    assert.match(result.lag[0].diagnostic, /forced CLI worktree failure/);
  }
  assert.deepEqual(result.settlement, { actions: [], lags: [] });

  const state = await Keiyaku.of({ repo: Repo.at({ path: repository.path }), id: result.contract }).state();
  assert.equal(state.id, result.contract);
  assert.equal(state.head, result.head);
  assert.equal(state.terminal, null);
});

test("journal-writing commands preserve optional actor testimony", async () => {
  const repository = repositoryWithMain();
  const command = (argv: readonly string[], environment: NodeJS.ProcessEnv) => invoke(parseArgv(argv), {
    cwd: repository.path,
    environment,
    readStdin: () => contractDocument("Optional Actor"),
  });

  const unsigned = await command(["bind", "-"], {});
  const unsignedEntries = (await observeContract(repositoryAt(repository.path), acceptedContract(unsigned))).entries;
  assert.equal(unsignedEntries.length, 1);
  assert.equal(unsignedEntries.every((entry) => !("actor" in entry)), true);

  const environmentActor = "projection/codex";
  const fromEnvironment = await command(["bind", "-"], {
    KEIYAKU_PROJECTION_ID: environmentActor,
  });
  assert.equal((await observeContract(repositoryAt(repository.path), acceptedContract(fromEnvironment))).entries[0]?.actor, environmentActor);

  const explicitActor = " external \u{1f9d1}\u{1f3fd}\u200d\u{1f4bb} ";
  const explicit = await command(["bind", "--actor", explicitActor, "-"], {
    KEIYAKU_PROJECTION_ID: "different projection",
  });
  const persisted = (await observeContract(repositoryAt(repository.path), acceptedContract(explicit))).entries[0]?.actor;
  assert.equal(persisted, explicitActor);
  assert.deepEqual(Buffer.from(persisted ?? "", "utf8"), Buffer.from(explicitActor, "utf8"));

  const beforeBlank = readRef(repositoryAt(repository.path), GIT_REF);
  await assert.rejects(
    () => command(["bind", "--actor", " \t", "-"], { KEIYAKU_PROJECTION_ID: "aku/environment" }),
    (error: unknown) => error instanceof CliUsageError && /actor must be a nonblank string/.test(error.message),
  );
  assert.equal(readRef(repositoryAt(repository.path), GIT_REF), beforeBlank);
});

test("bind defaults its target to the invocation worktree's current branch", async () => {
  const repository = repositoryWithMain();
  const start = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const source = contractDocument("Markdown Bind", "## Rollout Notes\nfirst\n\n- second\n");

  const result = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    source,
  );

  const state = (await observeContract(repositoryAt(repository.path), acceptedContract(result))).state;
  assert.deepEqual(state?.coordinates, {
    start,
    target: "refs/heads/main",
    workspace: "worktree",
  });
  assert.equal(result.kind === "accepted" ? result.target : undefined, "refs/heads/main");
  assert.equal(state?.terms?.document.bytes, source);
  const decoded = state?.terms === null || state?.terms === undefined
    ? null
    : decodeContractDocument(state.terms.document.bytes);
  assert.equal(decoded?.title, "Markdown Bind");
  assert.deepEqual(decoded?.extensions, [{ title: "Rollout Notes", content: "first\n\n- second\n" }]);
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
    (await observeContract(repositoryAt(repository.path), acceptedContract(result))).state?.coordinates,
    { start, target: "refs/heads/release", workspace: "worktree" },
  );
  assert.equal(result.kind === "accepted" ? result.target : undefined, "refs/heads/release");
});

test("targetless bind accepts detached HEAD without a reward operation", async () => {
  const repository = repositoryWithMain();
  repository.run(["checkout", "--quiet", "--detach"]);

  const result = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Detached"),
  );
  const coordinates = (await observeContract(repositoryAt(repository.path), acceptedContract(result))).state?.coordinates;
  assert.equal(coordinates?.target, undefined);
  assert.equal(result.kind === "accepted" ? result.target : undefined, null);
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
  const terms = (await observeContract(repositoryAt(repository.path), id)).state?.terms;
  const body = terms === null || terms === undefined ? null : decodeContractDocument(terms.document.bytes);
  assert.equal(body?.title, "Original");
  assert.equal(body?.context, "\nReplacement context.\n\n");
  assert.deepEqual(body?.extensions, [{ title: "Decision Log", content: "\nkept exactly\n" }]);
  assert.equal(amended.kind === "accepted" && typeof amended.diff === "string", true);

  const retried = await invokeWithDocument(
    repository.path,
    ["amend", id, "--actor", "external-test", "-"],
    "## Replace: Context\nSecond context.\n",
  );
  assert.equal(retried.kind, "accepted");
  assert.equal(retried.kind === "accepted" && typeof retried.diff === "string", true);

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
  const before = readRef(repositoryAt(repository.path), GIT_REF);

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
  assert.equal(readRef(repositoryAt(repository.path), GIT_REF), before);

  const selfDependent = await invokeWithDocument(
    repository.path,
    ["amend", id, "--after", id, "--actor", "external-test", "-"],
    "## Append: Context\nMust also refuse.\n",
  );
  assert.deepEqual(selfDependent, {
    kind: "refused",
    verb: "amend",
    contract: id,
    refusal: { kind: "prerequisites-already-consumed", contractId: id },
  });
  assert.equal(readRef(repositoryAt(repository.path), GIT_REF), before);
});

test("concurrent amend diff uses the accepted predecessor after a competing amend", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Concurrent original"),
  );
  const id = acceptedContract(bound);
  const contract = Keiyaku.of({ repo: Repo.at({ path: repository.path }), id });
  const amend = Keiyaku.prototype.amend;
  let injected = false;

  Keiyaku.prototype.amend = async function(input) {
    if (!injected) {
      injected = true;
      await amend.call(this, {
        ...input,
        markdown: "## Replace: Context\nIntervening context.\n",
      });
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
    if (later.kind !== "accepted" || typeof later.diff !== "string") {
      throw new Error("accepted amendment is missing its presentation diff");
    }
    assert.match(later.diff, /-Intervening context\./);
    assert.match(later.diff, /\+Later context\./);
    assert.deepEqual(later.facts.map((fact) => fact.kind), ["amend"]);
  } finally {
    Keiyaku.prototype.amend = amend;
  }
});

test("bind freezes the selected gate snapshot", async () => {
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
    (await observeContract(repositoryAt(repository.path), acceptedContract(result))).state?.terms?.gates,
    ["reviewed"],
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
  const delivered = await invokeWithDocument(
    repository.path,
    ["deliver", id, "--include-dirty", "--actor", "external-test"],
    "",
  );
  assert.equal(delivered.kind, "accepted");

  const contract = Keiyaku.of({ repo: Repo.at({ path: repository.path }), id });
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
    await this.review({ verdict: "satisfied", ...options });
    return audit.call(this, options);
  };
  try {
    const result = await invokeWithDocument(
      repository.path,
      ["audit", id, "--show-diff-body", "--actor", "external-test"],
      "",
    );
    assert.equal(result.kind, "accepted");
    assert.match(JSON.stringify(result), /\+candidate/);
    assert.equal(deliveryReads, 1);
  } finally {
    Keiyaku.prototype.delivery = delivery;
    Keiyaku.prototype.audit = audit;
  }
  assert.equal((await contract.state()).terminal?.kind, "claimed");
});

test("audit renders an unavailable public delivery diff as accepted", async () => {
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

  const contract = Keiyaku.of({ repo: Repo.at({ path: repository.path }), id });
  const delivery = await contract.delivery();
  if (delivery === null) throw new Error("delivery was not available for audit");
  const diff = Delivery.prototype.diff;
  Delivery.prototype.diff = async function() {
    return null;
  };
  try {
    const result = await invokeWithDocument(repository.path, ["audit", id, "--show-diff-body"], "");
    assert.equal(result.kind, "accepted");
    if (result.kind !== "accepted") return;
    assert.deepEqual(result.diff, {
      reason: "git-unavailable",
      integrationSnapshot: delivery.integration.snapshot,
      changeId: delivery.integration.changeId,
    });
  } finally {
    Delivery.prototype.diff = diff;
  }
});

test("managed delivery reads without realigning its deterministic worktree", async () => {
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
  assert.match(path, /[\\/]keiyaku[\\/]wt[\\/]/u);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "managed candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();

  const deliver = await fromManaged(["deliver", "--actor", "external-test"]);
  assert.equal(deliver.kind, "accepted");
  const state = (await observeContract(repositoryAt(repository.path), id)).state;
  assert.equal(state?.delivery?.data.tenderSnapshot, candidate);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)), state?.delivery?.data.integration.snapshot);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)), candidate);
  const audit = await fromManaged(["audit"]);
  assert.equal(audit.kind, "accepted");
  if (audit.kind !== "accepted") throw new Error("audit was not accepted");
  assert.equal(audit.report?.attempt, undefined);

  repository.run(["-C", path, "reset", "--hard", target]);
  const reconcileRepository = repositoryAt(repository.path);
  const reconciled = await withGitDecodeChannel(reconcileRepository, (channel) => reconcile({
    repository: reconcileRepository,
    channel,
    contractId: id,
    hooks: { create: [], destroy: [] },
    retryHooks: false,
  }));
  assert.equal(reconciled.result.effects.some((effect) => effect.kind === "worktree" && effect.action === "unchanged"), true);
  assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), target);

  const satisfiedReview = await fromManaged(["review", id, "--satisfied", "--actor", "external-test"]);
  assert.equal(satisfiedReview.kind, "accepted");
  assert.equal("lag" in satisfiedReview, false);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)), null);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)), null);
  assert.equal(existsSync(path), false);
});

test("an accepted arc preserves un-tendered managed worktree content", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Un-tendered Work"),
  );
  const id = acceptedContract(bound);
  const path = deliveryWorktreePath(repositoryAt(repository.path), id);
  writeFileSync(resolve(path, "agent-owned.txt"), "keep this work\n");
  repository.run(["-C", path, "add", "agent-owned.txt"]);
  repository.run(["-C", path, "commit", "--quiet", "-m", "un-tendered work"]);
  const work = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();

  const arc = await invokeWithDocument(
    repository.path,
    ["arc", id, "--actor", "external-test", "-"],
    ["# Continue", "", "## Objective", "", "Keep the current work.", "", "## Brief", "", "Do not change the worktree."].join("\n"),
  );

  assert.equal(arc.kind, "accepted");
  assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), work);
  assert.equal(repository.run(["-C", path, "show", "HEAD:agent-owned.txt"]), "keep this work\n");
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
  assert.equal((await observeContract(repositoryAt(repository.path), id)).state?.terminal?.kind, "abandoned");
  assert.equal((await observeContract(repositoryAt(repository.path), id)).state?.terminal?.data.note, "scope changed");
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)) !== null, true);
  assert.equal(
    readRef(repositoryAt(repository.path), candidatePinRefFor(id)),
    (await observeContract(repositoryAt(repository.path), id)).state?.delivery?.data.integration.snapshot,
  );
  assert.equal(existsSync(path), false);
});

test("a terminal worktree removal failure remains accepted cleanup lag", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Retained Cleanup"),
  );
  const id = acceptedContract(bound);
  const path = deliveryWorktreePath(repositoryAt(repository.path), id);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "retained candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  const delivered = await invoke(parseArgv(["-C", path, "deliver", id, "--actor", "external-test"]), {
    environment: {},
  });
  assert.equal(delivered.kind, "accepted");
  const state = (await observeContract(repositoryAt(repository.path), id)).state;

  const abandoned = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
      '  printf "worktree became busy\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    () => invoke(parseArgv(["-C", path, "abandon", id, "--actor", "external-test"]), {
      environment: {},
    }),
  );

  assert.equal(abandoned.kind, "accepted");
  if (abandoned.kind !== "accepted") return;
  assert.deepEqual(abandoned.lag, [{ kind: "worktree-retained", path }]);
  assert.equal(existsSync(path), true);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)), state?.delivery?.data.tenderSnapshot);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)), state?.delivery?.data.integration.snapshot);
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
  assert.ok(Array.isArray(result.contracts));
});

test("--here delivers in place without owning a managed worktree", async () => {
  const repository = repositoryWithMain();
  const main = repository.run(["rev-parse", "refs/heads/main"]).trim();
  repository.run(["checkout", "--quiet", "-b", "feature"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "feature candidate"]);
  const candidate = repository.run(["rev-parse", "HEAD"]).trim();
  const command = (argv: readonly string[], source = contractDocument("Here Worktree")) => invoke(
    parseArgv(["-C", repository.path, ...argv]),
    { environment: {}, readStdin: () => source },
  );

  const bound = await command(["bind", "--here", "--actor", "external-test", "-"]);
  const id = acceptedContract(bound);
  assert.deepEqual((await observeContract(repositoryAt(repository.path), id)).state?.coordinates, {
    start: candidate,
    target: "refs/heads/feature",
    workspace: "here",
  });

  await assert.rejects(
    () => command(["deliver", "--actor", "external-test"]),
    (error: unknown) => error instanceof CliUsageError && /explicit full or @ contract selector/.test(error.message),
  );

  const deliver = await command(["deliver", id, "--actor", "external-test"]);
  assert.equal(deliver.kind, "accepted");
  const state = (await observeContract(repositoryAt(repository.path), id)).state;
  assert.equal(state?.delivery?.data.integration.predecessor, candidate);
  assert.equal(state?.delivery?.data.tenderSnapshot, candidate);
  assert.notEqual(state?.delivery?.data.integration.snapshot, candidate);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)), state?.delivery?.data.integration.snapshot);
  assert.equal(readRef(repositoryAt(repository.path), "refs/heads/main"), main);
  assert.equal(readRef(repositoryAt(repository.path), "refs/heads/feature"), candidate);
  assert.equal(repository.run(["symbolic-ref", "--short", "HEAD"]).trim(), "feature");
  assert.equal(repository.run(["rev-parse", "HEAD"]).trim(), candidate);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor(id)), null);
  assert.equal(existsSync(deliveryWorktreePath(repositoryAt(repository.path), id)), false);
  const reconcileRepository = repositoryAt(repository.path);
  const reconciled = await withGitDecodeChannel(reconcileRepository, (channel) => reconcile({
    repository: reconcileRepository,
    channel,
    contractId: id,
    hooks: { create: [], destroy: [] },
    retryHooks: false,
  }));
  assert.equal(reconciled.result.effects.some((effect) => effect.kind === "worktree"), false);

  const changesRequested = await command(
    ["review", id, "--unsatisfied", "--actor", "external-test", "-"],
    "summary from stdin\r\n",
  );
  assert.equal(changesRequested.kind, "accepted");
  assert.equal(
    (await observeContract(repositoryAt(repository.path), id)).state?.attestations.at(-1)?.data.summary,
    "summary from stdin\r\n",
  );
  const abandoned = await command(["abandon", id, "--actor", "external-test"]);
  assert.equal(abandoned.kind, "accepted");
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor(id)), state?.delivery?.data.integration.snapshot);
  assert.equal(readRef(repositoryAt(repository.path), "refs/heads/main"), main);
  assert.equal(readRef(repositoryAt(repository.path), "refs/heads/feature"), candidate);
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
