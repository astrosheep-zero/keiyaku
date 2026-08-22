import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GIT_REF, readRef, repositoryAt } from "../src/git/repository.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { HeartAbsentError } from "../src/akuma/heart/index.js";
import { Delivery, Keiyaku, KeiyakuRefused, KeiyakuRetry, NoGitWorldError, Repo, type ContractId } from "../src/index.js";
import { reconcile } from "../src/git/reconcile.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { appointedWorktreePath, makeGitRepository, observeContract, withGitShim } from "./support/git.js";
import { repositoryWithMain as makeRepositoryWithMain } from "./support/library-verbs.js";
const repositoryWithMain = () => makeRepositoryWithMain({ files: {
  ".keiyaku/settings.json": JSON.stringify({ gates: {
    default: { kind: "bundle", gates: ["reviewed"] },
  } }),
} });
import { invoke } from "../src/cli/invoke.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { renderText } from "../src/cli/render/text.js";
import { BindDraftError, preserveBindDraft } from "../src/cli/draft.js";
import { acceptedDeliver, acceptedReview } from "../src/cli/accepted.js";
import { contractHead, contractId } from "../src/core/facts/types.js";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";

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

async function invokeWithDocument(
  repositoryPath: string,
  argv: readonly string[],
  source: string,
  environment: NodeJS.ProcessEnv = {},
) {
  return invoke(parseArgv(argv), {
    cwd: repositoryPath,
    environment,
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

test("install does not consume KEIYAKU_GIT_PATH before coordinate resolution", async () => {
  const result = await invoke(parseArgv(["install", "codex"]), {
    cwd: "/missing/keiyaku-cli-git-path",
    environment: { KEIYAKU_GIT_PATH: "   ", PATH: "" },
  });
  assert.deepEqual(result, {
    kind: "install",
    results: [{ harness: "codex", status: "failed", diagnostic: "codex unavailable: spawn codex ENOENT" }],
  });
});

function sourceModulesLoadedByCli(
  argv: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), "keiyaku-cli-trace-"));
  const tracer = join(dir, "trace.mjs");
  const output = join(dir, "loaded.json");
  writeFileSync(tracer, [
    'import { registerHooks } from "node:module";',
    'import { writeFileSync } from "node:fs";',
    "const loaded = [];",
    "registerHooks({",
    "  load(url, context, nextLoad) {",
    "    loaded.push(url);",
    "    return nextLoad(url, context);",
    "  },",
    "});",
    `const { main } = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../src/cli/main.ts")).href)});`,
    `const code = await main(${JSON.stringify(argv)});`,
    `writeFileSync(${JSON.stringify(output)}, JSON.stringify(loaded));`,
    "process.exitCode = code;",
    "",
  ].join("\n"));
  const env = { ...process.env, ...environment };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), tracer], {
    cwd,
    encoding: "utf8",
    env,
  });
  if (!existsSync(output)) {
    throw new Error(`CLI family trace missing: status=${String(result.status)}\n${result.stdout}\n${result.stderr}`);
  }
  const loaded = JSON.parse(readFileSync(output, "utf8")) as string[];
  const srcPrefix = `${pathToFileURL(resolve(import.meta.dirname, "../src")).href}/`;
  return loaded.flatMap((url) => {
    const bare = url.split("?")[0]!;
    if (!bare.startsWith(srcPrefix)) return [];
    return [decodeURIComponent(bare.slice(srcPrefix.length))];
  });
}

function assertLoaded(loaded: readonly string[], expected: readonly string[], forbidden: readonly string[]): void {
  const seen = loaded.join(", ");
  for (const path of expected) {
    assert.ok(loaded.includes(path), `expected to load ${path}, got ${seen}`);
  }
  for (const path of forbidden) {
    assert.ok(!loaded.includes(path), `did not expect to load ${path}; loaded ${seen}`);
  }
}

test("help and selected commands load only their CLI families", () => {
  const repository = repositoryWithMain();
  const cwd = resolve(import.meta.dirname, "..");
  const atRepo = (command: readonly string[]): readonly string[] => ["-C", repository.path, ...command];
  const product = [
    "settings.ts",
    "task/index.ts",
    "kanshi/index.ts",
    "akuma/index.ts",
    "cli/commands/akuma-invoke.ts",
    "cli/commands/task-invoke.ts",
    "runtime/proc/run.ts",
  ] as const;
  const otherFamilies = [
    "task/index.ts",
    "kanshi/index.ts",
    "akuma/index.ts",
    "cli/commands/akuma-invoke.ts",
    "cli/commands/task-invoke.ts",
  ] as const;
  assertLoaded(sourceModulesLoadedByCli(["--help"], cwd), ["cli/parse.ts"], [
    "cli/runtime.ts",
    "cli/invoke.ts",
    ...product,
  ]);
  assertLoaded(sourceModulesLoadedByCli(atRepo(["settings"]), cwd), ["cli/runtime.ts", "cli/invoke.ts", "settings.ts"], otherFamilies);
  assertLoaded(sourceModulesLoadedByCli(["install", "codex"], cwd, { PATH: "" }), [
    "cli/runtime.ts",
    "cli/invoke.ts",
    "runtime/proc/run.ts",
  ], ["settings.ts", ...otherFamilies]);
  assertLoaded(sourceModulesLoadedByCli(atRepo(["task", "ls"]), cwd), [
    "cli/commands/task-invoke.ts",
    "task/index.ts",
  ], [
    "kanshi/index.ts",
    "akuma/index.ts",
    "cli/commands/akuma-invoke.ts",
  ]);
  assertLoaded(sourceModulesLoadedByCli(atRepo(["status", "--json"]), cwd), ["kanshi/index.ts"], [
    "cli/commands/akuma-invoke.ts",
    "cli/commands/task-invoke.ts",
  ]);
  assertLoaded(sourceModulesLoadedByCli(atRepo(["status", "aku/missing", "--json"]), cwd), [
    "cli/commands/akuma-invoke.ts",
    "akuma/index.ts",
  ], [
    "kanshi/index.ts",
    "cli/commands/task-invoke.ts",
  ]);
});

