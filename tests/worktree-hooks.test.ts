import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { contractLocator, mintSnapshotId } from "../src/git/identity.js";
import { hookMarkerPath, runCreateHooks, type HookCommand, type WorktreeHooks } from "../src/git/hooks.js";
import { appointedWorktreePath } from "./support/git.js";
import { commonGitDirectory, repositoryAt, worktreeGitDirectory } from "../src/git/repository.js";
import { materializeScratchCandidate } from "../src/git/scratch.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { Keiyaku, Repo } from "../src/index.js";
import { abandonOperation } from "../src/protocol/abandon.js";
import { scopeOperation } from "../src/protocol/operations.js";
import { repositoryWithMain } from "./support/library-verbs.js";

const EMPTY_HOOKS: WorktreeHooks = { create: [], destroy: [] };

function contractBody(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Exercise managed worktree hooks.",
    "",
    "## Objective",
    "Keep hook effects serialized and recoverable.",
    "",
    "## Design",
    "Use the Git-owned worktree effect marker.",
    "",
    "## Region",
    "```",
    "src/**",
    "```",
    "",
    "## Criteria",
    "### Hook result",
    "Each effect is visible exactly as specified.",
    "",
  ].join("\n");
}

function appendCommand(path: string, value: string, delayMs = 0): HookCommand {
  const append = `require("node:fs").appendFileSync(${JSON.stringify(path)}, ${JSON.stringify(value)})`;
  const source = delayMs === 0 ? append : `setTimeout(() => { ${append}; }, ${delayMs})`;
  return { argv: [process.execPath, "-e", source], timeoutMs: 5_000 };
}

function guardedCommand(attempts: string, ready: string): HookCommand {
  const source = [
    `const fs = require("node:fs");`,
    `fs.appendFileSync(${JSON.stringify(attempts)}, "attempt\\n");`,
    `if (!fs.existsSync(${JSON.stringify(ready)})) process.exit(9);`,
  ].join(" ");
  return { argv: [process.execPath, "-e", source], timeoutMs: 5_000 };
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
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Concurrent hooks"),
    hooks: EMPTY_HOOKS,
  });
  const id = bound.keiyaku.id;
  const worktree = await appointedWorktreePath(git, id);
  const administration = await worktreeGitDirectory(git, worktree);
  unlinkSync(hookMarkerPath(administration));
  const hooks: WorktreeHooks = {
    create: [appendCommand(log, "create\n", 100)],
    destroy: [appendCommand(log, "destroy\n")],
  };

  const reports = await Promise.all([bound.keiyaku.reconcile({ hooks }), bound.keiyaku.reconcile({ hooks })]);

  assert.deepEqual(
    reports.map((report) => report.lag),
    [[], []],
  );
  assert.deepEqual(lines(log), ["create"]);
  assert.equal(repository.run(["-C", worktree, "status", "--porcelain", "--untracked-files=all"]), "");
  assert.equal(existsSync(hookMarkerPath(administration)), true);

  const abandoned = await bound.keiyaku.abandon();
  assert.deepEqual(abandoned.lags, []);
  assert.deepEqual(lines(log), ["create", "destroy"]);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(administration), false);

  const held = await acquireSqliteTransactionLock({ path: lockPath(git, id), mode: "immediate", timeoutMs: 100 });
  held.close();
});

test("abandon chains destroy-hook changes after the initial ephemeral recovery", async () => {
  const repository = repositoryWithMain();
  const hooks: WorktreeHooks = {
    create: [],
    destroy: [
      {
        argv: [process.execPath, "-e", 'require("node:fs").writeFileSync("from-destroy-hook.txt", "hook bytes\\n")'],
        timeoutMs: 5_000,
      },
    ],
  };
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Recovery around destroy hooks"),
    hooks,
  });
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), bound.keiyaku.id);
  const originalHead = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  writeFileSync(join(worktree, "before-destroy-hook.txt"), "initial bytes\n");

  const abandoned = await bound.keiyaku.abandon();
  const recovery = abandoned.effects.find((effect) => effect.kind === "recovery-snapshot");

  assert.ok(recovery);
  assert.equal(existsSync(worktree), false);
  assert.equal(repository.run(["show", `${recovery.snapshot}:before-destroy-hook.txt`]), "initial bytes\n");
  assert.equal(repository.run(["show", `${recovery.snapshot}:from-destroy-hook.txt`]), "hook bytes\n");
  assert.equal(repository.run(["show", `${recovery.snapshot}^:before-destroy-hook.txt`]), "initial bytes\n");
  const beforeHookPaths = repository.run(["ls-tree", "--name-only", `${recovery.snapshot}^`]);
  assert.equal(beforeHookPaths.includes("from-destroy-hook.txt"), false);
  assert.equal(repository.run(["rev-parse", `${recovery.snapshot}^^`]).trim(), originalHead);
});

