import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Kei, Keis, KeiyakuError, Repo, type ContractResolution } from "../src/index.js";
import { makeGitRepository } from "./support/git.js";
import { accepted } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";

const markdown = contractMarkdown("Resolve Contract", {
  Context: "public selection",
  Objective: "resolve",
  Design: "one complete board",
  Region: "src/**",
  Criteria: "### Selection\nContract identity remains owner-resolved.",
});

test("public resolution uses explicit Repo context and exact canonical managed-worktree coordinates", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const library = Keis.of(repo);
  const bound = accepted(await library.bind({ terms: markdown, gates: ["reviewed"] }));
  const worktreePath = bound.worktreePath;
  assert.ok(worktreePath);
  const expected: ContractResolution = { kind: "resolved", id: bound.contractId };
  const selector = `@${bound.contractId.slice("kei/".length)}`;
  assert.deepEqual(await library.resolve({ selector }), expected);
  assert.deepEqual(await Keis.of(await Repo.at({ path: worktreePath })).resolve({  }), expected);
  const link = join(repository.path, "context-link");
  symlinkSync(worktreePath, link, "dir");
  assert.deepEqual(await library.resolve({ cwd: link }), expected);
  const nested = join(worktreePath, "nested");
  mkdirSync(nested);
  assert.deepEqual(
    await library.resolve({ cwd: nested }),
    {
      kind: "refused",
      refusal: { kind: "no-contextual-match", cwd: nested },
    },
    "context is exact, not an ancestor lookup",
  );
  assert.deepEqual(
    await library.resolve({  }),
    {
      kind: "refused",
      refusal: { kind: "no-contextual-match", cwd: repo.cwd },
    },
    "omission uses the supplied Repo, not the test process directory",
  );
  assert.deepEqual(await library.resolve({ selector: `${selector}-extra` }), {
    kind: "refused",
    refusal: { kind: "unknown-short-selector", selector: `${selector}-extra` },
  });

  rmSync(link);
  accepted(await bound.kei.abandon());
  assert.deepEqual(
    await library.resolve({ selector }),
    {
      kind: "refused",
      refusal: { kind: "unknown-short-selector", selector },
    },
    "a resolution does not reserve its candidate against later lifecycle changes",
  );
});

test("complete identities resolve without authority reads; corrupt short-selector authority retains its cause", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "invalid authority"]);
  repository.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  const library = Keis.of(repo);
  const resolved = await library.resolve({ selector: "kei/nonexistent" });
  assert.equal(resolved.kind, "resolved");
  if (resolved.kind === "resolved") {
    assert.equal(resolved.id, "kei/nonexistent");
    assert.ok(library.kei({ id: resolved.id }) instanceof Kei);
  }
  await assert.rejects(library.resolve({ selector: "@nonexistent" }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "authority-corruption");
    assert.ok(error.cause instanceof Error);
    return true;
  });
});