test("an implicit Contract call refuses before creating its candidate World", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const marker = resolve(repository.path, ".keiyaku");
  assert.equal(existsSync(marker), false);

  await assert.rejects(
    () => invoke(parseArgv([
      "call", "worker", "--contract", "kei/missing", "-",
    ]), {
      cwd: repository.path,
      environment: {},
      readStdin: () => Promise.resolve("work"),
    }),
    (error: unknown) => error instanceof KeiyakuRefused
      && assert.deepEqual(error.refusal, { kind: "contract-missing", contractId: "kei/missing" }) === undefined,
  );
  assert.equal(existsSync(marker), false);
});

test("targetless bind on an unborn HEAD renders its typed refusal and preserves the draft", async () => {
  const repository = makeGitRepository();
  const source = contractDocument("Unborn CLI bind");
  const result = await invokeWithDocument(repository.path, ["bind", "-"], source);
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") return;
  assert.deepEqual(result.refusal, { kind: "unborn-head" });
  assert.match(renderText(result), /unborn-head/u);
  assert.equal(result.draft?.path === undefined, false);
  assert.equal(repository.run(["for-each-ref", "--format=%(refname)", "refs/heads/keiyaku-state"]), "");
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
  const expected = await Keiyaku.of({ repo: await Repo.at({ path: repository.path }), id }).guidance();
  assert.ok(expected.startsWith(
    `---\ncontract: ${id}\ndescription: This is a read-only projection. Do not edit manually.\n---\n\n`,
  ));

  const text = await invokeWithDocument(repository.path, ["show", id], "");
  assert.deepEqual(text, { kind: "guidance", contract: id, guidance: expected });

  await assert.rejects(
    () => invokeWithDocument(repository.path, ["show", "kei/missing"], ""),
    (error: unknown) => error instanceof KeiyakuRefused
      && assert.deepEqual(error.refusal, { kind: "contract-missing", contractId: "kei/missing" }) === undefined,
  );
});

test("deliver exposes the core-owned unmet prerequisites unchanged in its JSON result", () => {
  const dependentId = contractId("kei/dependent-delivery");
  const prerequisiteId = contractId("kei/active-prerequisite");
  const expected = {
    kind: "prerequisites-unsatisfied" as const,
    contractId: dependentId,
    unmet: [{ contractId: prerequisiteId, state: "active" as const }],
  };
  const placement = { refusal: expected };
  const delivered = acceptedDeliver({
    facts: [],
    head: contractHead("head"),
    value: { placement } as Delivery,
    effects: [],
    lags: [],
    settlement: { actions: [], lags: [] },
  }, dependentId);

  assert.strictEqual(delivered.placement, placement);
  assert.deepEqual(JSON.parse(JSON.stringify(delivered)).placement, placement);
});

test("accepted deliver and review transport completion consequences without reconstructing facts", () => {
  const contract = contractId("kei/completion-result");
  const completion = {
    integration: "final-integration",
    verification: { mode: "reused" as const, verdict: "unsatisfied" as const },
  };
  const continuation = {
    claimed: [contractId("kei/dependent")],
    stopped: [],
  };
  const envelope = {
    head: contractHead("head"),
    effects: [],
    lags: [],
    settlement: { actions: [], lags: [] },
  };

  const delivered = acceptedDeliver({
    ...envelope,
    facts: [],
    value: { completion, continuation } as Delivery,
  }, contract);
  assert.strictEqual(delivered.completion, completion);
  assert.strictEqual(delivered.continuation, continuation);

  const reviewed = acceptedReview({
    ...envelope,
    facts: [{
      contract,
      entry: "review",
      kind: "attestation",
      data: { gate: "reviewed", verdict: "satisfied" },
    }] as never,
    value: { completion, continuation },
  }, contract);
  assert.strictEqual(reviewed.completion, completion);
  assert.strictEqual(reviewed.continuation, continuation);
});

