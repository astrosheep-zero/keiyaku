import "./keiyaku-invocation.cases.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Akumas, AuthorityCorruptionError, Keis, Repo, World, type AliasBinding } from "../src/index.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { temporaryDirectory } from "./support/process.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";

/**
 * The package-root bind surface owns the one omitted-target default: the current branch of the
 * caller's explicit Repo worktree coordinate, with `null` as the deliberate targetless spelling.
 * The CLI edge's own literal flags are witnessed separately in tests/cli-bind-target.test.ts.
 */
test("public Keis.bind omitted target names the Repo worktree branch", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });

  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), workspace: "worktree", gates: [] }));
  const state = present(await bound.kei.state());
  assert.equal(state.coordinates.target, "refs/heads/main");
  const json = JSON.parse(JSON.stringify(bound));
  assert.equal(json.contractId, state.id);
  assert.equal(json.target, "refs/heads/main");
  assert.equal(json.worktreePath, bound.worktreePath);
  assert.equal(Object.hasOwn(json, "kei"), false);

  await assert.rejects(
    () =>
      Keis.of(repo).bind({
        markdown: document(),
        targetSelection: { kind: "current-branch" },
      } as never),
    /Keis.bind input has unknown field: targetSelection/u,
  );
});

test("public Keis.bind target:null stays targetless and a string target stays literal", async () => {
  const raw = repositoryWithMain();
  raw.run(["branch", "release"]);
  const repo = await Repo.at({ path: raw.path });

  const targetless = accepted(
    await Keis.of(repo).bind({ markdown: document(), workspace: "worktree", target: null, gates: [] }),
  );
  assert.equal(present(await targetless.kei.state()).coordinates.target, undefined);

  const explicit = accepted(
    await Keis.of(repo).bind({
      markdown: document(),
      workspace: "worktree",
      target: "release",
      gates: [],
    }),
  );
  assert.equal(present(await explicit.kei.state()).coordinates.target, "refs/heads/release");

  await assert.rejects(
    () => Keis.of(repo).bind({ markdown: document(), workspace: "worktree", target: 7 } as never),
    /target must be a string or null/u,
  );
});

test("World-bound alias observation selects one canonical mapping without requiring Akuma existence", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-public-aliases-"));
  const akumas = Akumas.of(world);
  const first = parseAkumaId("aku/worker/11111111").id;
  const second = parseAkumaId("aku/reviewer/22222222").id;
  const missing = "aku/worker/33333333";
  assert.deepEqual(await akumas.aliases({ akumaIds: [first, missing] }), []);
  for (const [name, akumaId] of [["zeta", first], ["alpha", first], ["reviewer", second]] as const) {
    await moveAlias({ world, alias: parseAkumaAlias(`@${name}`), akumaId });
  }
  const bindings: readonly AliasBinding[] = await akumas.aliases({ akumaIds: [second, first, first, missing] });
  assert.deepEqual(bindings, [
    { alias: "@alpha", akumaId: first },
    { alias: "@reviewer", akumaId: second },
    { alias: "@zeta", akumaId: first },
  ]);
  await moveAlias({ world, alias: parseAkumaAlias("@alpha"), akumaId: second });
  assert.deepEqual(await akumas.aliases({ akumaIds: [first] }), [{ alias: "@zeta", akumaId: first }]);
  assert.deepEqual(await akumas.aliases({ akumaIds: [second] }), [
    { alias: "@alpha", akumaId: second }, { alias: "@reviewer", akumaId: second },
  ]);
  assert.deepEqual(await akumas.aliases({ akumaIds: [] }), []);
  for (const input of [{}, { akumaIds: "@alpha" }, { akumaIds: ["@alpha"] }, { akumaIds: [first, 1] },
    { akumaIds: [first], path: world }]) {
    await assert.rejects(akumas.aliases(input as never), TypeError);
  }
  writeFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "corrupt\n");
  await assert.rejects(akumas.aliases({ akumaIds: [missing] }), AuthorityCorruptionError);
});

test("Repo.at rejects an absent or relative worktree coordinate before any filesystem work", async () => {
  await assert.rejects(() => Repo.at(undefined as never), /Repo\.at input must be an object/u);
  await assert.rejects(() => Repo.at({} as never), /repository path must be a nonblank string/u);
  await assert.rejects(() => Repo.at({ path: "relative/worktree" }), /repository path must be absolute/u);
});
