import assert from "node:assert/strict";
import test from "node:test";
import {
  bind,
  commitCandidate,
  accepted,
  acceptedDelivery,
  document,
  present,
  repositoryWithMain,
} from "./support/library-verbs.js";
import { Keis, Repo } from "../src/index.js";
import { deferred } from "./support/process.js";
import type { ExecutionObservation } from "../src/index.js";

test("synchronous and asynchronous observer failures cannot change delivery admission or completion", async () => {
  for (const observer of [
    () => {
      throw new TypeError("observer failure");
    },
    async () => {
      throw new TypeError("observer rejection");
    },
  ]) {
    const repository = repositoryWithMain();
    const contract = await bind(repository);
    commitCandidate(repository);
    const outcome = acceptedDelivery(await contract.deliver({}, { observe: observer }));
    assert.equal(outcome.admission, undefined);
    assert.equal(outcome.contractId, present(await contract.state()).id);
    assert.equal(present(await contract.state()).delivery?.data.integration.snapshot, outcome.integration);
  }
});

async function verificationCandidate() {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      markdown:
        document() +
        "\n## Verification\n\n~~~bash timeout=1m\nprintf first\n~~~\n\n~~~bash timeout=1m\nprintf second\n~~~\n",
      target: null,
      gates: ["verified"],
    }),
  );
  assert.ok(bound.worktreePath);
  commitCandidate(repository, bound.worktreePath);
  return bound.kei;
}

test("verify observers retain selected coordinates and cannot interrupt repeated execution or admission reuse", async () => {
  const contract = await verificationCandidate();
  const observed: ExecutionObservation[] = [];
  const first = accepted(
    await contract.verify(
      { index: 2 },
      {
        observe: (event) => {
          observed.push(event);
          throw new TypeError("observer failure");
        },
      },
    ),
  );
  const check = first.checks[0];
  assert.ok(check?.kind === "terminal" && check.admission === undefined);
  const output = observed.filter((event) => event.kind === "verification" && event.observation.kind === "output");
  assert.ok(
    output.some(
      (event) =>
        event.kind === "verification" &&
        event.observation.kind === "output" &&
        event.observation.text.includes("second"),
    ),
  );
  for (const event of observed) {
    if (event.kind !== "verification") continue;
    assert.equal(event.snapshot, first.snapshot);
    assert.equal(event.observation.snapshot, first.snapshot);
    assert.equal(event.observation.requirement, check.requirement);
    assert.equal(event.observation.index, 2);
  }
  const barrier = deferred<void>();
  let executedAgain = false;
  try {
    const repeated = accepted(
      await contract.verify(
        { index: 2 },
        {
          observe: (event) => {
            if (event.kind === "verification" && event.observation.kind === "output") executedAgain = true;
            return barrier.promise;
          },
        },
      ),
    );
    assert.equal(executedAgain, true);
    const again = repeated.checks[0];
    assert.ok(again?.kind === "terminal");
    assert.equal(again.verdict, "satisfied");
    assert.equal(again.admission, "reused");
    assert.equal(present(await contract.state()).delivery, null);
    assert.equal(present(await contract.state()).attestations.length, 1);
  } finally {
    barrier.resolve();
  }
});

test("concurrent selected checks admit independent requirements without losing either result", async () => {
  const contract = await verificationCandidate();
  const outcomes = await Promise.all([contract.verify({ index: 1 }), contract.verify({ index: 2 })]);
  const checks = outcomes.flatMap((outcome) => accepted(outcome).checks);
  assert.equal(new Set(checks.map(({ requirement }) => requirement)).size, 2);
  assert.equal(new Set(outcomes.map((outcome) => accepted(outcome).snapshot)).size, 1);
  assert.ok(checks.every((check) => check.kind === "terminal" && check.admission === undefined));
  assert.equal(present(await contract.state()).attestations.length, 2);
  const delivered = accepted(await contract.deliver());
  assert.equal(delivered.placement?.kind, "placed");
  assert.equal(present(await contract.state()).terminal?.kind, "claimed");
});

test("slow observers and callers that stop observing never delay or cancel delivery", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  commitCandidate(repository);
  const barrier = deferred<void>();
  let seen = 0;
  try {
    const outcome = acceptedDelivery(
      await contract.deliver(
        {},
        {
          observe: () => {
            seen += 1;
            return barrier.promise;
          },
        },
      ),
    );
    assert.ok(seen > 0);
    assert.equal(outcome.contractId, present(await contract.state()).id);
    assert.ok(present(await contract.state()).delivery);
  } finally {
    barrier.resolve();
  }
});