test("one CLI invocation reuses its Repo for selector, settings, and contract lookup", async () => {
  const repository = repositoryWithMain();
  mkdirSync(resolve(repository.path, ".keiyaku"), { recursive: true });
  writeFileSync(resolve(repository.path, ".keiyaku", "settings.json"), JSON.stringify({ gates: {
    default: { kind: "bundle", gates: ["reviewed"] },
  } }));
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
    JSON.stringify({ gates: { default: { kind: "bundle", gates: ["verified"] } } }),
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
  const invocationRepo = await Repo.at({ path: invocationRepository.path });
  const contractRepo = await Repo.at({ path: contractRepository.path });

  assert.deepEqual((await Keiyaku.list({ repo: invocationRepo })).rows, []);
  assert.deepEqual((await Keiyaku.list({ repo: contractRepo })).rows.map((row) => row.id), [id]);
  assert.deepEqual((await observeContract(await repositoryAt(contractRepository.path), id)).state?.terms.gates, ["reviewed"]);
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
    (gitPath) => invokeWithDocument(repository.path, ["bind", "-"], contractDocument("CLI reconcile failure"), {
      KEIYAKU_GIT_PATH: gitPath,
    }),
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

  const state = await Keiyaku.of({ repo: await Repo.at({ path: repository.path }), id: result.contract }).state();
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
  const unsignedEntries = (await observeContract(await repositoryAt(repository.path), acceptedContract(unsigned))).entries;
  assert.equal(unsignedEntries.length, 1);
  assert.equal(unsignedEntries.every((entry) => !("actor" in entry)), true);

  const environmentActor = "projection/codex";
  const fromEnvironment = await command(["bind", "-"], {
    KEIYAKU_ACTOR_ID: environmentActor,
  });
  assert.equal((await observeContract(await repositoryAt(repository.path), acceptedContract(fromEnvironment))).entries[0]?.actor, environmentActor);

  const explicitActor = " external \u{1f9d1}\u{1f3fd}\u200d\u{1f4bb} ";
  const explicit = await command(["bind", "--actor", explicitActor, "-"], {
    KEIYAKU_ACTOR_ID: "different projection",
  });
  const persisted = (await observeContract(await repositoryAt(repository.path), acceptedContract(explicit))).entries[0]?.actor;
  assert.equal(persisted, explicitActor);
  assert.deepEqual(Buffer.from(persisted ?? "", "utf8"), Buffer.from(explicitActor, "utf8"));

  const beforeBlank = await readRef(await repositoryAt(repository.path), GIT_REF);
  await assert.rejects(
    async () => command(["bind", "--actor", " \t", "-"], { KEIYAKU_ACTOR_ID: "aku/environment" }),
    (error: unknown) => error instanceof CliUsageError && /--actor requires a nonblank value/.test(error.message),
  );
  assert.equal(await readRef(await repositoryAt(repository.path), GIT_REF), beforeBlank);
});

test("task creation resolves actor before applying the selected input", async () => {
  const repository = repositoryWithMain();
  const inherited = await invoke(parseArgv(["-C", repository.path, "task", "add", "Inherited"]), {
    environment: { KEIYAKU_ACTOR_ID: "env-actor" },
  }) as { value: { createdBy?: string } };
  assert.equal(inherited.value.createdBy, "env-actor");
  const explicit = await invoke(parseArgv(["-C", repository.path, "task", "add", "Explicit", "--actor", "flag"]), {
    environment: { KEIYAKU_ACTOR_ID: "env-actor" },
  }) as { value: { createdBy?: string } };
  assert.equal(explicit.value.createdBy, "flag");
  const composed = await invoke(parseArgv(["-C", repository.path, "task", "compose", "-"]), {
    environment: { KEIYAKU_ACTOR_ID: "env-actor" },
    readStdin: () => "+ Composed\n",
  }) as { kind: string };
  assert.equal(composed.kind, "accepted");
  const shown = await invoke(parseArgv(["-C", repository.path, "task", "show", "task/composed"])) as { task: { createdBy?: string } };
  assert.equal(shown.task.createdBy, "env-actor");
  const blankEnv = await invoke(parseArgv(["-C", repository.path, "task", "add", "Blank Env"]), {
    environment: { KEIYAKU_ACTOR_ID: "  " },
  }) as { value: { createdBy?: string } };
  assert.equal("createdBy" in blankEnv.value, false);
});

test("a linked-worktree Task invocation uses its local namespace and the primary World board", async () => {
  const repository = repositoryWithMain();
  const linked = join(mkdtempSync(join(tmpdir(), "keiyaku-linked-task-")), "worktree");
  repository.run(["worktree", "add", "--detach", linked]);
  const nested = join(linked, "nested");
  mkdirSync(nested);

  await invoke(parseArgv(["-C", repository.path, "task", "namespace", "primary"]), { environment: {} });
  await invoke(parseArgv(["-C", nested, "task", "namespace", "linked"]), { environment: {} });
  const linkedNamespace = await invoke(parseArgv(["-C", nested, "task", "namespace"]), { environment: {} });
  assert.deepEqual(linkedNamespace, { kind: "accepted", value: ["linked"] });
  const added = await invoke(parseArgv(["-C", nested, "task", "add", "Linked worktree task"]), {
    environment: {},
  }) as { kind: string; value?: { id?: string } };

  assert.equal(added.kind, "accepted");
  assert.match(added.value?.id ?? "", /^task\/linked\//u);
  assert.equal(readFileSync(join(repository.path, ".keiyaku", "namespace", "current"), "utf8").trim(), "primary");
  assert.equal(readFileSync(join(nested, ".keiyaku", "namespace", "current"), "utf8").trim(), "linked");
  const world = await World.at(repository.path);
  const board = await Tasks.of(world).list({ selection: "all", scope: "world" });
  assert.equal(board.kind, "accepted");
  if (board.kind === "accepted") assert.equal(board.value.rows.some((row) => row.id === added.value?.id), true);
});

test("targetless bind uses the invocation worktree's current HEAD without a target ref", async () => {
  const repository = repositoryWithMain();
  const start = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const source = contractDocument("Markdown Bind", "## Rollout Notes\nfirst\n\n- second\n");

  const result = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    source,
  );

  const state = (await observeContract(await repositoryAt(repository.path), acceptedContract(result))).state;
  assert.deepEqual(state?.coordinates, {
    start,
    workspace: "worktree",
  });
  assert.equal(result.kind === "accepted" ? result.target : undefined, null);
  assert.equal(state?.terms?.document.bytes, source);
  const decoded = state?.terms === null || state?.terms === undefined
    ? null
    : decodeContractDocument(state.terms.document.bytes);
  assert.equal(decoded?.title, "Markdown Bind");
  assert.deepEqual(decoded?.extensions, [{ title: "Rollout Notes", content: "first\n\n- second\n" }]);
});

