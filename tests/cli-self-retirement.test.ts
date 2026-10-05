import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { makeGitRepository } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";
import { removeTempDirectory } from "./support/process.js";

const compiled = import.meta.url.endsWith(".js");
/** Compiled test files resolve repository coordinates through the `.test-build` seam. */
const repositoryRoot = resolve(import.meta.dirname, compiled ? "../.." : "..");
const repositoryCli = resolve(repositoryRoot, "build/src/cli/index.js");
/** The build tree a managed worktree holds when a developer built inside that worktree. */
const repositoryBuild = resolve(repositoryRoot, "build");
const repositoryModules = realpathSync(resolve(repositoryRoot, "node_modules"));

const CONTRACT_MARKDOWN = contractMarkdown("Self retirement receipt", {
  Context: "The CLI executes from inside the managed worktree its own review retires.",
  Objective: "The accepted result survives retirement of its own executable tree.",
  Design: "The invocation acquires its projection abilities before mutable product work.",
  Region: "src/**",
  Criteria: "### Receipt survives\nThe accepted receipt is emitted once.",
});

/**
 * A caller running inside an Akuma Body inherits that request channel; this fixture
 * must execute the local CLI rather than forward to an ambient parent Body.
 */
function fixtureEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment[AKUMA_REQUESTS_ENV];
  return environment;
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

type CliChild = Readonly<{ exit: number; stdout: string; stderr: string }>;

/** Spawn one fixture CLI child with retained handles; the caller awaits its natural close. */
function runFixtureCli(cli: string, cwd: string, args: readonly string[]): Promise<CliChild> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: fixtureEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", rejectChild);
    child.once("close", (code) => resolveChild({ exit: code ?? 1, stdout, stderr }));
  });
}

type SelfRetirementFixture = Readonly<{
  root: string;
  world: string;
  contract: string;
  worktree: string;
  /** The compiled CLI living inside the worktree its own review retires. */
  cli: string;
}>;

