import assert from "node:assert/strict";
import test from "node:test";
import { Kei, Keis, Repo, type ContractWaitResult } from "../src/index.js";
import { GIT_REF } from "../src/git/read-observation.js";
import { contractWaitNormalResultSchema } from "../src/library/contract-wait.js";
import { withContractWaitBarrier, withContractWaitEpochs, withWaitClock } from "./support/contract-wait.js";
import { withGitShim } from "./support/git.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { assertWireConformance } from "./support/schema-parity.js";

async function fixture() {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const make = async (name: string) => {
    const bound = accepted(await Keis.of(repo).bind({ terms: document().replace("# Library verbs", `# ${name}`), target: null, gates: ["reviewed"] }));
    const handle = bound.kei;
    return { handle, id: present(await handle.state()).id };
  };
  return { repository, repo, first: await make("First wait subject"), second: await make("Second wait subject") };
}

let shared: Promise<Awaited<ReturnType<typeof fixture>>> | undefined;
const sharedFixture = () => (shared ??= fixture());

async function amend(handle: Kei, objective: string) {
  accepted(await handle.amend({ edits: `## Replace: Objective\n\n${objective}\n` }));
}

const changed = (result: ContractWaitResult): boolean[] => result.contracts.map((member) => member.changed === true);

test("Contract waits witness their own journal changes and preserve plural progress", async (t) => {
  const { repository, repo, first, second } = await sharedFixture();
  await withContractWaitBarrier(repository.path, async (barrier) => {
    const observingRepo = await Repo.at({ path: repository.path, gitPath: barrier.gitPath });
    barrier.reset();
    const pending = Keis.of(observingRepo).wait({ contracts: [first.id, second.id, first.id], completion: "all", timeoutMs: 10_000 });
    await barrier.reads();
    await amend(first.handle, "First observed change.");
    barrier.reset();
    await barrier.reads(2);
    await amend(second.handle, "Second observed change.");
    const result = await pending;
    assert.equal(result.kind, "contract");
    assert.equal(result.reason, "changed");
    assert.deepEqual(result.contracts.map((item) => item.id), [first.id, second.id]);
    assert.ok(result.contracts.every((item) => item.changed === true && item.presence === undefined && item.terminal === undefined));
  });

  const deadline = await withContractWaitEpochs(repository.path, async ({ gitPath, observed }) => {
    const observingRepo = await Repo.at({ path: repository.path, gitPath });
    const epoch = () => repository.run(["rev-parse", GIT_REF]).trim();
    const baseline = epoch();
    const timeoutMs = 1800;
    const controller = new AbortController();
    return await withWaitClock(t, timeoutMs, async clock => {
      const pending = clock.within(() => Keis.of(observingRepo).wait({
        contracts: [first.id, second.id], completion: "all", timeoutMs, signal: controller.signal,
      }));
      try {
        await observed(baseline, pending);
        await amend(first.handle, "Another observed change.");
        await observed(epoch(), pending);
        clock.expire();
        return await pending;
      } finally {
        controller.abort();
        await pending.catch(() => {});
      }
    });
  });
  assert.equal(deadline.reason, "deadline");
  assert.deepEqual(changed(deadline), [true, false]);
  assertWireConformance(contractWaitNormalResultSchema, deadline);
  assert.equal((await first.handle.wait({ timeoutMs: 0 })).reason, "deadline");
  const missing = await Keis.of(repo).wait({ contracts: [first.id, "kei/not-present"], timeoutMs: 0 });
  assert.equal(missing.reason, "missing");
  assert.equal(missing.contracts[1]?.presence, "missing");
  accepted(await second.handle.abandon());
  const terminal = await second.handle.wait({ timeoutMs: 0 });
  assert.equal(terminal.reason, "terminal");
  assert.equal(terminal.contracts[0]?.id, second.id);
  assert.equal(terminal.contracts[0]?.terminal, "abandoned");
  assert.equal(terminal.contracts[0]?.summary?.phase, "abandoned");
});

test("initial reads honor deadlines and cancellation", async () => {
  const { repository, first, second } = await sharedFixture();
  await withGitShim('if [ "$1 $2" = "cat-file --batch" ]; then exec sleep 30; fi\nexec "$KEIYAKU_REAL_GIT" "$@"', {}, async (gitPath) => {
    const slow = await Repo.at({ path: repository.path, gitPath });
    const result = await Keis.of(slow).wait({ contracts: [first.id, second.id], timeoutMs: 150 });
    assert.equal(result.reason, "deadline");
    assert.deepEqual(result.contracts, [{ id: first.id, presence: "unknown" }, { id: second.id, presence: "unknown" }]);
  });
  await withContractWaitBarrier(repository.path, async (barrier) => {
    const observingRepo = await Repo.at({ path: repository.path, gitPath: barrier.gitPath });
    const controller = new AbortController();
    barrier.reset();
    const pending = Keis.of(observingRepo).kei({ id: first.id }).wait({ signal: controller.signal });
    await barrier.reads();
    controller.abort();
    await assert.rejects(pending);
  });
});