test("bind refusals preserve exact stdin without partial Contract or Task effects", async () => {
  const repository = repositoryWithMain();
  const tasks = Tasks.of(await World.at(repository.path));
  const added = await tasks.add({ title: "Still Open" });
  assert.equal(added.kind, "accepted");
  if (added.kind !== "accepted") throw new Error("Task setup was refused");
  const source = contractDocument("Refused Draft");

  const result = await invokeWithDocument(repository.path, [
    "bind",
    "--task", added.value.id,
    "--after", "kei/missing-prerequisite",
    "-",
  ], source);

  assert.equal(result.kind, "refused");
  if (result.kind !== "refused" || result.draft?.path === undefined) {
    throw new Error("bind refusal did not return a draft path");
  }
  assert.equal(readFileSync(resolve(repository.path, result.draft.path), "utf8"), source);
  assert.deepEqual((await Keiyaku.list({ repo: await Repo.at({ path: repository.path }) })).rows, []);
  const board = await tasks.list({ selection: "all", scope: "world" });
  assert.equal(board.kind, "accepted");
  if (board.kind === "accepted") assert.equal(board.value.rows.find((row) => row.id === added.value.id)?.state, "open");
});

test("invalid bind Markdown preserves exact stdin while retaining the original error", async () => {
  const repository = repositoryWithMain();
  const source = `---\r\ninvalid: [\r\n---\r\n${contractDocument("Invalid YAML")}`;
  let observed: BindDraftError | undefined;

  await assert.rejects(
    () => invokeWithDocument(repository.path, ["bind", "-"], source),
    (error: unknown) => {
      if (!(error instanceof BindDraftError)) return false;
      observed = error;
      return error.original instanceof TypeError;
    },
  );

  assert.notEqual(observed, undefined);
  if (observed?.draft.path === undefined) throw new Error("invalid document did not return a draft path");
  assert.equal(readFileSync(resolve(repository.path, observed.draft.path), "utf8"), source);
  assert.deepEqual((await Keiyaku.list({ repo: await Repo.at({ path: repository.path }) })).rows, []);
});

test("successful bind leaves existing draft receipts untouched", async () => {
  const repository = repositoryWithMain();
  const world = await World.at(repository.path);
  const old = await preserveBindDraft(world, "old refused input\n");
  if (old.path === undefined) throw new Error(old.warning ?? "draft setup failed");
  const path = resolve(repository.path, old.path);
  const before = readFileSync(path);

  const result = await invokeWithDocument(repository.path, ["bind", "-"], contractDocument("Successful Bind"));

  assert.equal(result.kind, "accepted");
  assert.deepEqual(readFileSync(path), before);
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
    (await observeContract(await repositoryAt(repository.path), acceptedContract(result))).state?.coordinates,
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
  const coordinates = (await observeContract(await repositoryAt(repository.path), acceptedContract(result))).state?.coordinates;
  assert.equal(coordinates?.target, undefined);
  assert.equal(result.kind === "accepted" ? result.target : undefined, null);
});

test("amend structured terms do not acquire stdin", async () => {
  const repository = repositoryWithMain();
  const prerequisite = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Terms prerequisite"),
  );
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Terms only"),
  );
  const prerequisiteId = acceptedContract(prerequisite);
  const id = acceptedContract(bound);
  let reads = 0;
  const command = (argv: readonly string[]) => invoke(parseArgv(argv), {
    cwd: repository.path,
    environment: {},
    readStdin: async () => {
      reads += 1;
      return "should not be read";
    },
  });

  const after = await command(["amend", id, "--after", prerequisiteId]);
  const cleared = await command(["amend", id, "--clear-after"]);
  const gated = await command(["amend", id, "--gates", "default"]);
  assert.equal(reads, 0);
  assert.equal(after.kind, "accepted");
  assert.equal(cleared.kind, "accepted");
  assert.equal(gated.kind, "accepted");
  assert.equal(after.kind === "accepted" && after.diff, "");
  assert.equal(cleared.kind === "accepted" && cleared.diff, "");
  assert.equal(gated.kind === "accepted" && gated.diff, "");
  const terms = (await observeContract(await repositoryAt(repository.path), id)).state?.terms;
  assert.deepEqual(terms?.after, []);
  assert.deepEqual(terms?.gates, ["reviewed"]);
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
  const terms = (await observeContract(await repositoryAt(repository.path), id)).state?.terms;
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

test("CLI amend preserves absent Region observations for non-Region operations", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("No amend Region observation"),
  );
  const id = acceptedContract(bound);
  const amended = await invokeWithDocument(
    repository.path,
    ["amend", id, "--actor", "external-test", "-"],
    "## Replace: Context\nNo Region read.\n",
  );
  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("expected accepted amend");
  assert.equal("overlaps" in amended, false);
  assert.equal("overlapFailure" in amended, false);
  assert.doesNotMatch(renderText(amended), /overlap/u);
});

