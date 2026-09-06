import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createTwoFilesPatch } from "diff";
import {
  bodyRequestExecution,
  Keiyaku,
  KeiyakuRefused,
  Repo,
  type ContractId,
  type IntegrationConflictMaterialized,
  type MutationResult,
} from "../src/index.js";
import { contractId, documentKey } from "../src/core/facts/types.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { repositoryAt } from "../src/git/repository.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { bindOperation } from "../src/protocol/bind.js";
import { makeGitRepository } from "./support/git.js";

const root = process.cwd();

type ContractHandle = Pick<Keiyaku, "state">;

async function publicContractId(handle: ContractHandle): Promise<ContractId> {
  return (await handle.state()).id;
}

function expectMutation<Value>(result: MutationResult<Value> | IntegrationConflictMaterialized): MutationResult<Value> {
  if (result.kind !== "accepted") throw new Error("expected an admitted mutation result");
  return result;
}

function externalConsumer(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-consumer-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "node_modules", "@astrosheep"), { recursive: true });
  symlinkSync(root, join(directory, "node_modules", "@astrosheep", "keiyaku"), "dir");
  writeFileSync(join(directory, "package.json"), '{"type": "module"}\n');
  return directory;
}

function markdown(title = "Boundary", verification?: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "context",
    "",
    "## Objective",
    "objective",
    "",
    "## Design",
    "design",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### C1",
    "criterion",
    ...(verification === undefined ? [] : ["", "## Verification", "~~~bash", verification, "~~~"]),
    "",
  ].join("\n");
}

function repositoryWithInitialCommit() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

test("built package supports Contract, Task, Kanshi and plugin consumers", (context) => {
  const directory = externalConsumer(context);
  mkdirSync(join(directory, "node_modules", "@types"), { recursive: true });
  symlinkSync(
    join(root, "plugins", "square"),
    join(directory, "node_modules", "@astrosheep", "keiyaku-plugin-square"),
    "dir",
  );
  symlinkSync(join(root, "node_modules", "@types", "node"), join(directory, "node_modules", "@types", "node"), "dir");
  symlinkSync(join(root, "node_modules", "undici-types"), join(directory, "node_modules", "undici-types"), "dir");
  const examples = ["contract", "task", "kanshi", "plugin"].map((name) => name + ".ts");
  for (const example of examples) {
    copyFileSync(join(root, "tests", "fixtures", "consumers", example), join(directory, example));
  }
  const checked = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--preserveSymlinks",
      ...examples,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const loaded = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import assert from "node:assert/strict";',
        'import { createRequire } from "node:module";',
        'import plugin from "@astrosheep/keiyaku-plugin-square";',
        'assert.equal(plugin.manifest.id, "square");',
        'assert.equal(typeof plugin.activate, "function");',
        'assert.ok(createRequire(import.meta.url).resolve("@astrosheep/keiyaku-plugin-square").endsWith("index.js"));',
      ].join("\n"),
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(loaded.status, 0, loaded.stderr);
});

test("package exports reject deep internal imports", (context) => {
  const directory = externalConsumer(context);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", 'await import("@astrosheep/keiyaku/build/src/core/facts/types.js")'],
        { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
      ),
    (error: unknown) => {
      const value = error as { stderr?: Buffer };
      return value.stderr?.toString("utf8").includes("ERR_PACKAGE_PATH_NOT_EXPORTED") === true;
    },
  );
});

test("built CLI bin keeps its shebang and executes through an installed-style symlink", () => {
  const repository = repositoryWithInitialCommit();
  const bin = join(root, "build", "src", "cli", "index.js");
  const linkDirectory = mkdtempSync(join(tmpdir(), "keiyaku-v4-bin-"));
  const link = join(linkDirectory, "keiyaku");
  assert.equal(readFileSync(bin, "utf8").split("\n", 1)[0], "#!/usr/bin/env node");
  assert.notEqual(statSync(bin).mode & 0o111, 0, "build must make the CLI entry executable");
  symlinkSync(bin, link);
  const output = execFileSync(link, ["status", "--json"], { cwd: repository.path, encoding: "utf8" });
  assert.equal(JSON.parse(output).contracts.kind, "present");
});

