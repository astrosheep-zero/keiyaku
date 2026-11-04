import assert from "node:assert/strict";
import test from "node:test";
import { InvocationAccumulator } from "../src/library/invocation.js";
import {
  bind,
  commitCandidate,
  accepted,
  acceptedDelivery,
  document,
  present,
  repositoryWithMain,
} from "./support/library-verbs.js";
import { Keiyaku, Repo } from "../src/index.js";
import { deferred } from "./support/process.js";
import type { ExecutionObservation } from "../src/index.js";

test("callback observations preserve order and transported gaps without subscription state", () => {
  const observed: ExecutionObservation[] = [];
  const progress = new InvocationAccumulator((event) => {
    observed.push(event);
  });
  for (const count of [1, 300, 2]) progress.observe({ kind: "progress-dropped", count });
  assert.deepEqual(
    observed,
    [1, 300, 2].map((count) => ({ kind: "progress-dropped", count })),
  );
});

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
    assert.ok(outcome.facts.some((fact) => fact.kind === "deliver"));
    assert.equal(outcome.value.leading.kind, "admitted-now");
  }
});

async function verificationCandidate() {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keiyaku.with().bind({
      repo: await Repo.at({ path: repository.path }),
      markdown:
        document() +
        "\n## Verification\n\n~~~bash timeout=1m\nprintf first\n~~~\n\n~~~bash timeout=1m\nprintf second\n~~~\n",
      target: null,
      gates: ["verified"],
    }),
  );
  assert.ok(bound.value.workspace);
  commitCandidate(repository, bound.value.workspace.path);
  return bound.value.keiyaku;
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
  const check = first.value.checks[0];
  assert.ok(check?.kind === "terminal" && check.admission.kind === "admitted");
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
    assert.equal(event.snapshot, check.snapshot);
    assert.equal(event.observation.snapshot, check.snapshot);
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
    const again = repeated.value.checks[0];
    assert.ok(again?.kind === "terminal");
    assert.equal(again.verdict, "satisfied");
    assert.deepEqual(again.admission, { kind: "reused", entry: check.admission.entry });
    assert.deepEqual(repeated.facts, []);
    assert.equal(present(await contract.state()).delivery, null);
    assert.equal(present(await contract.state()).attestations.length, 1);
  } finally {
    barrier.resolve();
  }
});

test("concurrent selected checks admit independent requirements without losing either result", async () => {
  const contract = await verificationCandidate();
  const outcomes = await Promise.all([contract.verify({ index: 1 }), contract.verify({ index: 2 })]);
  const checks = outcomes.flatMap((outcome) => accepted(outcome).value.checks);
  assert.equal(new Set(checks.map(({ requirement }) => requirement)).size, 2);
  assert.equal(new Set(checks.map(({ snapshot }) => snapshot)).size, 1);
  assert.ok(checks.every((check) => check.kind === "terminal" && check.admission.kind === "admitted"));
  assert.equal(present(await contract.state()).attestations.length, 2);
  const delivered = accepted(await contract.deliver());
  assert.equal(delivered.value.gates?.[0]?.satisfied, true);
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
    assert.ok(outcome.facts.some((fact) => fact.kind === "deliver"));
  } finally {
    barrier.resolve();
  }
});
