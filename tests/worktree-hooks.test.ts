import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { contractLocator, mintSnapshotId } from "../src/git/identity.js";
import {
  runCreateHooks,
  type HookCommand,
  type WorktreeHooks,
} from "../src/git/hooks.js";
import { appointedWorktreePath } from "./support/git.js";
import { commonGitDirectory, repositoryAt, worktreeGitDirectory } from "../src/git/repository.js";
import { materializeScratchCandidate } from "../src/git/scratch.js";
import { Keis, Repo } from "../src/index.js";
import { projectSettings } from "../src/settings.js";
import { repositoryWithMain } from "./support/library-verbs.js";

function contractBody(title: string): string {
  return contractMarkdown(title, {
    Context: "Exercise managed worktree hooks.",
    Objective: "Keep hook effects serialized and recoverable.",
    Design: "Use the Git-owned worktree effect marker.",
    Region: "```\nsrc/**\n```",
    Criteria: "### Hook result\nEach effect is visible exactly as specified.\n",
  });
}

function appendCommand(path: string, value: string, delayMs = 0): HookCommand {
  const append = `require("node:fs").appendFileSync(${JSON.stringify(path)}, ${JSON.stringify(value)})`;
  const source = delayMs === 0 ? append : `setTimeout(() => { ${append}; }, ${delayMs})`;
  return { name: "append", argv: [process.execPath, "-e", source], timeoutMs: 5_000 };
}

function lockPath(
  repository: Awaited<ReturnType<typeof repositoryAt>>,
  id: Parameters<typeof contractLocator>[0],
): string {
  const locator = contractLocator(id);
  return join(
    commonGitDirectory(repository),
    "keiyaku",
    "locks",
    "reconcile",
    locator.slice(0, 2),
    `${locator.slice(2)}.sqlite`,
  );
}

function lines(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("concurrent reconcile runs one frozen hook sequence and destroy removes only worktree administration", async () => {
  const repository = repositoryWithMain();
  const git = await repositoryAt(repository.path);
  const log = join(mkdtempSync(join(tmpdir(), "keiyaku-hooks-")), "hooks.log");
  settingsHooks(repository.path, {
    create: [appendCommand(log, "create\n", 100)],
    destroy: [appendCommand(log, "destroy\n")],
  });
  const settings = await projectSettings(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo, { settings }).bind({
      terms: contractBody("Concurrent hooks"),
    }),
  );
  const id = present(await bound.kei.state()).id;
  const worktree = await appointedWorktreePath(git, id);
  const administration = await worktreeGitDirectory(git, worktree);
  const reports = await Promise.all([
    Keis.of(repo, { settings }).reconcile({ contract: id }),
    Keis.of(repo, { settings }).reconcile({ contract: id }),
  ]);

  assert.deepEqual(
    reports.map((report) => {
      assert.ok(report.kind === "contract");
      return report.issues;
    }),
    [undefined, undefined],
  );
  assert.deepEqual(lines(log), ["create"]);
  assert.equal(repository.run(["-C", worktree, "status", "--porcelain", "--untracked-files=all"]), "");
  assert.equal(existsSync(join(administration, "keiyaku", "hooks.json")), false);

  const abandoned = accepted(await bound.kei.abandon({}));
  assert.deepEqual(
    (abandoned.issues ?? []).filter(
      (effect) => effect.kind === "reconcile-failed" || effect.kind === "worktree-retained",
    ),
    [],
  );
  assert.deepEqual(lines(log), ["create", "destroy"]);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(administration), false);

  const held = await acquireSqliteTransactionLock({ path: lockPath(git, id), mode: "immediate", timeoutMs: 100 });
  held.close();
});