test("package-root observe and list carry managed workspace observations", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = await Repo.at({ path: repository.path });
  const bound = await Keiyaku.bind({ repo, markdown: markdown("Managed workspace"), workspace: "worktree" });
  const state = await bound.keiyaku.state();
  const boundId = state.id;
  assert.equal(state.terms.document.bytes, markdown("Managed workspace"));
  const guidance = await bound.keiyaku.guidance();
  const appointment = await readManagedWorktreeAppointment(await repositoryAt(repository.path), boundId);
  assert.equal(appointment.kind, "appointed");
  if (appointment.kind !== "appointed") throw new Error("expected a managed worktree");
  assert.equal(readFileSync(join(appointment.path, ".keiyaku", "KEIYAKU.md"), "utf8"), guidance);
  for (const seat of ["deliver", "review"]) {
    assert.match(readFileSync(join(appointment.path, ".agents", "skills", `keiyaku-${seat}`, "SKILL.md"), "utf8"),
      new RegExp(`^---\\nname: keiyaku-${seat}$`, "m"));
  }

  const observed = await Keiyaku.observe({ repo, id: boundId });
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") return;
  const listed = await Keiyaku.list({ repo });
  const listedRow = listed.rows.find((row) => row.id === boundId);

  assert.equal(typeof observed.row.worktreePath, "string");
  assert.equal(listedRow?.workspaceObservation.kind, "clean");
});

test("bind canonicalizes branch targets and refuses invalid names before birth", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = await Repo.at({ path: repository.path });
  const bound = await Keiyaku.bind({ repo, markdown: markdown("Short target"), target: "main", workspace: "worktree" });
  assert.equal((await bound.keiyaku.state()).coordinates.target, "refs/heads/main");

  const gitBefore = repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim();
  for (const target of ["bad..name", "keiyaku-state", "refs/tags/main"]) {
    await assert.rejects(
      Keiyaku.bind({ repo, markdown: markdown("Invalid target"), target, workspace: "worktree" }),
      (error: unknown) => error instanceof KeiyakuRefused && error.code === "invalid-target",
    );
    assert.equal(repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim(), gitBefore);
  }

  await assert.rejects(
    Keiyaku.bind({ repo, markdown: markdown("Missing target"), target: "missing", workspace: "worktree" }),
    (error: unknown) => error instanceof KeiyakuRefused && error.code === "target-missing",
  );
  assert.equal(repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim(), gitBefore);
  assert.equal(repository.run(["for-each-ref", "--format=%(refname)", "refs/heads/missing"]), "");
});

test("omitted public bind remains targetless on an attached HEAD", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = await Repo.at({ path: repository.path });
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  const bound = await Keiyaku.bind({ repo, markdown: markdown("Public targetless"), workspace: "worktree" });
  const state = await bound.keiyaku.state();
  assert.equal(state.coordinates.target, undefined);
  assert.equal(state.coordinates.start, start);
});

test("targetless bind refuses an unborn HEAD without publishing effects", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  await assert.rejects(
    Keiyaku.bind({ repo, markdown: markdown("Unborn targetless"), workspace: "worktree" }),
    (error: unknown) => error instanceof KeiyakuRefused && error.code === "unborn-head",
  );
  assert.equal(repository.run(["for-each-ref", "--format=%(refname)", "refs/heads/keiyaku-state"]), "");
  assert.deepEqual((await Keiyaku.list({ repo })).rows, []);
});

