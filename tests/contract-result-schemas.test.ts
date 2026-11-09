import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { z } from "zod";
import { Keis, Repo, type Kei, type ExecutionObservation } from "../src/index.js";
import {
  bindOutcomeSchema,
  contractListSchema,
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
import { assertWireRoundTrip, type Assert, type Exact, type Wire } from "./support/schema-parity.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { appointedWorktreePath, cachedRepositoryAt } from "./support/git.js";
import { contractId } from "../src/core/facts/types.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";

type Result<T extends (...args: never[]) => unknown> = Wire<Awaited<ReturnType<T>>>;
export type Bind = Assert<Exact<z.output<typeof bindOutcomeSchema>, Result<Keis["bind"]>>>;
export type List = Assert<Exact<z.output<typeof contractListSchema>, Result<Keis["list"]>>>;
export type Observe = Assert<Exact<z.output<typeof contractObservationSchema>, Result<Keis["observe"]>>>;
export type Resolve = Assert<Exact<z.output<typeof contractResolutionSchema>, Result<Keis["resolve"]>>>;
export type WaitMany = Assert<Exact<z.output<typeof contractWaitResultSchema>, Result<Keis["wait"]>>>;
export type Reconcile = Assert<Exact<z.output<typeof reconcileResultSchema>, Result<Keis["reconcile"]>>>;
export type State = Assert<Exact<z.output<typeof contractStateSchema>, Result<Kei["state"]>>>;
export type WaitOne = Assert<Exact<z.output<typeof contractWaitResultSchema>, Result<Kei["wait"]>>>;
export type History = Assert<Exact<z.output<typeof contractHistorySchema>, Result<Kei["history"]>>>;
export type Guidance = Assert<Exact<z.output<typeof guidanceSchema>, Result<Kei["guidance"]>>>;
export type Delivery = Assert<Exact<z.output<typeof deliverySchema>, Result<Kei["delivery"]>>>;
export type Amend = Assert<Exact<z.output<typeof amendOutcomeSchema>, Result<Kei["amend"]>>>;
export type Deliver = Assert<Exact<z.output<typeof deliverOutcomeSchema>, Result<Kei["deliver"]>>>;
export type Verify = Assert<Exact<z.output<typeof verifyOutcomeSchema>, Result<Kei["verify"]>>>;
export type Review = Assert<Exact<z.output<typeof reviewOutcomeSchema>, Result<Kei["review"]>>>;
export type Abandon = Assert<Exact<z.output<typeof abandonOutcomeSchema>, Result<Kei["abandon"]>>>;
export type Arc = Assert<Exact<z.output<typeof arcOutcomeSchema>, Result<Kei["arc"]>>>;
export type Preview = Assert<Exact<z.output<typeof deliveryPreviewOutcomeSchema>, Result<Kei["previewDelivery"]>>>;
export type Observation = Assert<Exact<z.output<typeof executionObservationSchema>, Wire<ExecutionObservation>>>;
// Keis.kei returns a process-local handle rather than an operation result.

test("Contract read, wait and terminal mutation wire projections", async () => {
  const repository = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  const bound = accepted(await contracts.bind({ markdown: document(), target: null, gates: ["reviewed"] }));
  assertWireRoundTrip(bindOutcomeSchema, bound);
  assertWireRoundTrip(
    bindOutcomeSchema,
    await contracts.bind({ markdown: document(), after: [contractId("kei/missing")], target: null }),
  );
  const kei = bound.value.kei;
  const state = present(await kei.state());
  assertWireRoundTrip(contractListSchema, await contracts.list());
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
  assert.equal(missingWait.kind, "missing");
  assertWireRoundTrip(contractWaitResultSchema, missingWait);
  const dispatch = await publishDispatch({
    repository: await repositoryAt(repository.path),
    akumaId: parseAkumaId("aku/worker/1234abcd").id,
    contractId: state.id,
  });
  assert.equal(dispatch.kind, "dispatched");
  const history = present(await kei.history());
  assert.ok(history.events.some((event) => event.source === "journal"));
  assert.ok(history.events.some((event) => event.source === "dispatch"));
  assertWireRoundTrip(contractHistorySchema, history);
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
  assert.equal(terminal.kind, "terminal");
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
  const kei = bound.value.kei;
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
  assert.equal(preview.kind, "accepted");
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
