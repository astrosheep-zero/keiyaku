import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keis, Keiyaku, Repo, type ExecutionObservation } from "../src/index.js";
import {
  bindOutcomeSchema,
  amendOutcomeSchema,
  deliverOutcomeSchema,
  verifyOutcomeSchema,
  reviewOutcomeSchema,
  abandonOutcomeSchema,
  arcOutcomeSchema,
  deliveryPreviewOutcomeSchema,
} from "../src/library/contract-outcomes.js";
import { contractCatalogueSchema, contractObservationSchema } from "../src/protocol/read/status.js";
import { contractResolutionSchema, contractHistorySchema } from "../src/library/contract-types.js";
import { contractWaitResultSchema } from "../src/library/contract-wait.js";
import { contractStateSchema } from "../src/protocol/result-leaves.js";
import { guidanceSchema } from "../src/library/kei.js";
import { deliverySchema } from "../src/library/delivery.js";
import { reconcileResultSchema } from "../src/library/reconcile.js";
import { executionObservationSchema } from "../src/protocol/execution-observation.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { appointedWorktreePath, cachedRepositoryAt } from "./support/git.js";
import { contractId } from "../src/core/facts/types.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";

test("Contract read, wait and terminal mutation wire projections", async () => {
  const repository = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  const bound = accepted(await contracts.bind({ terms: document(), target: null, gates: ["reviewed"] }));
  assertWireRoundTrip(bindOutcomeSchema, bound);
  assertWireRoundTrip(
    bindOutcomeSchema,
    await contracts.bind({ terms: document(), after: [contractId("kei/missing")], target: null }),
  );
  const kei = bound.kei;
  const state = present(await kei.state());
  assertWireRoundTrip(contractCatalogueSchema, await contracts.list());
  const observation = await contracts.observe({ id: state.id });
  assertWireRoundTrip(contractObservationSchema, observation);
  assert.ok(observation.kind === "present");
  assert.deepEqual(observation.row.gates, [{
    gate: "reviewed",
    satisfied: false,
    current: { kind: "missing" },
    requirements: [{ requirement: "gate:reviewed", current: { kind: "missing" } }],
  }]);
  const missingId = contractId("kei/missing");
  const missing = contracts.kei({ id: missingId });
  const missingObservation = await contracts.observe({ id: missingId });
  assert.equal(missingObservation.kind, "missing");
  assertWireRoundTrip(contractObservationSchema, missingObservation);
  assertWireRoundTrip(contractStateSchema, await missing.state());
  assertWireRoundTrip(contractHistorySchema, await missing.history());
  assertWireRoundTrip(guidanceSchema, await missing.guidance());
  assertWireRoundTrip(deliverySchema, await missing.delivery());
  const missingWait = await missing.wait({ timeoutMs: 0 });
  assert.equal(missingWait.kind, "contract");
  assert.deepEqual(missingWait.contracts, [{ id: missingId, presence: "missing" }]);
  assertWireRoundTrip(contractWaitResultSchema, missingWait);
  const dispatch = await publishDispatch({
    repository: await repositoryAt(repository.path),
    akumaId: parseAkumaId("aku/worker/1234abcd").id,
    contractId: state.id,
  });
  assert.equal(dispatch.kind, "dispatched");
  const history = await kei.history();
  assert.ok(history.kind === "contract");
  assert.ok(history.events.some((event) => event.kind === "bind"));
  assert.ok(history.events.some((event) => event.kind === "dispatch"));
  assertWireRoundTrip(contractHistorySchema, history);
  const fullHistory = await kei.history({ item: "1" });
  assert.ok(fullHistory.kind === "contract-exact");
  assert.ok(fullHistory.event.kind === "bind");
  assert.equal(fullHistory.event.document, state.terms.document.bytes);
  assert.deepEqual(history.events.find((event) => event.kind === "bind"), fullHistory.event);
  assertWireRoundTrip(contractHistorySchema, fullHistory);
  assertWireRoundTrip(contractResolutionSchema, await contracts.resolve({ selector: state.id }));
  assertWireRoundTrip(contractResolutionSchema, await contracts.resolve({ selector: "not-found" }));
  assertWireRoundTrip(contractStateSchema, state);
  assertWireRoundTrip(guidanceSchema, await kei.guidance());
  assertWireRoundTrip(deliverySchema, await kei.delivery());
  assertWireRoundTrip(contractWaitResultSchema, await kei.wait({ timeoutMs: 0 }));
  assertWireRoundTrip(
    contractWaitResultSchema,
    await contracts.wait({ contracts: [state.id, "kei/missing"], timeoutMs: 0 }),
  );
  assertWireRoundTrip(reconcileResultSchema, await contracts.reconcile({}));
  assertWireRoundTrip(reconcileResultSchema, await contracts.reconcile({ contract: state.id }));
  assertWireRoundTrip(
    amendOutcomeSchema,
    await kei.amend({ edits: "## Replace: Objective\n\nUpdated objective.\n" }),
  );
  assertWireRoundTrip(arcOutcomeSchema, await kei.arc({ body: "# Next\n\nAnother target.\n" }));
  const abandoned = await kei.abandon();
  assert.equal(abandoned.kind, "accepted");
  assertWireRoundTrip(abandonOutcomeSchema, abandoned);
  const terminal = await kei.wait({ timeoutMs: 0 });
  assert.equal(terminal.kind, "contract");
  assert.equal(terminal.contracts[0]?.terminal, "abandoned");
  assertWireRoundTrip(contractWaitResultSchema, terminal);
  const abandonedAgain = await kei.abandon();
  assert.equal(abandonedAgain.kind, "refused");
  assertWireRoundTrip(abandonOutcomeSchema, abandonedAgain);
  assertWireRoundTrip(
    amendOutcomeSchema,
    await kei.amend({ edits: "## Replace: Objective\n\nAnother objective.\n" }),
  );
  assertWireRoundTrip(arcOutcomeSchema, await kei.arc({ body: "# Next\n\nAnother target.\n" }));
});

