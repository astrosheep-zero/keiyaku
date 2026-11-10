import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keis, Repo, type ExecutionObservation } from "../src/index.js";
import {
  bindOutcomeSchema,
  contractCatalogueSchema,
  contractObservationSchema,
  contractResolutionSchema,
  contractWaitResultSchema,
  contractStateSchema,
  contractHistorySchema,
  guidanceSchema,
  deliverySchema,
  amendOutcomeSchema,
  deliverOutcomeSchema,
  verifyOutcomeSchema,
  reviewOutcomeSchema,
  abandonOutcomeSchema,
  arcOutcomeSchema,
  deliveryPreviewOutcomeSchema,
  reconcileResultSchema,
  executionObservationSchema,
} from "../src/index.js";
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
  const bound = accepted(await contracts.bind({ markdown: document(), target: null, gates: ["reviewed"] }));
  assertWireRoundTrip(bindOutcomeSchema, bound);
  assertWireRoundTrip(
    bindOutcomeSchema,
    await contracts.bind({ markdown: document(), after: [contractId("kei/missing")], target: null }),
  );
  const kei = bound.kei;
  const state = present(await kei.state());
  assertWireRoundTrip(contractCatalogueSchema, await contracts.list());
  assertWireRoundTrip(contractObservationSchema, await contracts.observe({ id: state.id }));
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
  const fullHistory = await kei.history({ full: true });
  assert.ok(fullHistory.kind === "contract");
  const historicalBind = fullHistory.events.find((event) => event.kind === "bind");
  assert.ok(historicalBind?.kind === "bind");
  assert.equal(historicalBind.document, state.terms.document.bytes);
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
    await kei.amend({ markdown: "## Replace: Objective\n\nUpdated objective.\n" }),
  );
  assertWireRoundTrip(arcOutcomeSchema, await kei.arc({ markdown: "# Next\n\nAnother target.\n" }));
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
    await kei.amend({ markdown: "## Replace: Objective\n\nAnother objective.\n" }),
  );
  assertWireRoundTrip(arcOutcomeSchema, await kei.arc({ markdown: "# Next\n\nAnother target.\n" }));
});

test("delivery, verification, review and preview carry their native wire results and events", async () => {
  const repository = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  const bound = accepted(await contracts.bind({ markdown: document("exit 0"), target: null, gates: ["verified"] }));
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
  const verify = await kei.verify(undefined, options);
  assert.equal(verify.kind, "accepted");
  assertWireRoundTrip(verifyOutcomeSchema, verify);
  const deliver = await kei.deliver(undefined, options);
  assert.equal(deliver.kind, "accepted");
  assertWireRoundTrip(deliverOutcomeSchema, deliver);
  assertWireRoundTrip(deliverySchema, await kei.delivery());
  assert.ok(events.length > 0);
  for (const event of events) assertWireRoundTrip(executionObservationSchema, event);

  assertWireRoundTrip(deliveryPreviewOutcomeSchema, await kei.previewDelivery());
  assertWireRoundTrip(reviewOutcomeSchema, await kei.review({ verdict: "satisfied", summary: "Schema review passed" }));
  assertWireRoundTrip(verifyOutcomeSchema, await kei.verify());
  assertWireRoundTrip(deliverOutcomeSchema, await kei.deliver());
});