test("amend accepts changed prerequisites after delivery and still rejects cycles", async () => {
  const repository = repositoryWithMain();
  const prerequisite = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Placement prerequisite"),
  );
  const prerequisiteId = acceptedContract(prerequisite);
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Amendable prerequisites"),
  );
  const id = acceptedContract(bound);
  const contract = Keiyaku.of({ repo: await Repo.at({ path: repository.path }), id });
  const delivered = await contract.deliver();
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver"]);

  const amended = await invokeWithDocument(
    repository.path,
    ["amend", id, "--after", prerequisiteId, "--actor", "external-test", "-"],
    "## Append: Context\nPlacement now waits for the prerequisite.\n",
  );
  assert.equal(amended.kind, "accepted");
  assert.deepEqual((await contract.state()).terms.after, [prerequisiteId]);
  const beforeCycle = await readRef(await repositoryAt(repository.path), GIT_REF);

  const selfDependent = await invokeWithDocument(
    repository.path,
    ["amend", id, "--after", id, "--actor", "external-test", "-"],
    "## Append: Context\nMust also refuse.\n",
  );
  assert.deepEqual(selfDependent, {
    kind: "refused",
    verb: "amend",
    contract: id,
    refusal: { kind: "cyclic-prerequisite", contractId: id },
  });
  assert.equal(await readRef(await repositoryAt(repository.path), GIT_REF), beforeCycle);
});

test("concurrent amend diff uses the accepted predecessor after a competing amend", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Concurrent original"),
  );
  const id = acceptedContract(bound);
  const contract = Keiyaku.of({ repo: await Repo.at({ path: repository.path }), id });
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
    gates: {
      default: { kind: "bundle", gates: ["reviewed"] },
      strict: { kind: "bundle", gates: ["verified", "reviewed"] },
      review: { kind: "bundle", gates: ["reviewed"] },
    },
  }));

  const result = await invokeWithDocument(
    repository.path,
    ["bind", "--gates", "strict,review", "--actor", "external-test", "-"],
    `${contractDocument("Gate Freeze")}## Verification\n\`\`\`bash\ntrue\n\`\`\`\n`,
  );

  assert.deepEqual(
    (await observeContract(await repositoryAt(repository.path), acceptedContract(result))).state?.terms?.gates,
    ["verified", "reviewed"],
  );
});

test("bind maps invalid gate bundle names from the Settings consumer to usage", async () => {
  const repository = repositoryWithMain();
  for (const names of ["Strict", "strict,review only", " ", "--strict"]) {
    await assert.rejects(
      () => invokeWithDocument(
        repository.path,
        ["bind", "--gates", names, "--actor", "external-test", "-"],
        contractDocument("Invalid Gate Bundle Name"),
      ),
      (error: unknown) => error instanceof CliUsageError
        && /gate bundle name must match/u.test(error.message),
    );
  }
});

test("amend freezes expanded plural gate bundles as concrete replacement terms", async () => {
  const repository = repositoryWithMain();
  writeFileSync(resolve(repository.path, ".keiyaku", "settings.json"), JSON.stringify({ gates: {
    default: { kind: "bundle", gates: ["reviewed"] },
    strict: { kind: "bundle", gates: ["verified", "reviewed"] },
    review: { kind: "bundle", gates: ["reviewed"] },
  } }));
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--actor", "external-test", "-"],
    `${contractDocument("Amend Gate Bundles")}## Verification\n\`\`\`bash\ntrue\n\`\`\`\n`,
  );
  const id = acceptedContract(bound);
  const amended = await invokeWithDocument(
    repository.path,
    ["amend", id, "--gates", "strict,review", "--actor", "external-test"],
    "",
  );
  assert.equal(amended.kind, "accepted");
  assert.deepEqual(
    (await observeContract(await repositoryAt(repository.path), id)).state?.terms.gates,
    ["verified", "reviewed"],
  );
});

test("bind defaults to reviewed unless a present default bundle overrides it", async () => {
  const missing = repositoryWithMain();
  writeFileSync(resolve(missing.path, ".keiyaku", "settings.json"), JSON.stringify({}));
  const home = mkdtempSync(join(tmpdir(), "keiyaku-empty-home-"));
  const implicit = await invokeWithDocument(
    missing.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Implicit Reviewed"),
    { KEIYAKU_HOME: home },
  );
  assert.deepEqual(
    (await observeContract(await repositoryAt(missing.path), acceptedContract(implicit))).state?.terms.gates,
    ["reviewed"],
  );
  rmSync(home, { recursive: true, force: true });

  const empty = repositoryWithMain();
  writeFileSync(resolve(empty.path, ".keiyaku", "settings.json"), JSON.stringify({ gates: {
    default: { kind: "bundle", gates: [] },
  } }));
  const overridden = await invokeWithDocument(
    empty.path,
    ["bind", "--actor", "external-test", "-"],
    contractDocument("Explicit Empty Default"),
  );
  assert.deepEqual(
    (await observeContract(await repositoryAt(empty.path), acceptedContract(overridden))).state?.terms.gates,
    [],
  );
});


