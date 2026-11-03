import assert from "node:assert/strict";
import test from "node:test";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { bodyRequestExecutionContext } from "../src/akuma/requests.js";
import { externalRequestCommandsFor } from "../src/body-requests.js";
import { Keiyaku, Repo, World } from "../src/index.js";
import { composeContractLibrary } from "../src/library/contract-composition.js";
import { createKeiyakuHandle } from "../src/library/keiyaku.js";
import { bornDirectAkuma, noBodyLaunch } from "./support/akuma-fixtures.js";
import { withContractWaitBarrier } from "./support/contract-wait.js";
import { accepted, document, repositoryWithMain } from "./support/library-verbs.js";

test("parent-served Contract waits retain native journal evidence, mode, timeout and cancellation", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const root = await World.at(repository.path);
  const first = accepted(await Keiyaku.with().bind({ repo, markdown: document(), target: null, gates: ["reviewed"] }));
  const second = accepted(await Keiyaku.with().bind({ repo, markdown: document().replace("# Library verbs", "# Second forwarding contract"), target: null, gates: ["reviewed"] }));
  const { leash, ...parent } = await bornDirectAkuma({ root, archetype: "parent", draw: "12345678", allowed: [], createdAt: "2026-08-18T00:00:00.000Z" });
  leash.release();
  await withContractWaitBarrier(repository.path, async (barrier) => {
    const { commands } = await externalRequestCommandsFor({ paths: parent.paths }, { gitPath: barrier.gitPath }, noBodyLaunch);
    const pump = await BodyRequestPump.open({ paths: parent.paths, allowed: [], bodySequence: 1, now: () => "2026-08-18T00:00:01.000Z", commands, signal: new AbortController().signal });
    try {
      const forwarded = composeContractLibrary(bodyRequestExecutionContext(pump.directory), createKeiyakuHandle);
      const immediate = await forwarded.wait({ repo, contracts: [first.contract, second.contract], completion: "all", timeoutMs: 0 });
      assert.equal(immediate.kind, "deadline");
      assert.equal(immediate.completion, "all");
      assert.deepEqual(immediate.contracts.map((row) => row.contract), [first.contract, second.contract]);
      const direct = await Keiyaku.with().wait({ repo, contracts: [first.contract, second.contract], completion: "all", timeoutMs: 0 });
      assert.deepEqual(immediate, direct);
      barrier.reset();
      const pending = forwarded.select({ repo, id: first.contract }).wait({ timeoutMs: 10_000 });
      await barrier.reads();
      accepted(await first.value.keiyaku.amend({ markdown: "## Replace: Objective\n\nForwarded journal change.\n" }));
      const result = await pending;
      assert.equal(result.kind, "changed");
      assert.equal(result.contracts[0]?.contract, first.contract);
      assert.equal(result.contracts[0]?.changed, true);
      const controller = new AbortController();
      barrier.reset();
      const cancelled = forwarded.wait({ repo, contracts: [second.contract], signal: controller.signal });
      await barrier.reads();
      controller.abort();
      await assert.rejects(cancelled);
      accepted(await second.value.keiyaku.abandon());
      const terminal = await forwarded.select({ repo, id: second.contract }).wait({ timeoutMs: 0 });
      const directTerminal = await second.value.keiyaku.wait({ timeoutMs: 0 });
      assert.deepEqual(terminal, directTerminal);
      assert.equal(terminal.kind, "terminal");
      assert.equal(terminal.contracts[0]?.terminal, "abandoned");
      assert.equal(terminal.contracts[0]?.changed, false);
    } finally {
      await pump.close();
    }
  });
});