test("delivery, verification, review and preview carry their native wire results and events", async () => {
  const repository = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  const bound = accepted(await contracts.bind({ terms: document("exit 0"), target: null, gates: ["verified"] }));
  const kei = bound.kei;
  const state = present(await kei.state());
  const workspace = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(join(workspace, "candidate.txt"), "candidate\n");
  repository.run(["-C", workspace, "add", "candidate.txt"]);
  repository.run(["-C", workspace, "commit", "--quiet", "-m", "candidate"]);
  const events: ExecutionObservation[] = [];
  const options = {
    observe: (event: ExecutionObservation) => {
      events.push(event);
    },
  };

  const preview = await kei.previewDelivery(undefined, options);
  assert.equal(preview.kind, "ready");
  assertWireRoundTrip(deliveryPreviewOutcomeSchema, preview);
  const review = await kei.review({ verdict: "satisfied", summary: "Schema review passed" }, options);
  assert.equal(review.kind, "accepted");
  assertWireRoundTrip(reviewOutcomeSchema, review);
  const unknownIndex = await kei.verify({ index: 2 });
  assert.deepEqual(unknownIndex, {
    kind: "refused",
    contractId: kei.id,
    reason: { kind: "verification-index-out-of-range", total: 1 },
  });
  assertWireRoundTrip(Keiyaku.verbs.verify.output, unknownIndex);
  assert.equal(Keiyaku.verbs.verify.normal.safeParse(unknownIndex).success, false);
  const verify = await kei.verify(undefined, options);
  assert.equal(verify.kind, "accepted");
  assertWireRoundTrip(Keiyaku.verbs.verify.normal, verify);
  assertWireRoundTrip(verifyOutcomeSchema, verify);
  const deliver = await kei.deliver({ message: "retained delivery intent" }, options);
  assert.equal(deliver.kind, "accepted");
  assertWireRoundTrip(deliverOutcomeSchema, deliver);
  const history = await kei.history();
  assert.ok(history.kind === "contract");
  const delivered = history.events.find(event => event.kind === "deliver");
  const claimed = history.events.find(event => event.kind === "claimed");
  assert.ok(delivered?.kind === "deliver" && claimed?.kind === "claimed");
  assert.equal(claimed.deliveryId, delivered.id);
  const historicalClaim = await kei.history({ item: claimed.id });
  assert.ok(historicalClaim.kind === "contract-exact");
  assert.deepEqual(historicalClaim.event, claimed);
  const historicalDelivery = await kei.history({ item: delivered.id });
  assert.ok(historicalDelivery.kind === "contract-exact" && historicalDelivery.event.kind === "deliver");
  assert.equal(historicalDelivery.event.note, "retained delivery intent");
  assert.equal(historicalDelivery.event.requireBranchesToBeUpToDate, false);
  assert.deepEqual(historicalDelivery.event, delivered);
  assertWireRoundTrip(contractHistorySchema, history);
  assertWireRoundTrip(contractHistorySchema, historicalDelivery);
  assertWireRoundTrip(deliverySchema, await kei.delivery());
  assert.ok(events.length > 0);
  for (const event of events) assertWireRoundTrip(executionObservationSchema, event);

  assertWireRoundTrip(deliveryPreviewOutcomeSchema, await kei.previewDelivery());
  assertWireRoundTrip(reviewOutcomeSchema, await kei.review({ verdict: "satisfied", summary: "Schema review passed" }));
  assertWireRoundTrip(verifyOutcomeSchema, await kei.verify());
  assertWireRoundTrip(deliverOutcomeSchema, await kei.deliver());
});