test("managed delivery follows an eligible deterministic worktree", async () => {
  const repository = repositoryWithMain();
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--target", "main", "--actor", "external-test", "-"],
    contractDocument("Managed Worktree"),
  );
  const id = acceptedContract(bound);
  const path = await appointedWorktreePath(await repositoryAt(repository.path), id);
  const managedRepository = await repositoryAt(path);
  assert.equal(managedRepository.effectiveCwd, path);
  assert.equal(managedRepository.primaryWorktree, (await repositoryAt(repository.path)).primaryWorktree);
  const fromManaged = (argv: readonly string[], source = "") => invoke(
    parseArgv(["-C", path, ...argv]),
    { environment: {}, readStdin: () => source },
  );
  assert.equal(await appointedWorktreePath(managedRepository, id), path);
  assert.notEqual(path, resolve(path, ".keiyaku-v4", "worktrees", "managed-worktree"));
  assert.match(path, /[\\/]keiyaku[\\/]wt[\\/]/u);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "managed candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();

  const deliver = await fromManaged(["deliver", "--actor", "external-test"]);
  assert.equal(deliver.kind, "accepted");
  const state = (await observeContract(await repositoryAt(repository.path), id)).state;
  assert.equal(state?.delivery?.data.tenderSnapshot, candidate);
  assert.equal(await readRef(await repositoryAt(repository.path), candidatePinRefFor(id)), state?.delivery?.data.integration.snapshot);
  assert.equal(await readRef(await repositoryAt(repository.path), deliveryRefFor(id)), candidate);
  const audit = await fromManaged(["audit"]);
  assert.equal(audit.kind, "accepted");
  if (audit.kind !== "accepted") throw new Error("audit was not accepted");
  assert.equal(audit.report?.candidate.kind, "ready");
  assert.equal(audit.report?.verification.kind, "not-run");
  assert.equal(audit.report?.target.kind, "placeable");

  repository.run(["-C", path, "reset", "--hard", target]);
  const reconcileRepository = await repositoryAt(repository.path);
  const appointment = await readManagedWorktreeAppointment(reconcileRepository, id);
  const reconciled = await withGitDecodeChannel(reconcileRepository, (channel) => reconcile({
    repository: reconcileRepository,
    channel,
    contractId: id,
    hooks: { create: [], destroy: [] },
    retryHooks: false,
    ...(appointment.kind === "appointed" ? { place: appointment.place } : {}),
  }));
  assert.equal(reconciled.result.effects.some((effect) => effect.kind === "worktree" && effect.action === "followed" && effect.before === target && effect.after === candidate), true);
  assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), candidate);

  const satisfiedReview = await fromManaged(["review", id, "--satisfied", "--summary", "accepted", "--actor", "external-test"]);
  assert.equal(satisfiedReview.kind, "accepted");
  assert.equal("lag" in satisfiedReview, false);
  assert.equal(await readRef(await repositoryAt(repository.path), deliveryRefFor(id)), null);
  assert.equal(await readRef(await repositoryAt(repository.path), candidatePinRefFor(id)), null);
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
  const path = await appointedWorktreePath(await repositoryAt(repository.path), id);
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
    ["bind", "--target", "main", "--actor", "external-test", "-"],
    contractDocument("Managed Abandonment"),
  );
  const id = acceptedContract(bound);

  const path = await appointedWorktreePath(await repositoryAt(repository.path), id);
  const fromManaged = (argv: readonly string[], source = "") => invoke(
    parseArgv(["-C", path, ...argv]),
    { environment: {}, readStdin: () => source },
  );
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "managed candidate"]);
  const delivered = await fromManaged(["deliver", "--actor", "external-test"]);
  assert.equal(delivered.kind, "accepted");
  assert.equal(await readRef(await repositoryAt(repository.path), deliveryRefFor(id)) !== null, true);
  assert.equal(await readRef(await repositoryAt(repository.path), candidatePinRefFor(id)) !== null, true);

  const abandoned = await fromManaged([
    "abandon", id, "--note", "scope changed", "--actor", "external-test",
  ]);
  assert.equal(abandoned.kind, "accepted");
  assert.equal("lag" in abandoned, false);
  assert.equal((await observeContract(await repositoryAt(repository.path), id)).state?.terminal?.kind, "abandoned");
  assert.equal((await observeContract(await repositoryAt(repository.path), id)).state?.terminal?.data.note, "scope changed");
  assert.equal(await readRef(await repositoryAt(repository.path), deliveryRefFor(id)) !== null, true);
  assert.equal(
    await readRef(await repositoryAt(repository.path), candidatePinRefFor(id)),
    (await observeContract(await repositoryAt(repository.path), id)).state?.delivery?.data.integration.snapshot,
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
  const path = await appointedWorktreePath(await repositoryAt(repository.path), id);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "retained candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  const delivered = await invoke(parseArgv(["-C", path, "deliver", id, "--actor", "external-test"]), {
    environment: {},
  });
  assert.equal(delivered.kind, "accepted");
  const state = (await observeContract(await repositoryAt(repository.path), id)).state;

  const abandoned = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
      '  printf "worktree became busy\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    (gitPath) => invoke(parseArgv(["-C", path, "abandon", id, "--actor", "external-test"]), {
      environment: { KEIYAKU_GIT_PATH: gitPath },
    }),
  );

  assert.equal(abandoned.kind, "accepted");
  if (abandoned.kind !== "accepted") return;
  assert.deepEqual(abandoned.lag, [{ kind: "worktree-retained", path }]);
  assert.equal(existsSync(path), true);
  assert.equal(await readRef(await repositoryAt(repository.path), deliveryRefFor(id)), state?.delivery?.data.tenderSnapshot);
  assert.equal(await readRef(await repositoryAt(repository.path), candidatePinRefFor(id)), state?.delivery?.data.integration.snapshot);
});