test("a managed create phase reports its first failing command and runs no later command", async () => {
  const repository = repositoryWithMain();
  const commands = join(mkdtempSync(join(tmpdir(), "keiyaku-hook-failure-")), "commands.log");
  const append = (value: string) =>
    `require("node:fs").appendFileSync(${JSON.stringify(commands)}, ${JSON.stringify(value)})`;
  const prepare = (fails: boolean): HookCommand => ({
    name: "prepare",
    argv: [
      process.execPath,
      "-e",
      `${append("prepare\n")}${fails ? '; process.stderr.write("prepare failed\\n"); process.exit(7)' : ""}`,
    ],
    timeoutMs: 5_000,
  });
  const later: HookCommand = { name: "later", argv: [process.execPath, "-e", append("later\n")], timeoutMs: 5_000 };
  settingsHooks(repository.path, { create: [prepare(true), later], destroy: [] });
  const settings = await projectSettings(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo, { settings }).bind({
      terms: contractBody("Failing create hook"),
    }),
  );
  const id = present(await bound.kei.state()).id;
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), id);

  const lag = (bound.issues ?? []).find((issue) => issue.kind === "worktree-hook-failed");
  assert.ok(lag?.kind === "worktree-hook-failed", JSON.stringify(bound));
  assert.equal(lag.phase, "create");
  assert.equal(lag.path, worktree);
  assert.equal(lag.name, "prepare");
  assert.match(lag.diagnostic, /exit 7/u);
  assert.match(lag.diagnostic, /prepare failed/u);
  assert.deepEqual(lines(commands), ["prepare"]);
  assert.equal(existsSync(worktree), true);

  settingsHooks(repository.path, { create: [prepare(false), later], destroy: [] });
  const repaired = await Keis.of(repo, { settings: await projectSettings(repository.path) }).reconcile({
    contract: id,
    retryHooks: true,
  });
  assert.ok(repaired.kind === "contract");
  assert.equal(
    (repaired.issues ?? []).some((issue) => issue.kind === "worktree-hook-failed"),
    false,
  );
  assert.deepEqual(lines(commands), ["prepare", "prepare", "later"]);
});

test("abandon chains destroy-hook changes after the initial ephemeral recovery", async () => {
  const repository = repositoryWithMain();
  settingsHooks(repository.path, {
    create: [],
    destroy: [
      {
        name: "destroy",
        argv: [process.execPath, "-e", 'require("node:fs").writeFileSync("from-destroy-hook.txt", "hook bytes\\n")'],
        timeoutMs: 5_000,
      },
    ],
  });
  const settings = await projectSettings(repository.path);
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path }), { settings }).bind({
      terms: contractBody("Recovery around destroy hooks"),
    }),
  );
  const worktree = await appointedWorktreePath(
    await repositoryAt(repository.path),
    present(await bound.kei.state()).id,
  );
  const originalHead = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  writeFileSync(join(worktree, "before-destroy-hook.txt"), "initial bytes\n");

  const abandoned = accepted(await bound.kei.abandon({}));
  assert.equal(abandoned.issues, undefined);
  const recoveries = repository.run(["fsck", "--unreachable", "--no-reflogs"])
    .split("\n").flatMap((line) => /^unreachable commit ([0-9a-f]+)$/u.exec(line)?.[1] ?? [])
    .filter((oid) => repository.run(["show", "-s", "--format=%s", oid]).includes("ephemeral abandoned-workspace recovery"));
  assert.equal(recoveries.length, 2);
  const recovery = recoveries.find((oid) => repository.run(["ls-tree", "--name-only", oid]).includes("from-destroy-hook.txt"));
  assert.ok(recovery);
  assert.equal(existsSync(worktree), false);
  assert.equal(repository.run(["show", `${recovery}:before-destroy-hook.txt`]), "initial bytes\n");
  assert.equal(repository.run(["show", `${recovery}:from-destroy-hook.txt`]), "hook bytes\n");
  assert.equal(repository.run(["show", `${recovery}^:before-destroy-hook.txt`]), "initial bytes\n");
  const beforeHookPaths = repository.run(["ls-tree", "--name-only", `${recovery}^`]);
  assert.equal(beforeHookPaths.includes("from-destroy-hook.txt"), false);
  assert.equal(repository.run(["rev-parse", `${recovery}^^`]).trim(), originalHead);
});

function settingsHooks(root: string, hooks: Readonly<Record<string, readonly HookCommand[]>>): void {
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "settings.json"), `${JSON.stringify({ worktree: hooks })}\n`);
}

