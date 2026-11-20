import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import { Keis, Keiyaku, Repo, type ExecutionObservation } from "../src/index.js";
import { describeModelTools, modelJsonSchema } from "../src/library/model-tools.js";
import {
  bindOutcomeSchema,
  deliverOutcomeSchema,
  verifyOutcomeSchema,
  deliverySchema,
} from "../src/library/contract-outcomes.js";
import { contractCatalogueSchema, contractObservationSchema } from "../src/protocol/read/status.js";
import { contractHistorySchema } from "../src/library/contract-types.js";
import { executionObservationSchema } from "../src/protocol/execution-observation.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { appointedWorktreePath, cachedRepositoryAt } from "./support/git.js";

function published(name: string) {
  const tool = describeModelTools().find((entry) => entry.name === name);
  assert.ok(tool);
  return tool;
}

function assertPublishedOutput(name: string, value: unknown) {
  const schema = published(name).outputSchema;
  assert.ok(schema);
  const validate = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(schema)));
  const result = validate(JSON.parse(JSON.stringify(value)));
  assert.ok(result.valid, result.errorMessage);
}

test("publication removes only output safe-integer noise and leaves literal data opaque", () => {
  const authored = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const count = z.number().int().nonnegative();
  const output = modelJsonSchema(z.strictObject({
    count,
    requiredPosition: z.number().int().positive(),
    constant: z.unknown().meta({ const: authored }),
    defaults: z.unknown().meta({ default: authored }),
  }), "output");
  assert.deepEqual(output.properties, {
    count: { type: "integer" },
    requiredPosition: { type: "integer", exclusiveMinimum: 0 },
    constant: { const: authored },
    defaults: { default: authored },
  });
  assert.equal(count.parse(0), 0);
  assert.equal(count.safeParse(-1).success, false);
  assert.equal(count.safeParse(Number.MAX_SAFE_INTEGER + 1).success, false);
  const { inputSchema } = published("history");
  const input = { selector: "kei/example", limit: 5000 };
  const validate = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(inputSchema)));
  assert.equal(validate(input).valid, true);
  assert.equal(validate({ ...input, limit: 5001 }).valid, false);
  assert.equal(Keiyaku.verbs.history.input.safeParse({ ...input, limit: 5001 }).success, false);
});

test("Contract catalogue and addressed status publish the native gate judgment", async () => {
  const repository = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  const bound = accepted(await contracts.bind({ terms: document(), target: null, gates: ["reviewed"] }));
  assertWireRoundTrip(bindOutcomeSchema, bound);
  const kei = bound.kei;
  const state = present(await kei.state());
  const catalogue = await contracts.list();
  assertWireRoundTrip(contractCatalogueSchema, catalogue);
  const observation = await contracts.observe({ id: state.id });
  assertWireRoundTrip(contractObservationSchema, observation);
  assert.ok(observation.kind === "contract");
  assert.deepEqual(observation.gates, [{
    gate: "reviewed",
    current: "missing",
    requirements: [{ requirement: "gate:reviewed", current: { kind: "missing" } }],
  }]);
  assert.deepEqual(catalogue.rows?.[0]?.gates, [{ gate: "reviewed", current: "missing" }]);
  const facet = Keiyaku.for({ cwd: repository.path, environment: {} });
  assertPublishedOutput("ls", await facet.ls({ selector: "kei/" }));
  assertPublishedOutput("status", await facet.status({ selector: state.id }));
  assertPublishedOutput("status", await facet.status());
});

test("delivery and verification publish native results and historical delivery provenance", async () => {
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
  assertPublishedOutput("verify", verify);
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

});