test("reconcile world command adapts the public repository report", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(repository.path, ["bind", "-"], contractDocument("Reconcile world"));
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") return;

  const result = await invoke(parseArgv(["reconcile"]), {
    cwd: repository.path,
    environment: {},
  });
  assert.equal(result.kind, "observation");
  if (result.kind !== "observation") return;
  assert.equal(result.command, "reconcile");
  assert.equal("contracts" in result, false);
  const report = result.report as { kind?: string; contracts?: readonly unknown[] };
  assert.equal(report.kind, "completed");
  assert.ok(Array.isArray(report.contracts));
  assert.equal(report.contracts.length, 1);
  const json = JSON.parse(JSON.stringify(result)) as { kind: string; command: string; report: { kind: string } };
  assert.equal(json.kind, "observation");
  assert.equal(json.command, "reconcile");
  assert.equal(json.report.kind, "completed");
  assert.match(renderText(result), /^observation reconcile\n/u);
  assert.doesNotMatch(renderText(result), /world observation failed/u);
});

test("reconcile world command reports an empty completed world", async () => {
  const repository = repositoryWithMain();
  const result = await invoke(parseArgv(["reconcile"]), {
    cwd: repository.path,
    environment: {},
  });
  assert.deepEqual(result, {
    kind: "observation",
    command: "reconcile",
    report: { kind: "completed", contracts: [] },
  });
  assert.equal(renderText(result).includes("world observation failed"), false);
});

test("reconcile world command carries a typed discovery failure", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(repository.path, ["bind", "-"], contractDocument("Reconcile discovery"));
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") return;
  const captured = await withGitShim(
    [
      `if [ "$*" = "rev-parse --verify --quiet ${GIT_REF}" ]; then`,
      '  printf "forced world observation failure\\n" >&2',
      "  exit 128",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      const result = await invoke(parseArgv(["reconcile"]), {
        cwd: repository.path,
        environment: { KEIYAKU_GIT_PATH: gitPath },
      });
      const env = { ...process.env, KEIYAKU_GIT_PATH: gitPath, NO_COLOR: "1" };
      delete env.FORCE_COLOR;
      const run = (args: readonly string[]) => spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), resolve(import.meta.dirname, "../src/cli/index.ts"), ...args],
        { encoding: "utf8", env },
      );
      return {
        result,
        text: run(["-C", repository.path, "reconcile"]),
        json: run(["-C", repository.path, "reconcile", "--json"]),
      };
    },
  );
  assert.equal(captured.result.kind, "observation");
  if (captured.result.kind !== "observation") return;
  const report = captured.result.report as { kind?: string; diagnostic?: string; contracts?: unknown };
  assert.equal(report.kind, "world-observation-failed");
  assert.equal("contracts" in report, false);
  assert.match(String(report.diagnostic), /forced world observation failure/u);
  assert.equal(renderText(captured.result), `reconcile: world observation failed · ${report.diagnostic}`);
  const json = JSON.parse(JSON.stringify(captured.result)) as {
    kind: string;
    command: string;
    report: { kind: string; diagnostic: string };
  };
  assert.equal(json.kind, "observation");
  assert.equal(json.command, "reconcile");
  assert.equal(json.report.kind, "world-observation-failed");
  assert.equal(json.report.diagnostic, report.diagnostic);
  assert.equal(captured.text.status, 1);
  assert.equal(captured.json.status, 1);
  assert.equal(captured.text.stdout.trim(), renderText(captured.result));
  const jsonOutput = JSON.parse(captured.json.stdout) as {
    kind: string;
    command: string;
    report: { kind: string; diagnostic: string };
  };
  assert.equal(jsonOutput.kind, "observation");
  assert.equal(jsonOutput.command, "reconcile");
  assert.equal(jsonOutput.report.kind, "world-observation-failed");
  assert.equal(jsonOutput.report.diagnostic, report.diagnostic);
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

test("blank acquired stdin is usage before World, Repo, or package invocation", async () => {
  const missing = "/absent/keiyaku-blank-stdin";
  const cases: ReadonlyArray<readonly [argv: readonly string[], stdin: string, pattern: RegExp]> = [
    [["bind", "-"], " \n\t", /bind requires a nonblank stdin document/],
    [["amend", "kei/example", "-"], "", /amend requires a nonblank stdin document/],
    [["arc", "kei/example", "-"], "\u00a0", /arc requires a nonblank stdin document/],
    [["review", "--satisfied", "-"], "  ", /review requires a nonblank summary/],
    [["call", "worker", "-"], "\n", /call requires a nonblank prompt/],
    [["tell", "aku/claude/1234abcd", "-"], " ", /tell requires a nonblank prompt/],
    [["task", "add", "-"], "\t", /task add requires a nonblank stdin document/],
    [["task", "compose", "-"], "", /task compose requires a nonblank stdin document/],
    [["task", "update", "task/example", "--body", "-"], "   ", /task update --body requires a nonblank value/],
    [["task", "update", "task/example", "--append", "-"], "\n", /task update --append requires a nonblank value/],
    [["task", "update", "task/example", "--note", "-"], " ", /task update --note requires a nonblank value/],
  ];
  for (const [argv, stdin, pattern] of cases) {
    await assert.rejects(
      () => invoke(parseArgv(argv), { cwd: missing, environment: {}, readStdin: () => stdin }),
      (error: unknown) => error instanceof CliUsageError
        && pattern.test(error.message)
        && !/invocation cwd is not an existing directory/u.test(error.message),
    );
  }
});

