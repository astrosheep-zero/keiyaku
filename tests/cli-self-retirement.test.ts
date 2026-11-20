import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { makeGitRepository } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";
import { removeTempDirectory } from "./support/process.js";

const compiled = import.meta.url.endsWith(".js");
/** Compiled test files resolve repository coordinates through the `.test-build` seam. */
const repositoryRoot = resolve(import.meta.dirname, compiled ? "../.." : "..");
const repositoryCli = resolve(repositoryRoot, "build/src/cli/index.js");
/** The build tree a managed worktree holds when a developer built inside that worktree. */
const repositoryBuild = resolve(repositoryRoot, "build");
const repositoryModules = realpathSync(dirname(dirname(createRequire(import.meta.url).resolve("zod/package.json"))));

const CONTRACT_MARKDOWN = contractMarkdown("Self retirement receipt", {
  Context: "The CLI executes from inside the managed worktree its own review retires.",
  Objective: "The accepted result survives retirement of its own executable tree.",
  Design: "The invocation acquires its projection abilities before mutable product work.",
  Region: "src/**",
  Criteria: "### Receipt survives\nThe accepted receipt is emitted once.",
});

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
      env: process.env,
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
    { input: CONTRACT_MARKDOWN, encoding: "utf8", env: process.env },
  );
  assert.equal(bound.status, 0, bound.stderr);
  const binding = JSON.parse(bound.stdout) as {
    kind: string;
    contractId: string;
    worktreePath: string;
  };
  assert.equal(binding.kind, "accepted");
  const worktree = binding.worktreePath;

  cpSync(repositoryBuild, join(worktree, "build"), { recursive: true, dereference: true });
  symlinkSync(repositoryModules, join(worktree, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  runGit(worktree, ["add", "candidate.txt"]);
  runGit(worktree, ["commit", "--quiet", "-m", "candidate"]);
  return {
    root,
    world: world.path,
    contract: binding.contractId,
    worktree,
    cli: join(worktree, "build/src/cli/index.js"),
  };
}

function deliveredText(fixture: SelfRetirementFixture): Promise<CliChild> {
  return runFixtureCli(fixture.cli, fixture.worktree, ["deliver", fixture.contract]);
}

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
  assert.match(reviewed.stdout, /^review accepted  kei\/\S+ · satisfied$/mu);
  assert.equal((reviewed.stdout.match(/^review accepted /gmu) ?? []).length, 1, "one truthful final receipt");
  assert.match(reviewed.stdout, /^  placement  placed$/mu);
  assert.equal(existsSync(fixture.worktree), false, "terminal cleanup retired the executing worktree");
});