test("public amend rejects a transitive prerequisite cycle without moving its head", async () => {
  const repo = await Repo.at({ path: repositoryWithInitialCommit().path });
  const prerequisite = await Keiyaku.bind({ repo, markdown: markdown("Prerequisite"), workspace: "worktree" });
  const prerequisiteId = (await prerequisite.keiyaku.state()).id;

  const amended = await Keiyaku.bind({
    repo,
    markdown: markdown("Amended"),
    workspace: "worktree",
    after: [prerequisiteId],
  });
  const amendedId = (await amended.keiyaku.state()).id;

  const dependent = await Keiyaku.bind({
    repo,
    markdown: markdown("Dependent"),
    workspace: "worktree",
    after: [amendedId],
  });
  const dependentId = (await dependent.keiyaku.state()).id;
  const head = (await amended.keiyaku.state()).head;

  await assert.rejects(
    amended.keiyaku.amend({ markdown: "## Append: Context\ncycle\n", after: [dependentId] }),
    (error: unknown) =>
      error instanceof KeiyakuRefused &&
      assert.deepEqual(error.refusal, { kind: "cyclic-prerequisite", contractId: amendedId }) === undefined,
  );
  assert.equal((await amended.keiyaku.state()).head, head);
});

test("amend applies Markdown once and preserves structured values unless replaced", async () => {
  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: markdown("Amend input"),
    workspace: "worktree",
  });

  await assert.rejects(
    bound.keiyaku.amend({ markdown: "## Append: Context\ninvalid gate\n", gates: ["Edge-owned"] }),
    (error: unknown) => error instanceof TypeError && error.message === "gates[0] must match ^[a-z][a-z0-9-]{0,63}$",
  );
  await assert.rejects(
    bound.keiyaku.amend({ actor: "operator" }),
    (error: unknown) => error instanceof TypeError && error.message === "amend requires markdown, after, or gates",
  );

  await bound.keiyaku.amend({
    markdown: ["## Replace: Verification", "~~~bash", "exit 0", "~~~", ""].join("\n"),
    gates: ["verified"],
  });
  const beforePreserved = await bound.keiyaku.state();
  assert.deepEqual(beforePreserved.terms.gates, ["verified"]);

  const preserved = await bound.keiyaku.amend({
    markdown: ["## Append: Context", "more context", ""].join("\n"),
    after: [],
  });
  const state = await bound.keiyaku.state();
  assert.equal(
    preserved.documentDiff,
    createTwoFilesPatch("before", "after", beforePreserved.terms.document.bytes, state.terms.document.bytes, "", "", {
      context: 3,
    }),
  );
  assert.deepEqual(state.terms.after, []);
  assert.deepEqual(state.terms.gates, ["verified"]);
  assert.match(state.terms.document.bytes, /context\n\nmore context\n/);
});

test("arc decodes its Markdown input and worktree paths are computed", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = await Repo.at({ path: repository.path });
  const arcInput = await Keiyaku.bind({ repo, markdown: markdown("Arc input"), workspace: "worktree" });
  await arcInput.keiyaku.arc({
    markdown: ["# Chapter", "", "## Objective", "advance", "", "## Brief", "dispatch", ""].join("\n"),
  });
  assert.equal((await arcInput.keiyaku.state()).currentArc?.data.seq, 1);

  const managed = await Keiyaku.bind({ repo, markdown: markdown("Managed"), workspace: "worktree" });
  const status = await Keiyaku.list({ repo });
  const managedState = await managed.keiyaku.state();
  assert.equal(typeof status.rows.find((contract) => contract.id === managedState.id)?.worktreePath, "string");
});

async function occupyContract(repositoryPath: string, id: ContractId) {
  const git = await repositoryAt(repositoryPath);
  const occupied = await withGitDecodeChannel(git, (channel) =>
    bindOperation({
      scope: git,
      channel,
      contractId: id,
      terms: {
        document: { bytes: "# Occupied\n", key: documentKey("occupied") },
        segments: [],
        gates: [],
        after: [],
      },
      verification: { kind: "prepared", data: null },
      workspace: "worktree",
    }),
  );
  assert.equal(occupied.kind, "accepted");
}

test("library bind retries a colliding title stem with a hexadecimal suffix", async () => {
  const repository = repositoryWithInitialCommit();
  await occupyContract(repository.path, contractId("kei/collision-title"));
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: markdown("Collision title"),
    workspace: "worktree",
  });
  assert.match((await bound.keiyaku.state()).id, /^kei\/collision-title-[0-9a-f]{16}$/);
});

