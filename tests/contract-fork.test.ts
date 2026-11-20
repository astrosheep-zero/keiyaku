import assert from "node:assert/strict";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
import { document, repositoryWithMain, present, accepted } from "./support/library-verbs.js";

test("fork bind preserves the source target and start", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  repository.run(["branch", "release"]);
  const source = accepted(await Keis.of(repo).bind({
    terms: document().replace("# Library verbs", "# Targeted source"),
    target: "release",
    gates: [],
  }));
  const sourceState = present(await source.kei.state());
  assert.equal(sourceState.coordinates.target, "refs/heads/release");

  repository.run(["checkout", "-B", "caller"]);
  const fork = accepted(await Keis.of(repo).bind({ forkOf: sourceState.id }));
  const forkState = present(await fork.kei.state());
  assert.equal(forkState.coordinates.target, "refs/heads/release");
  assert.equal(forkState.coordinates.start, sourceState.coordinates.start);
});

test("fork bind refuses missing sources and incompatible term inputs", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const missing = await Keis.of(repo).bind({ forkOf: "kei/missing" as never });
  assert.equal(missing.kind, "refused");
  if (missing.kind === "refused") assert.deepEqual(missing.reason, { kind: "fork-source-missing" });
  await assert.rejects(
    () => Keis.of(repo).bind({ forkOf: "kei/source" as never, gates: [] } as never),
    /Keis.bind input has unknown field: gates/u,
  );
});
