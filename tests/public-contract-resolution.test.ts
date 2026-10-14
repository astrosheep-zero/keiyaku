import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, KeiyakuError, Repo, type ContractResolution } from "../src/index.js";
import { matchContractCandidates } from "../src/library/contract-address.js";
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
  const library = Keiyaku.with();
  const bound = accepted(await library.bind({ repo, markdown, gates: ["reviewed"] }));
  const [row] = (await library.list({ repo })).rows;
  assert.ok(row?.worktreePath);
  const expected: ContractResolution = { kind: "resolved", id: bound.contract };
  const selector = `@${row.id.slice("kei/".length)}`;
  assert.deepEqual(await library.resolve({ repo, selector }), expected);
  assert.deepEqual(await library.resolve({ repo: await Repo.at({ path: row.worktreePath }) }), expected);
  const link = join(repository.path, "context-link");
  symlinkSync(row.worktreePath, link, "dir");
  assert.deepEqual(await library.resolve({ repo, cwd: link }), expected);
  const nested = join(row.worktreePath, "nested");
  mkdirSync(nested);
  assert.deepEqual(
    await library.resolve({ repo, cwd: nested }),
    {
      kind: "refused",
      refusal: { kind: "no-contextual-match", cwd: nested },
    },
    "context is exact, not an ancestor lookup",
  );
  assert.deepEqual(
    await library.resolve({ repo }),
    {
      kind: "refused",
      refusal: { kind: "no-contextual-match", cwd: repo.cwd },
    },
    "omission uses the supplied Repo, not the test process directory",
  );
  assert.deepEqual(await library.resolve({ repo, selector: `${selector}-extra` }), {
    kind: "refused",
    refusal: { kind: "unknown-short-selector", selector: `${selector}-extra` },
  });

  assert.deepEqual(
    matchContractCandidates([row, { ...row, disposition: "terminal" }, { ...row, worktreePath: null }], { selector }),
    [row],
  );
  assert.deepEqual(
    matchContractCandidates([{ ...row, phase: "claimed" }], { selector }),
    [{ ...row, phase: "claimed" }],
    "candidate membership uses owner disposition, not a second phase judgment",
  );
  rmSync(link);
  accepted(await bound.value.keiyaku.abandon());
  assert.deepEqual(
    await library.resolve({ repo, selector }),
    {
      kind: "refused",
      refusal: { kind: "unknown-short-selector", selector },
    },
    "a resolution does not reserve its candidate against later lifecycle changes",
  );
});

test("selector refusals are ordinary data while malformed input and cwd are caller errors", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  const library = Keiyaku.with();
  assert.deepEqual(await library.resolve({ repo, selector: "@kei/redundant" }), {
    kind: "refused",
    refusal: { kind: "redundant-short-selector", selector: "@kei/redundant" },
  });
  const invalid = await library.resolve({ repo, selector: "not-a-contract" });
  assert.equal(invalid.kind, "refused");
  if (invalid.kind === "refused") assert.equal(invalid.refusal.kind, "invalid-selector");
  await assert.rejects(library.resolve({ repo, selector: 7 } as never), TypeError);
  await assert.rejects(library.resolve({ repo, cwd: "relative" }), TypeError);
  const file = join(repo.cwd, "not-directory");
  writeFileSync(file, "file");
  await assert.rejects(library.resolve({ repo, cwd: file }), TypeError);
});

test("complete identities resolve without authority reads; corrupt short-selector authority retains its cause", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "invalid authority"]);
  repository.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  const library = Keiyaku.with();
  const resolved = await library.resolve({ repo, selector: "kei/nonexistent" });
  assert.equal(resolved.kind, "resolved");
  if (resolved.kind === "resolved") {
    assert.equal(resolved.id, "kei/nonexistent");
    assert.ok(library.select({ repo, id: resolved.id }) instanceof Keiyaku);
  }
  await assert.rejects(library.resolve({ repo, selector: "@nonexistent" }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "authority-corruption");
    assert.ok(error.cause instanceof Error);
    return true;
  });
});