test("a non-collision refusal stops after the first candidate and releases its reservation", async () => {
  const repository = repositoryWithInitialCommit();
  const appointment = resolve(repository.path, ".keiyaku", "KEIYAKU.md");
  await assert.rejects(
    Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: markdown("Stop after refusal"),
      workspace: "worktree",
      after: ["kei/missing-prerequisite" as ContractId],
    }),
    (error: unknown) =>
      error instanceof KeiyakuRefused &&
      error.refusal.kind === "unknown-prerequisite" &&
      error.refusal.contractId === "kei/stop-after-refusal",
  );
  assert.equal(existsSync(appointment), false);
});

test("ordinary review retains its complete local mutation result without a request channel", async () => {
  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: markdown("Local review"),
    workspace: "worktree",
    gates: ["reviewed"],
  });

  const result = await bound.keiyaku.review({ verdict: "unsatisfied", summary: "needs work" });

  const attestation = result.facts.find((fact) => fact.kind === "attestation");
  assert.equal(attestation?.kind, "attestation");
  assert.equal(attestation?.data.verdict, "unsatisfied");
  assert.equal((await bound.keiyaku.state()).attestations.at(-1)?.data.summary, "needs work");
});

test("local execution composition reaches Contract handles from bind and of", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = await Repo.at({ path: repository.path });
  const composed = Keiyaku.withLocal({
    actor: "local-composition",
    hooks: { create: [], destroy: [] },
    requireBranchesToBeUpToDate: true,
  });
  const reviewed = await composed.bind({ repo, markdown: markdown("Composed review"), workspace: "worktree" });
  const reviewedId = await publicContractId(reviewed.keiyaku);
  await reviewed.keiyaku.review({ verdict: "satisfied", summary: "bound handle" });
  await composed.of({ repo, id: reviewedId }).review({ verdict: "unsatisfied", summary: "of handle" });
  assert.deepEqual(
    (await reviewed.keiyaku.state()).attestations.slice(-2).map((attestation) => attestation.actor),
    ["local-composition", "local-composition"],
  );

  const delivered = await composed.bind({ repo, markdown: markdown("Composed delivery"), workspace: "worktree" });
  const deliveredId = await publicContractId(delivered.keiyaku);
  const appointment = await readManagedWorktreeAppointment(await repositoryAt(repository.path), deliveredId);
  if (appointment.kind !== "appointed") throw new Error("expected appointed worktree");
  writeFileSync(join(appointment.path, "candidate.txt"), "candidate\n");
  repository.run(["-C", appointment.path, "add", "candidate.txt"]);
  repository.run(["-C", appointment.path, "commit", "--quiet", "-m", "candidate"]);
  const result = expectMutation(await delivered.keiyaku.deliver());
  assert.equal(result.value.policy.requireBranchesToBeUpToDate, true);
  assert.equal((await delivered.keiyaku.state()).delivery?.actor, "local-composition");

  const body = bodyRequestExecution({ directory: "/tmp/keiyaku-requests" });
  assert.throws(
    () => Keiyaku.withExecution({ execution: { ...body, contract: { actor: "not-forwarded" } } as never }),
    /execution has unknown field: contract/u,
  );
});

test("Delivery.diff remains a nullable Promise-backed Git read", async () => {
  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: markdown("Diff input"),
    workspace: "worktree",
  });
  const boundId = await publicContractId(bound.keiyaku);
  const appointment = await readManagedWorktreeAppointment(await repositoryAt(repository.path), boundId);
  if (appointment.kind !== "appointed") throw new Error("expected appointed worktree");
  writeFileSync(join(appointment.path, "candidate.txt"), "candidate\n");
  repository.run(["-C", appointment.path, "add", "candidate.txt"]);
  repository.run(["-C", appointment.path, "commit", "--quiet", "-m", "candidate"]);
  const delivered = expectMutation(await bound.keiyaku.deliver());
  const diff = await delivered.value.diff();
  assert.equal(typeof diff, "string");
  if (diff === null) throw new Error("missing delivery diff");
  assert.match(diff, /candidate\.txt/);
});
