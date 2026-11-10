import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Kei, Keis, KeiyakuError, Repo, type ContractResolution } from "../src/index.js";
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
  const library = Keis.of(repo);
  const bound = accepted(await library.bind({ markdown, gates: ["reviewed"] }));
  const [summary] = (await library.list({  })).rows!;
  assert.ok(summary);
  const observed = await library.observe({ id: summary.id });
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") throw new Error("missing bound contract");
  const row = observed.row;
  assert.ok(row.workspace.kind !== "unappointed" && "path" in row.workspace);
  const worktreePath = row.workspace.path;
  const expected: ContractResolution = { kind: "resolved", id: bound.contractId };
  const selector = `@${row.id.slice("kei/".length)}`;
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

  assert.deepEqual(
    matchContractCandidates([row, { ...row, phase: "abandoned" }, { ...row, workspace: { kind: "unappointed" } }], {
      selector,
    }),
    [row],
  );
  assert.deepEqual(
    matchContractCandidates([{ ...row, phase: "claimed" }], { selector }),
    [],
    "candidate membership follows the owner's bound phase",
  );
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

test("selector refusals are ordinary data while malformed input and cwd are caller errors", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  const library = Keis.of(repo);
  assert.deepEqual(await library.resolve({ selector: "@kei/redundant" }), {
    kind: "refused",
    refusal: { kind: "redundant-short-selector", selector: "@kei/redundant" },
  });
  const invalid = await library.resolve({ selector: "not-a-contract" });
  assert.equal(invalid.kind, "refused");
  if (invalid.kind === "refused") assert.equal(invalid.refusal.kind, "invalid-selector");
  await assert.rejects(library.resolve({ selector: 7 } as never), TypeError);
  await assert.rejects(library.resolve({ cwd: "relative" }), TypeError);
  const file = join(repo.cwd, "not-directory");
  writeFileSync(file, "file");
  await assert.rejects(library.resolve({ cwd: file }), TypeError);
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
