import { managedCandidate, present, repositoryWithMain, TARGET_PLACEMENT_FILES } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { singletonRequirement } from "../src/verification/declaration.js";
import { gate, type ContractId } from "../src/core/facts/types.js";
import { decideAbandon } from "../src/core/verbs/abandon.js";
import { decideAttestation } from "../src/core/verbs/attestation.js";
import { withPrivateStatePublicationSeat } from "../src/git/private-state-seat.js";
import { observeContractsAt } from "../src/git/observe.js";
import type { GitRepository } from "../src/git/process.js";
import { InvocationAccumulator } from "../src/library/invocation.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { admitDecidedOffer, mintAttempt } from "../src/protocol/attempt.js";
import { admitIntent } from "../src/protocol/intent.js";
import { admitPlacement } from "../src/protocol/placement.js";
import { cachedRepositoryAt } from "./support/git.js";
import { deferred } from "./support/process.js";

async function readyPlacementFixture() {
  const repository = repositoryWithMain({ files: { ...TARGET_PLACEMENT_FILES, ".gitignore": "collision.txt\n" } });
  const value = { repository, ...(await managedCandidate(repository, ["reviewed"])) };
  writeFileSync(resolve(value.path, "collision.txt"), "candidate\n");
  repository.run(["-C", value.path, "add", "-f", "collision.txt"]);
  repository.run(["-C", value.path, "commit", "--quiet", "-m", "add candidate path"]);
  await value.contract.deliver();
  await value.contract.review({ verdict: "unsatisfied", summary: "Placement review found an issue" });
  const git = await cachedRepositoryAt(value.repository.path);
  const subject = present(await value.contract.state()).attestations.at(-1)!.data.subject;
  await withGitDecodeChannel(git, async (channel) => {
    const result = await admitIntent(
      channel,
      git,
      {
        contractId: value.id,
        at: new Date().toISOString(),
        preparation: {
          kind: "prepared" as const,
          data: {
            gate: gate("reviewed"),
            requirement: singletonRequirement(gate("reviewed")),
            subject,
            verdict: "satisfied" as const,
          },
        },
      },
      decideAttestation<never>,
      { attempt: mintAttempt() },
    );
    assert.equal(result.kind, "accepted");
  });
  return { ...value, git };
}

function place(git: GitRepository, contractId: ContractId, progress = new InvocationAccumulator()) {
  return withGitDecodeChannel(git, (channel) =>
    admitPlacement({
      channel,
      repository: git,
      progress,
      target: "refs/heads/main",
      placement: { contractId, at: new Date().toISOString() },
    }),
  );
}

test("queued placement decides from the journal after an earlier terminal publication", async () => {
  const { repository, git, id, contract } = await readyPlacementFixture();
  const before = repository.run(["rev-parse", "refs/heads/main"]);
  const holding = deferred();
  const contended = deferred();
  const writer = withPrivateStatePublicationSeat(git, async (seat) => {
    holding.resolve();
    await contended.promise;
    return await withGitDecodeChannel(git, async (channel) => {
      const observation = await observeContractsAt(git, channel, [id]);
      const attempt = mintAttempt();
      const decision = decideAbandon({
        input: { contractId: id, at: new Date().toISOString() },
        attempt,
        observation: observation.decision,
      });
      assert.equal(decision.kind, "offer");
      return admitDecidedOffer({
        scope: git,
        channel,
        contractId: id,
        seat,
        observation,
        attempt,
        offer: decision.offer,
      });
    });
  });
  await holding.promise;
  const placing = place({ ...git, onPrivateStateSeatContention: contended.resolve }, id);
  void placing.finally(contended.resolve).catch(() => undefined);
  const [publication, result] = await Promise.all([writer, placing]);
  assert.equal(publication.value.kind, "accepted");
  assert.deepEqual(result, { kind: "refused", refusal: { kind: "terminal" } });
  assert.equal(present(await contract.state()).terminal?.kind, "abandoned");
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), before);
});
