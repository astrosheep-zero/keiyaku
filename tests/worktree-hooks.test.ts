import { accepted, present, repositoryWithMain } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HookCommand } from "../src/git/hooks.js";
import { appointedWorktreePath } from "./support/git.js";
import { repositoryAt } from "../src/git/repository.js";
import { Keis, Repo } from "../src/index.js";
import { projectSettings } from "../src/settings.js";

function contractBody(title: string): string {
  return contractMarkdown(title, {
    Context: "Exercise managed worktree hooks.",
    Objective: "Keep hook effects serialized and recoverable.",
    Design: "Use the Git-owned worktree effect marker.",
    Region: "```\nsrc/**\n```",
    Criteria: "### Hook result\nEach effect is visible exactly as specified.\n",
  });
}

function lines(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

function settingsHooks(root: string, hooks: Readonly<Record<string, readonly HookCommand[]>>): void {
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "settings.json"), `${JSON.stringify({ worktree: hooks })}\n`);
}

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