function selfRetirementFixture(context: TestContext): SelfRetirementFixture {
  const world = makeGitRepository();
  const root = mkdtempSync(join(tmpdir(), "keiyaku-self-retirement-"));
  context.after(() => removeTempDirectory(root));
  writeFileSync(join(world.path, ".gitignore"), "build/\nnode_modules\n");
  world.run(["add", ".gitignore"]);
  world.run(["commit", "--quiet", "-m", "initial"]);

  const bound = spawnSync(
    process.execPath,
    [repositoryCli, "-C", world.path, "bind", "--target", "refs/heads/main", "--gates", "reviewed", "--json", "-"],
    { input: CONTRACT_MARKDOWN, encoding: "utf8", env: fixtureEnvironment() },
  );
  assert.equal(bound.status, 0, bound.stderr);
  const binding = JSON.parse(bound.stdout) as {
    kind: string;
    contract: string;
    value: { workspace: { path: string } };
  };
  assert.equal(binding.kind, "accepted");
  const worktree = binding.value.workspace.path;

  cpSync(repositoryBuild, join(worktree, "build"), { recursive: true, dereference: true });
  symlinkSync(repositoryModules, join(worktree, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  runGit(worktree, ["add", "candidate.txt"]);
  runGit(worktree, ["commit", "--quiet", "-m", "candidate"]);
  return {
    root,
    world: world.path,
    contract: binding.contract,
    worktree,
    cli: join(worktree, "build/src/cli/index.js"),
  };
}

function deliveredText(fixture: SelfRetirementFixture): Promise<CliChild> {
  return runFixtureCli(fixture.cli, fixture.worktree, ["deliver", fixture.contract]);
}

test("an ordinary non-retiring operation keeps its receipt, exit, and worktree", async (context) => {
  const fixture = selfRetirementFixture(context);
  const delivered = await deliveredText(fixture);
  assert.equal(delivered.exit, 0, delivered.stderr);
  assert.equal(delivered.stderr, "");
  assert.match(delivered.stdout, /^✓ delivered  kei\//mu);
  assert.equal((delivered.stdout.match(/^✓ delivered /gmu) ?? []).length, 1, "one final receipt");
  assert.equal(existsSync(fixture.worktree), true);

  const history = await runFixtureCli(fixture.cli, fixture.worktree, ["history", fixture.contract, "--full"]);
  assert.equal(history.exit, 0, history.stderr);
  assert.match(history.stdout, /deliver/u);
  assert.doesNotMatch(history.stdout, /claimed/u, "a delivery is not a terminal claim");
});

test("a worktree-local compiled CLI reports its accepted self-retirement in text", async (context) => {
  const fixture = selfRetirementFixture(context);
  const delivered = await deliveredText(fixture);
  assert.equal(delivered.exit, 0, delivered.stderr);

  const reviewed = await runFixtureCli(fixture.cli, fixture.worktree, [
    "review",
    fixture.contract,
    "--satisfied",
    "--summary",
    "accepted by the fixture",
  ]);
  assert.equal(reviewed.exit, 0, reviewed.stderr);
  assert.equal(reviewed.stderr, "");
  assert.match(reviewed.stdout, /^✓ review satisfied  kei\//mu);
  assert.equal((reviewed.stdout.match(/^✓ review satisfied /gmu) ?? []).length, 1, "one truthful final receipt");
  assert.match(reviewed.stdout, /^✓ accepted$/mu);
  assert.match(reviewed.stdout, new RegExp(`^  worktree  ${basename(fixture.worktree)} retired$`, "mu"));
  assert.equal(existsSync(fixture.worktree), false, "terminal cleanup retired the executing worktree");

  const history = await runFixtureCli(repositoryCli, fixture.world, ["history", fixture.contract, "--full"]);
  assert.equal(history.exit, 0, history.stderr);
  assert.match(history.stdout, /gate  reviewed/u);
  assert.match(history.stdout, /verdict  satisfied/u);
  assert.match(history.stdout, /claimed/u);
});

test("a worktree-local compiled CLI reports its accepted self-retirement in JSON", async (context) => {
  const fixture = selfRetirementFixture(context);
  const delivered = await deliveredText(fixture);
  assert.equal(delivered.exit, 0, delivered.stderr);

  const reviewed = await runFixtureCli(fixture.cli, fixture.worktree, [
    "review",
    fixture.contract,
    "--satisfied",
    "--summary",
    "accepted by the fixture",
    "--json",
  ]);
  assert.equal(reviewed.exit, 0, reviewed.stderr);
  assert.equal(reviewed.stderr, "");
  const body = JSON.parse(reviewed.stdout) as {
    kind: string;
    operation: string;
    contract: string;
    effects: readonly { kind: string; name?: string }[];
    facts: readonly { kind: string }[];
  };
  assert.equal(body.kind, "accepted");
  assert.equal(body.operation, "review");
  assert.equal(body.contract, fixture.contract);
  assert.deepEqual(
    body.effects.filter((effect) => effect.kind === "worktree-retired").map((effect) => effect.name),
    [basename(fixture.worktree)],
  );
  assert.deepEqual(
    body.facts.map((fact) => fact.kind),
    ["attestation", "claimed"],
  );
  assert.equal(existsSync(fixture.worktree), false, "terminal cleanup retired the executing worktree");
});

/**
 * Drives the real CLI projection boundary in a child whose own executable tree is
 * retired: it acquires the built modules first, admits a real delivery, retires the
 * executing tree through a real CLI review, then makes that review's confirmed
 * receipt write raise a representative failure so the CLI's own failure projection
 * runs strictly after retirement, from an already-loaded tree.
 */
const FAILURE_PROJECTION_HARNESS = `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [worktree, world, contract] = process.argv.slice(2);
const source = (path) => pathToFileURL(join(worktree, "build/src", path)).href;
// Every ability this child needs is acquired before mutable product work can retire the tree.
const { parseArgv } = await import(source("cli/parse.js"));
const { runCliCommand } = await import(source("cli/runtime.js"));
const { Keiyaku, Repo } = await import(source("index.js"));
const { withOutcomeReceipt } = await import(source("library/outcome.js"));

const executable = (argv) => {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("not executable: " + argv.join(" "));
  return parsed;
};

const delivered = await Keiyaku.with()
  .select({ repo: await Repo.at({ path: world }), id: contract })
  .deliver();
if (delivered.kind !== "accepted") throw new Error("deliver did not admit: " + delivered.kind);

let armed = true;
const nativeWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (armed) {
    armed = false;
    throw withOutcomeReceipt(new TypeError("representative failure after known admission"), delivered);
  }
  return nativeWrite(chunk, ...rest);
};
let exit;
try {
  exit = await runCliCommand(executable(["-C", world, "review", contract, "--satisfied", "--summary", "x", "--json"]));
} finally {
  process.stdout.write = nativeWrite;
}
process.stderr.write("/exit " + exit + "\\n");
process.stderr.write("/worktree " + (existsSync(worktree) ? "present" : "retired") + "\\n");
`;

test("a known-admission failure after retirement keeps its receipt and classification", async (context) => {
  const fixture = selfRetirementFixture(context);
  const harness = join(fixture.root, "failure-projection-harness.mjs");
  writeFileSync(harness, FAILURE_PROJECTION_HARNESS);

  const result = await new Promise<CliChild>((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [harness, fixture.worktree, fixture.world, fixture.contract], {
      cwd: fixture.world,
      env: fixtureEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", rejectChild);
    child.once("close", (code) => resolveChild({ exit: code ?? 1, stdout, stderr }));
  });

  assert.equal(result.exit, 0, result.stderr);
  assert.match(result.stderr, /^\/exit 3$/mu);
  assert.match(result.stderr, /^\/worktree retired$/mu, "the executing tree was retired before the failure projection");
  assert.doesNotMatch(result.stderr, /Cannot find module/u);

  const body = JSON.parse(result.stdout.trimEnd()) as {
    kind: string;
    category: string;
    diagnostic: string;
    causeClass?: string;
    outcome: { operation: string; contract: string; facts: readonly { kind: string }[] };
  };
  assert.equal(body.kind, "failed");
  assert.equal(body.category, "internal");
  assert.equal(body.diagnostic, "representative failure after known admission");
  assert.equal(body.causeClass, "TypeError");
  assert.equal(body.outcome.operation, "deliver");
  assert.equal(body.outcome.contract, fixture.contract);
  assert.deepEqual(
    body.outcome.facts.map((fact) => fact.kind),
    ["deliver"],
    "the confirmed receipt keeps the facts admitted before the failure",
  );
  assert.equal(existsSync(fixture.worktree), false);
});
