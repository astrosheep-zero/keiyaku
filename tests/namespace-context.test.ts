import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cliJson } from "./support/cli-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { document } from "./support/library-verbs.js";

test("managed worktrees share the Debt World and select namespaces explicitly", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const environment = { KEIYAKU_HOME: join(repository.path, "empty-home") };
  const bound = await cliJson<{ kind: string; contractId: string; worktreePath: string }>(
    ["-C", repository.path, "bind", "--gates", "", "-"],
    { environment, readStdin: async () => document() },
  );
  assert.equal(bound.exit, 0, bound.stderr);
  const worktree = bound.value.worktreePath;
  const nested = join(worktree, "src");
  mkdirSync(nested, { recursive: true });
  // Old defaults are inert even when their bytes cannot describe a namespace.
  const oldDefault = join(worktree, ".keiyaku", "namespace", "current");
  mkdirSync(join(worktree, ".keiyaku", "namespace"), { recursive: true });
  writeFileSync(oldDefault, "Bad Namespace\n");
  const added = await cliJson<{ kind: string; id: string }>(
    ["-C", nested, "debt", "add", "Root work"], { environment },
  );
  assert.equal(added.exit, 0, added.stderr);
  assert.match(added.value.id, /^debt\/root-work-[0-9a-f]+$/u);
  const scoped = await cliJson<{ kind: string; id: string }>(
    ["-C", nested, "debt", "add", "Contract work", "--namespace", bound.value.contractId], { environment },
  );
  assert.equal(scoped.exit, 0, scoped.stderr);
  assert.ok(scoped.value.id.startsWith(`debt/${bound.value.contractId}/`));
  const rootListing = await cliJson<{ rows: { id: string }[] }>(["-C", worktree, "ls", "debt/"], { environment });
  assert.deepEqual(rootListing.value.rows.map(({ id }) => id), [added.value.id]);
  const scopedListing = await cliJson<{ rows: { id: string }[] }>(
    ["-C", nested, "ls", `debt/${bound.value.contractId}/`], { environment },
  );
  assert.deepEqual(scopedListing.value.rows.map(({ id }) => id), [scoped.value.id]);
  const queried = await cliJson<{ rows: { id: string }[] }>(
    ["-C", nested, "debt", "query", "--where", "ready"], { environment },
  );
  assert.deepEqual(queried.value.rows.map(({ id }) => id), [added.value.id]);
  const shown = await cliJson<{ items: { kind: string; title: string }[] }>(
    ["-C", repository.path, "show", scoped.value.id, added.value.id], { environment },
  );
  assert.equal(shown.exit, 0, shown.stderr);
  assert.deepEqual(shown.value.items.map(({ title }) => title), ["Contract work", "Root work"]);
  assert.ok(existsSync(join(repository.path, ".keiyaku", "debts", `${added.value.id.slice(5)}.md`)));
  assert.equal(existsSync(join(worktree, ".keiyaku", "debts")), false);
  assert.equal(readFileSync(oldDefault, "utf8"), "Bad Namespace\n");
});