test("a Hook runner outlives its killed reconcile caller and fences immediate replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-hook-caller-death-"));
  const worktree = join(directory, "worktree");
  const administration = join(directory, "administration");
  const started = join(directory, "started");
  const log = join(directory, "hook.log");
  const source = [
    'const fs = require("node:fs");',
    `fs.appendFileSync(${JSON.stringify(log)}, "start\\n");`,
    `fs.writeFileSync(${JSON.stringify(started)}, "started\\n");`,
    `setTimeout(() => fs.appendFileSync(${JSON.stringify(log)}, "end\\n"), 700);`,
  ].join(" ");
  const hooks: WorktreeHooks = {
    create: [{ name: "long", argv: [process.execPath, "-e", source], timeoutMs: 5_000 }],
    destroy: [],
  };
  mkdirSync(worktree);
  const module = new URL("../src/git/hooks.js", import.meta.url).href;
  const input = Buffer.from(JSON.stringify({ worktree, administration, hooks }), "utf8").toString("base64url");
  const callerSource = [
    `const { runCreateHooks } = await import(${JSON.stringify(module)});`,
    `const input = JSON.parse(Buffer.from(${JSON.stringify(input)}, "base64url").toString("utf8"));`,
    "await runCreateHooks(input.worktree, input.hooks);",
  ].join(" ");
  const loader = import.meta.url.endsWith(".js") ? [] : ["--import", import.meta.resolve("tsx")];
  const caller = spawn(process.execPath, [...loader, "--input-type=module", "-e", callerSource], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let callerStderr = "";
  caller.stderr.setEncoding("utf8");
  caller.stderr.on("data", (chunk: string) => {
    callerStderr += chunk;
  });
  try {
    await Promise.race([
      waitForFile(started),
      new Promise<never>((_resolve, reject) =>
        caller.once("exit", (code, signal) => {
          reject(new Error(`reconcile caller exited before Hook start (${code ?? signal}): ${callerStderr.trim()}`));
        }),
      ),
    ]);
    caller.kill("SIGKILL");
    const lag = await runCreateHooks(worktree, hooks);
    assert.equal(lag.lag, null);
    // A busy host may finish the orphan before replay starts; both completed orders are valid.
    assert.match(lines(log).join(","), /^start,(?:start,end,end|end,start,end)$/u);
  } finally {
    if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reconcile acquires a death-released scratch lock and preserves an actively held lock", async () => {
  const repository = repositoryWithMain();
  const git = await repositoryAt(repository.path);
  const commandRan = join(repository.path, "orphan-command-ran");
  mkdirSync(join(repository.path, ".keiyaku"), { recursive: true });
  writeFileSync(
    join(repository.path, ".keiyaku", "settings.json"),
    JSON.stringify({
      worktree: {
        create: [],
        destroy: [
          {
            name: "destroy",
            argv: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(commandRan)}, "ran")`],
            timeoutMs: 5_000,
          },
        ],
      },
    }),
  );
  repository.run(["add", ".keiyaku/settings.json"]);
  repository.run(["commit", "--quiet", "-m", "scratch settings"]);
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo).bind({
      terms: contractBody("Scratch cleanup"),
    }),
  );
  const id = present(await bound.kei.state()).id;
  const requirement = "scratch-custody";
  const snapshot = repository.run(["rev-parse", "HEAD"]).trim();
  const pathFile = join(mkdtempSync(join(tmpdir(), "keiyaku-orphan-path-")), "path");
  const module = new URL("../src/git/scratch.js", import.meta.url).href;
  const repositoryModule = new URL("../src/git/repository.js", import.meta.url).href;
  const childSource = [
    'import { writeFileSync } from "node:fs";',
    `const { materializeScratchCandidate } = await import(${JSON.stringify(module)});`,
    `const { repositoryAt } = await import(${JSON.stringify(repositoryModule)});`,
    `const scratch = await materializeScratchCandidate(await repositoryAt(${JSON.stringify(repository.path)}), ${JSON.stringify(snapshot)}, ${JSON.stringify(id)}, ${JSON.stringify(requirement)});`,
    `writeFileSync(${JSON.stringify(pathFile)}, scratch.cwd);`,
  ].join(" ");
  const loader = import.meta.url.endsWith(".js") ? [] : ["--import", import.meta.resolve("tsx")];
  const child = spawn(process.execPath, [...loader, "--input-type=module", "-e", childSource], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) =>
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`scratch owner exited ${code ?? signal}: ${stderr.trim()}`));
    }),
  );
  const orphan = readFileSync(pathFile, "utf8");
  assert.equal(existsSync(orphan), true);

  const active = await materializeScratchCandidate(git, mintSnapshotId(snapshot), id, requirement);
  const orphanLock = join(dirname(orphan), `.${basename(orphan)}.owner.sqlite`);
  const close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () {
    const failed = this.location() === orphanLock && !existsSync(orphan);
    close.call(this);
    if (failed) throw new Error("scratch ownership close failed after removal");
  };
  try {
    const report = await Keis.of(repo).reconcile({ contract: id });
    assert.ok(report.kind === "contract");
    assert.deepEqual(report.effects, [{ kind: "worktree-removed", path: orphan }]);
    assert.equal(report.issues?.length, 1);
    const issue = report.issues?.[0];
    assert.equal(issue?.kind, "reconcile-failed");
    assert.match(issue.diagnostic, /scratch ownership close failed after removal/u);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(active.cwd), true);
    assert.equal(existsSync(commandRan), false);
  } finally {
    DatabaseSync.prototype.close = close;
    if (!existsSync(orphan)) rmSync(orphanLock, { force: true });
    const leak = await active.dispose();
    if (leak !== null) throw new Error(leak.diagnostic);
  }
});