test("a reconcile queued on the effect lock reobserves terminal state before applying topology", async () => {
  const repository = repositoryWithMain();
  const git = await repositoryAt(repository.path);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Terminal wins"),
    hooks: EMPTY_HOOKS,
  });
  const id = bound.keiyaku.id;
  const worktree = await appointedWorktreePath(git, id);
  const held = await acquireSqliteTransactionLock({ path: lockPath(git, id), mode: "immediate", timeoutMs: 100 });
  const pending = bound.keiyaku.reconcile();

  const scope = await scopeOperation({ coordinate: repository.path });
  const terminal = await withGitDecodeChannel(scope, (channel) =>
    abandonOperation({
      scope,
      channel,
      contractId: id,
    }),
  );
  assert.equal(terminal.kind, "accepted");
  repository.run(["worktree", "remove", worktree]);
  held.close();

  const report = await pending;
  assert.equal(report.lag.length, 0);
  assert.equal(
    report.effects.some((effect) => effect.kind === "worktree" && effect.action === "created"),
    false,
  );
  assert.equal(existsSync(worktree), false);
  assert.equal((await bound.keiyaku.state()).terminal?.kind, "abandoned");
});

test("failed create hooks remain stopped until explicit retry resumes the frozen command", async () => {
  const repository = repositoryWithMain();
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-hook-retry-"));
  const attempts = join(directory, "attempts.log");
  const ready = join(directory, "ready");
  const hooks: WorktreeHooks = { create: [guardedCommand(attempts, ready)], destroy: [] };

  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Retry hooks"),
    hooks,
  });
  assert.equal(bound.lags[0]?.kind, "worktree-hook-failed");
  assert.deepEqual(lines(attempts), ["attempt"]);

  const ordinary = await bound.keiyaku.reconcile();
  assert.equal(ordinary.lag[0]?.kind, "worktree-hook-failed");
  assert.deepEqual(lines(attempts), ["attempt"]);

  writeFileSync(ready, "ready\n");
  const retried = await bound.keiyaku.reconcile({ retryHooks: true });
  assert.deepEqual(retried.lag, []);
  assert.deepEqual(lines(attempts), ["attempt", "attempt"]);
});

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
    create: [{ argv: [process.execPath, "-e", source], timeoutMs: 5_000 }],
    destroy: [],
  };
  mkdirSync(worktree);
  const module = pathToFileURL(join(process.cwd(), "src", "git", "hooks.ts")).href;
  const input = Buffer.from(JSON.stringify({ worktree, administration, hooks }), "utf8").toString("base64url");
  const callerSource = [
    `const { runCreateHooks } = await import(${JSON.stringify(module)});`,
    `const input = JSON.parse(Buffer.from(${JSON.stringify(input)}, "base64url").toString("utf8"));`,
    "await runCreateHooks(input.worktree, input.administration, input.hooks, false);",
  ].join(" ");
  const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const caller = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", callerSource], {
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
    const lag = await runCreateHooks(worktree, administration, hooks, false);
    assert.equal(lag, null);
    assert.deepEqual(lines(log), ["start", "end"]);
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
            argv: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(commandRan)}, "ran")`],
            timeoutMs: 5_000,
          },
        ],
      },
    }),
  );
  repository.run(["add", ".keiyaku/settings.json"]);
  repository.run(["commit", "--quiet", "-m", "scratch settings"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Scratch cleanup"),
    hooks: EMPTY_HOOKS,
  });
  const snapshot = repository.run(["rev-parse", "HEAD"]).trim();
  const pathFile = join(mkdtempSync(join(tmpdir(), "keiyaku-orphan-path-")), "path");
  const module = pathToFileURL(join(process.cwd(), "src", "git", "scratch.ts")).href;
  const repositoryModule = pathToFileURL(join(process.cwd(), "src", "git", "repository.ts")).href;
  const childSource = [
    'import { writeFileSync } from "node:fs";',
    `const { materializeScratchCandidate } = await import(${JSON.stringify(module)});`,
    `const { repositoryAt } = await import(${JSON.stringify(repositoryModule)});`,
    `const scratch = await materializeScratchCandidate(await repositoryAt(${JSON.stringify(repository.path)}), ${JSON.stringify(snapshot)});`,
    `writeFileSync(${JSON.stringify(pathFile)}, scratch.cwd);`,
  ].join(" ");
  const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", childSource], {
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
  assert.equal(existsSync(hookMarkerPath(await worktreeGitDirectory(git, orphan))), false);

  const active = await materializeScratchCandidate(git, mintSnapshotId(snapshot));
  try {
    const report = await bound.keiyaku.reconcile();
    assert.equal(
      report.effects.some(
        (effect) => effect.kind === "worktree" && effect.path === orphan && effect.action === "removed",
      ),
      true,
    );
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(active.cwd), true);
    assert.equal(existsSync(commandRan), false);
  } finally {
    const leak = await active.dispose();
    if (leak !== null) throw new Error(leak.diagnostic);
  }
});
