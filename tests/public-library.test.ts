import "./keiyaku-invocation.cases.js";
import "./lifecycle-selection.cases.js";
import "./mixed-wait.cases.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Akuma, Keis, KeiyakuError, Repo, World, type KeiyakuErrorOptions } from "../src/index.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";

test("a root SDK error keeps its exact Tell failure receipt and native cause", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-public-errors-"));
  const id = Akuma.select(world, "aku/worker/11111111").id;
  const cause = new TypeError("native cause");
  const options: KeiyakuErrorOptions = {
    cause,
    tell: { result: "failed", akumaId: id, tellId: "exact-input",
      failures: [{ stage: "observation", diagnostic: cause.message }] },
  };
  const error = new KeiyakuError("invalid-input", "caller error", options);
  assert.equal(error.cause, cause);
  assert.equal(error.tell, options.tell);
  assert.ok(Object.isFrozen(error.tell));
  assert.equal(Reflect.set(error, "tell", undefined), false);
});

/**
 * The package-root bind surface owns the one omitted-target default: the current branch of the
 * caller's explicit Repo worktree coordinate, with `null` as the deliberate targetless spelling.
 * The CLI edge's own literal flags are witnessed separately in tests/cli-bind-target.test.ts.
 */
test("public Keis.bind omitted target names the Repo worktree branch", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });

  const bound = accepted(await Keis.of(repo).bind({ terms: document(), gates: [] }));
  const state = present(await bound.kei.state());
  assert.equal(state.coordinates.target, "refs/heads/main");
  const json = JSON.parse(JSON.stringify(bound));
  assert.equal(bound.kei.id, state.id);
  assert.equal(Object.getOwnPropertyDescriptor(bound.kei, "id")?.enumerable, false);
  assert.deepEqual(bound.kei.toJSON(), { contract: state.id });
  assert.equal(json.contractId, state.id);
  assert.equal(json.target, "refs/heads/main");
  assert.equal(json.worktreePath, bound.worktreePath);
  assert.equal(Object.hasOwn(json, "kei"), false);

  await assert.rejects(
    () =>
      Keis.of(repo).bind({
        terms: document(),
        targetSelection: { kind: "current-branch" },
      } as never),
    /Keis.bind input has unknown field: targetSelection/u,
  );
});

test("Repo.at rejects an absent or relative worktree coordinate before any filesystem work", async () => {
  await assert.rejects(() => Repo.at(undefined as never), /Repo\.at input must be an object/u);
  await assert.rejects(() => Repo.at({} as never), /repository path must be a nonblank string/u);
  await assert.rejects(() => Repo.at({ path: "relative/worktree" }), /repository path must be absolute/u);
});
