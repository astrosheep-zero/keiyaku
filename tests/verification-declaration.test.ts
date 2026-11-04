import assert from "node:assert/strict";
import test from "node:test";
import { prepareAmendDocument } from "../src/body/amend.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { renderContractBody } from "../src/body/render.js";
import type { ContractBody } from "../src/body/types.js";
import { gate } from "../src/core/facts/types.js";
import { contractTerms, documentDerivation } from "../src/library/input.js";
import { singletonRequirement, verificationRequirement } from "../src/verification/declaration.js";

const first = { executor: "bash", script: "npm run build && npm test", timeoutMs: 600_000 } as const;
const second = { executor: "bash", script: "npm run test:typecheck", timeoutMs: 300_000 } as const;
const body: ContractBody = {
  title: "Independent checks",
  context: "Run independent checks.",
  objective: "Retain separate evidence.",
  design: "Derive identities at the document boundary.",
  region: ["src/**"],
  criteria: [{ title: "Independent", body: "Checks retain their own evidence." }],
  verification: [first, second],
  extensions: [],
};

function document(overrides: Partial<ContractBody> = {}) {
  return decodeContractDocument(renderContractBody({ ...body, ...overrides }));
}

test("declaration identity includes only canonical executor, script, and declared deadline", () => {
  const identity = verificationRequirement(first);
  assert.equal(
    verificationRequirement({ timeoutMs: first.timeoutMs, script: first.script, executor: first.executor }),
    identity,
  );
  assert.notEqual(verificationRequirement({ ...first, executor: "zsh" }), identity);
  assert.notEqual(verificationRequirement({ ...first, script: "npm test" }), identity);
  assert.notEqual(verificationRequirement({ ...first, timeoutMs: 1_000 }), identity);
  assert.notEqual(verificationRequirement({ executor: first.executor, script: first.script }), identity);
});

test("document requirements preserve independent declarations through reorder, amendment, and forked title", () => {
  const selected = [gate("reviewed"), gate("verified"), gate("security")];
  const original = contractTerms(document(), selected, []);
  assert.deepEqual(original.requirements, {
    reviewed: [singletonRequirement(gate("reviewed"))],
    verified: [verificationRequirement(first), verificationRequirement(second)],
    security: [singletonRequirement(gate("security"))],
  });
  const reordered = contractTerms(document({ verification: [second, first] }), selected, []);
  assert.deepEqual(reordered.requirements.verified, [...original.requirements.verified!].reverse());
  assert.deepEqual(
    contractTerms(document({ title: "Fork of independent checks" }), selected, []).requirements,
    original.requirements,
  );
  const amended = prepareAmendDocument(
    "## Replace: Verification\n```bash timeout=10m\nnpm run build && npm test\n```\n```bash timeout=5m\nnpm run lint\n```\n",
  )(document());
  const changed = contractTerms(decodeContractDocument(amended.document), selected, []).requirements.verified!;
  assert.equal(changed[0], original.requirements.verified![0]);
  assert.notEqual(changed[1], original.requirements.verified![1]);
  assert.deepEqual(contractTerms(document({ verification: [second] }), selected, []).requirements.verified, [
    verificationRequirement(second),
  ]);
});

test("exact duplicate declarations collapse obligations without losing their invocation indexes", () => {
  const decoded = document({ verification: [first, second, first] });
  assert.deepEqual(contractTerms(decoded, [gate("verified")], []).requirements.verified, [
    verificationRequirement(first),
    verificationRequirement(second),
  ]);
  const prepared = documentDerivation(decoded, [gate("verified")]).verification;
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind === "prepared") assert.equal(prepared.data!.declarations.length, 3);
});

test("an unselected Verification section is inert and selected Verification still requires declarations", () => {
  assert.deepEqual(contractTerms(document(), [gate("reviewed")], []).requirements, {
    reviewed: [singletonRequirement(gate("reviewed"))],
  });
  assert.deepEqual(contractTerms(document(), [], []).requirements, {});
  const noChecks = document({ verification: [] });
  assert.equal(documentDerivation(noChecks, [gate("verified")]).verification.kind, "refused");
});
