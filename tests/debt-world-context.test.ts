import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { Keiyaku } from "../src/index.js";
import { cliJson } from "./support/cli-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { accepted, document } from "./support/library-verbs.js";

test("real CLI shares one flat ledger across managed worktrees and nested invocation directories", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const environment = { ...process.env, HOME: repository.path, USERPROFILE: repository.path, KEIYAKU_HOME: join(repository.path, "empty-home") };
  const bound = await cliJson<{ kind: string; contractId: string; worktreePath: string }>(
    ["-C", repository.path, "bind", "--gates", "", "-"],
    { environment, readStdin: async () => document() },
  );
  assert.equal(bound.exit, 0, bound.stderr);
  const worktree = bound.value.worktreePath;
  const nested = join(worktree, "src");
  mkdirSync(nested, { recursive: true });
  const cli = resolve("build/src/cli/index.js");
  const added = accepted(Keiyaku.verbs["debt.add"].output.parse(JSON.parse(execFileSync(
    process.execPath, [cli, "-C", nested, "debt", "add", "Shared work", "--json"],
    { env: environment, encoding: "utf8" },
  ))));
  assert.match(added.id, /^debt\/shared-work-[0-9a-f]+$/u);
  for (const argv of [
    ["debt", "update", "debt/one/two", "--note", "unwritten"],
    ["debt", "add", "Unwritten", "--namespace", "one"],
  ]) {
    const invalid = spawnSync(process.execPath, [cli, "-C", nested, ...argv, "--json"],
      { env: environment, encoding: "utf8" });
    assert.equal(invalid.status, 64, invalid.stderr);
  }
  for (const cwd of [repository.path, worktree, nested]) {
    const listed = Keiyaku.verbs.ls.output.parse(JSON.parse(execFileSync(
      process.execPath, [cli, "-C", cwd, "ls", "debt/", "--json"], { env: environment, encoding: "utf8" },
    )));
    assert.ok(listed.kind === "debt-catalogue" && !("absent" in listed));
    assert.deepEqual(listed.rows?.map(({ id }) => id), [added.id]);
  }
  const child = accepted(Keiyaku.verbs["debt.add"].output.parse(JSON.parse(execFileSync(
    process.execPath, [cli, "-C", nested, "debt", "add", "Check shared work", "--needs", added.id, "--json"],
    { env: environment, encoding: "utf8" },
  ))));
  const waiting = Keiyaku.verbs.show.output.parse(JSON.parse(execFileSync(
    process.execPath, [cli, "-C", worktree, "show", child.id, "--json"],
    { env: environment, encoding: "utf8" },
  )));
  assert.ok(waiting.kind === "debt-complete" && waiting.items[0]?.kind === "found");
  assert.deepEqual(waiting.items[0].needs, [{ id: added.id, state: "open" }]);
  const update = Keiyaku.verbs["debt.update"].output.parse(JSON.parse(execFileSync(
    process.execPath, [cli, "-C", repository.path, "debt", "update", added.id, "--state", "done", "--note", "finished", "--json"],
    { env: environment, encoding: "utf8" },
  )));
  assert.equal(update.kind, "accepted");
  const shown = Keiyaku.verbs.show.output.parse(JSON.parse(execFileSync(
    process.execPath, [cli, "-C", nested, "show", child.id, "--json"],
    { env: environment, encoding: "utf8" },
  )));
  assert.ok(shown.kind === "debt-complete" && shown.items[0]?.kind === "found");
  assert.deepEqual(shown.items[0].needs, [{ id: added.id, state: "done" }]);
  const parent = Keiyaku.verbs.show.output.parse(JSON.parse(execFileSync(
    process.execPath, [cli, "-C", nested, "show", added.id, "--json"],
    { env: environment, encoding: "utf8" },
  )));
  assert.ok(parent.kind === "debt-complete" && parent.items[0]?.kind === "found");
  assert.equal(parent.items[0].note, "finished");
  assert.ok(existsSync(join(repository.path, ".keiyaku", "debts", `${added.id.slice(5)}.md`)));
  assert.equal(existsSync(join(worktree, ".keiyaku", "debts")), false);
});
