import { z } from "zod";
import { actorId, documentKey, documentSegmentKey, entryUlid, gate, requirementId } from "../core/facts/types.js";
import { parseDependencyKeySet } from "../core/subject.js";
import { changeIdSchema, contractHeadSchema, contractIdSchema, snapshotIdSchema } from "../git/identity.js";

export const gateSchema = z.string().transform((value, context) => {
  try {
    return gate(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid gate" });
    return z.NEVER;
  }
});
export const deliverDataSchema = z
  .strictObject({
    note: z
      .string()
      .refine((value) => value.trim() !== "")
      .exactOptional(),
    tenderSnapshot: snapshotIdSchema,
    integration: z
      .strictObject({ predecessor: snapshotIdSchema, snapshot: snapshotIdSchema, changeId: changeIdSchema })
      .readonly(),
    method: z.literal("squash"),
    policy: z.strictObject({ requireBranchesToBeUpToDate: z.boolean() }).readonly(),
  })
  .readonly();
export const verdictSchema = z.enum(["satisfied", "unsatisfied"]);
export const candidateContentChangeSchema = z
  .strictObject({
    kind: z.literal("candidate-content-changed"),
    target: z.string().exactOptional(),
    previousChange: changeIdSchema,
    currentChange: changeIdSchema,
  })
  .readonly();
export const gateCurrentSchema = z.union([
  z.strictObject({ kind: z.literal("missing") }).readonly(),
  z
    .strictObject({
      kind: z.literal("attested"),
      verdict: verdictSchema,
      at: z.string(),
      summary: z.string().exactOptional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("stale"),
      priorVerdict: verdictSchema,
      reason: candidateContentChangeSchema.exactOptional(),
    })
    .readonly(),
]);
export const requirementIdSchema = z
  .string()
  .min(1)
  .transform((value) => requirementId(value));
export const requirementReportSchema = z
  .strictObject({ requirement: requirementIdSchema, current: gateCurrentSchema })
  .readonly();
export const gateReportSchema = z
  .strictObject({
    gate: gateSchema,
    requirements: z.array(requirementReportSchema).readonly(),
    satisfied: z.boolean(),
    current: gateCurrentSchema,
  })
  .readonly();
const actorIdSchema = z.string().transform(actorId);
const documentKeySchema = z.string().transform(documentKey);
const documentSegmentKeySchema = z.string().transform(documentSegmentKey);
const dependencyKeySetSchema = z.string().transform(parseDependencyKeySet);
export const entryUlidSchema = z.string().transform((value, context) => {
  try {
    return entryUlid(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid entryUlid" });
    return z.NEVER;
  }
});
export const contractTargetSchema = z.union([
  z.string(),
  z
    .strictObject({
      kind: z.literal("contract"),
      contractId: contractIdSchema,
      worktree: z.strictObject({ id: z.string(), identity: z.string() }).readonly(),
    })
    .readonly(),
]);
export const contractCoordinatesSchema = z
  .strictObject({
    start: snapshotIdSchema,
    target: contractTargetSchema.exactOptional(),
    workspace: z.literal("worktree"),
  })
  .readonly();
export const contractTermsSchema = z
  .strictObject({
    document: z.strictObject({ bytes: z.string(), key: documentKeySchema }).readonly(),
    segments: z.array(documentSegmentKeySchema).readonly(),
    gates: z.array(gateSchema).readonly(),
    requirements: z.record(z.string(), z.array(requirementIdSchema).readonly()).readonly(),
    after: z.array(contractIdSchema).readonly(),
  })
  .readonly();
const journalFields = {
  v: z.literal(1),
  contract: contractIdSchema,
  entry: entryUlidSchema,
  at: z.string(),
  actor: actorIdSchema.exactOptional(),
};
export const bindEntrySchema = z
  .strictObject({
    ...journalFields,
    kind: z.literal("bind"),
    data: z.strictObject({ coordinates: contractCoordinatesSchema, terms: contractTermsSchema }).readonly(),
  })
  .readonly();
export const amendEntrySchema = z
  .strictObject({ ...journalFields, kind: z.literal("amend"), data: contractTermsSchema })
  .readonly();
export const deliverEntrySchema = z
  .strictObject({ ...journalFields, kind: z.literal("deliver"), data: deliverDataSchema })
  .readonly();
export const reintegratedEntrySchema = z
  .strictObject({
    ...journalFields,
    kind: z.literal("reintegrated"),
    data: z.strictObject({ predecessor: snapshotIdSchema, snapshot: snapshotIdSchema }).readonly(),
  })
  .readonly();
export const attestationEntrySchema = z
  .strictObject({
    ...journalFields,
    kind: z.literal("attestation"),
    data: z
      .strictObject({
        gate: gateSchema,
        requirement: requirementIdSchema,
        subject: dependencyKeySetSchema,
        verdict: verdictSchema,
        summary: z.string().exactOptional(),
      })
      .readonly(),
  })
  .readonly();
export const claimedEntrySchema = z
  .strictObject({
    ...journalFields,
    kind: z.literal("claimed"),
    data: z.strictObject({ delivery: entryUlidSchema }).readonly(),
  })
  .readonly();
export const arcEntrySchema = z
  .strictObject({
    ...journalFields,
    kind: z.literal("arc"),
    data: z.strictObject({ seq: z.number(), title: z.string(), body: z.string() }).readonly(),
  })
  .readonly();
export const abandonedEntrySchema = z
  .strictObject({
    ...journalFields,
    kind: z.literal("abandoned"),
    data: z.strictObject({ note: z.string().exactOptional() }).readonly(),
  })
  .readonly();
export const journalEntrySchema = z.union([
  bindEntrySchema,
  amendEntrySchema,
  deliverEntrySchema,
  reintegratedEntrySchema,
  attestationEntrySchema,
  claimedEntrySchema,
  arcEntrySchema,
  abandonedEntrySchema,
]);
export const contractStateSchema = z
  .strictObject({
    id: contractIdSchema,
    head: contractHeadSchema.nullable(),
    coordinates: contractCoordinatesSchema,
    terms: contractTermsSchema,
    delivery: deliverEntrySchema.nullable(),
    currentIntegration: deliverDataSchema.unwrap().shape.integration.nullable(),
    attestations: z.array(attestationEntrySchema).readonly(),
    currentArc: arcEntrySchema.exactOptional(),
    terminal: z.union([claimedEntrySchema, abandonedEntrySchema]).nullable(),
  })
  .readonly()
  .nullable();