test("history kei/... reads Contract history through Repo without an Akuma World", async () => {
  const repository = repositoryWithMain();
  const bound = await invokeWithDocument(repository.path, ["bind", "-"], contractDocument("History Route"));
  const id = acceptedContract(bound);
  const expected = await Keiyaku.of({ repo: await Repo.at({ path: repository.path }), id }).history();
  const foreign = makeGitRepository();
  foreign.run(["config", "user.name", "Test User"]);
  foreign.run(["config", "user.email", "test@example.com"]);
  foreign.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  foreign.run(["commit", "--allow-empty", "--quiet", "-m", "foreign"]);
  const result = await invoke(parseArgv(["--repo", repository.path, "history", id]), {
    cwd: foreign.path,
    environment: {},
  });
  assert.deepEqual(result, { kind: "contract-history", history: expected });
  assert.equal(existsSync(resolve(foreign.path, ".keiyaku")), false);
  const missing = await invoke(parseArgv(["history", "kei/missing-history"]), {
    cwd: repository.path,
    environment: {},
  });
  assert.deepEqual(missing, {
    kind: "refused",
    verb: "history",
    contract: "kei/missing-history",
    refusal: { kind: "contract-missing", contractId: "kei/missing-history" },
  });

  await assert.rejects(
    () => invoke(parseArgv(["history", "aku/claude/1234abcd"]), { cwd: foreign.path, environment: {} }),
    (error: unknown) => error instanceof HeartAbsentError,
  );
  const empty = mkdtempSync(join(tmpdir(), "keiyaku-history-norepo-"));
  await assert.rejects(
    () => invoke(parseArgv(["history", "aku/claude/1234abcd"]), { cwd: empty, environment: {} }),
    (error: unknown) => error instanceof CliUsageError
      && /no Keiyaku world contains the invocation cwd/u.test(error.message),
  );
  await assert.rejects(
    () => invoke(parseArgv(["history", id]), { cwd: empty, environment: {} }),
    (error: unknown) => error instanceof NoGitWorldError,
  );
});

test("valid acquired stdin bytes pass through unchanged", async () => {
  const repository = repositoryWithMain();
  const source = `  \n${contractDocument("Keep Bytes")}\n`;
  const bound = await invokeWithDocument(repository.path, ["bind", "-"], source);
  const id = acceptedContract(bound);
  assert.equal((await observeContract(await repositoryAt(repository.path), id)).state?.terms?.document.bytes, source);
});

async function conflictedDeliverCommand() {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "shared.txt"), "base\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "base"]);
  const bound = await invokeWithDocument(
    repository.path,
    ["bind", "--target", "refs/heads/main", "--actor", "external-test", "-"],
    contractDocument("Conflicted delivery"),
  );
  const id = acceptedContract(bound);
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), id);
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  const command = (argv: readonly string[]) => invoke(
    parseArgv(["-C", worktree, ...argv]),
    { environment: {}, readStdin: () => "" },
  );
  return { repository, id, worktree, targetHead, command };
}

test("deliver conflict JSON and text expose recovery without mutating the workspace", async () => {
  const { repository, id, worktree, targetHead, command } = await conflictedDeliverCommand();
  const result = await command(["deliver", "--actor", "external-test"]);
  assert.deepEqual(result, {
    kind: "refused",
    verb: "deliver",
    contract: id,
    refusal: {
      kind: "integration-failed",
      contractId: id,
      reason: "conflict",
      targetHead,
      conflictPaths: ["shared.txt"],
      recovery: { materialize: "deliver --materialize-conflict", continue: "deliver" },
    },
  });
  const text = renderText(result);
  assert.match(text, /reason=conflict/u);
  assert.match(text, /recovery materialize conflicts · deliver --materialize-conflict/u);
  assert.match(text, /recovery continue after resolve and commit · deliver/u);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).refusal.recovery, {
    materialize: "deliver --materialize-conflict",
    continue: "deliver",
  });
  assert.throws(() => repository.run(["-C", worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"]));
});

test("deliver --materialize-conflict returns the exact public materialization object", async () => {
  const { repository, id, worktree, targetHead, command } = await conflictedDeliverCommand();
  const result = await command(["deliver", "--materialize-conflict", "--actor", "external-test"]);
  assert.deepEqual(result, {
    kind: "integration-conflict-materialized",
    targetHead,
    conflictPaths: ["shared.txt"],
    workspace: { kind: "worktree", path: worktree },
  });
  assert.equal(repository.run(["-C", worktree, "rev-parse", "MERGE_HEAD"]).trim(), targetHead);
  const text = renderText(result);
  assert.match(text, /integration-conflict-materialized targetHead=/u);
  assert.match(text, /workspace worktree /u);
  const json = JSON.parse(JSON.stringify(result));
  assert.equal(json.kind, "integration-conflict-materialized");
  assert.equal(json.targetHead, targetHead);
  assert.deepEqual(json.conflictPaths, ["shared.txt"]);
  assert.deepEqual(json.workspace, { kind: "worktree", path: worktree });
  const state = (await observeContract(await repositoryAt(repository.path), id)).state;
  assert.equal(state?.delivery, null);
  assert.equal(state?.terminal, null);
});
