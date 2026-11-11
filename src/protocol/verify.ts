import { z } from "zod";
import { snapshotIdSchema } from "../git/identity.js";
import type { ContractState, SnapshotId } from "../core/facts/types.js";
import { activeContract, targetContractRefusal } from "../core/facts/observation.js";
import { observeGitForAdmissionAt } from "../git/observe.js";
import { VERIFIED, verificationRequirement, type VerificationDefinition } from "../verification/declaration.js";
import { prepareDelivery, deliveryIntegrationSnapshots } from "./deliver.js";
import { verifyRequirement } from "./intent.js";
import type { DocumentDerivation, MechanicalPreparationRefusal, MutationOperationInput } from "./operations.js";
import { timestamp, unpackVerificationOutcome } from "./operations.js";
import { executionStop, type ContractCheckpoint } from "./progress.js";
import {
  verificationStopSchema as rawVerificationStopSchema,
  verifyRefusalSchema,
  deliverRefusalSchema,
  verificationDeclarationRefusalSchema,
} from "./operations.js";
import { placementSchema, normalPlacementSchema } from "./completion.js";
import { activeReasonSchema, retrySchema, compactRetry, compactReason } from "./result-reasons.js";

const checkCoordinate = {
  index: z.number().int().positive(),
  requirement: z.string().min(1),
  retainedPath: z.string().exactOptional(),
};
const runtimeStopSchema = z.union([
  z
    .strictObject({ kind: z.enum(["unknown-exit", "cancelled"]), diagnostic: z.string().min(1).exactOptional() })
    .readonly(),
  z
    .strictObject({
      kind: z.enum(["candidate-unavailable", "spawn-error", "environment-failure"]),
      diagnostic: z.string().min(1),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("environment-hook-failure"),
      name: z.string().min(1),
      diagnostic: z.string().min(1),
    })
    .readonly(),
]);
const checkAdmissionStopSchema = z
  .union([
    z.strictObject({ kind: z.literal("refused"), reason: activeReasonSchema }).readonly(),
    ...retrySchema.options,
    z.strictObject({ kind: z.literal("cancelled") }).readonly(),
  ])
  .meta({ id: "verificationAdmissionStop" });
export type VerificationStop = z.output<typeof runtimeStopSchema | typeof checkAdmissionStopSchema>;
const normalAdmissionSchema = z.enum(["admitted", "reused", "unrecorded"]);
function terminalCheckSchemas<Admission extends z.ZodType>(admission: Admission) {
  const terminal = { ...checkCoordinate, kind: z.literal("terminal"), admission };
  return [
    z.strictObject({ ...terminal, verdict: z.literal("satisfied") }).readonly(),
    z.strictObject({ ...terminal, verdict: z.literal("unsatisfied"), summary: z.string() }).readonly(),
  ] as const;
}
const normalVerificationCheckSchema = z.union(terminalCheckSchemas(normalAdmissionSchema));
const verificationCheckSchema = z.union([
  ...terminalCheckSchemas(z.union([normalAdmissionSchema, checkAdmissionStopSchema])),
  z.strictObject({ ...checkCoordinate, kind: z.literal("stopped"), stop: runtimeStopSchema }).readonly(),
]);
function verifyValue<Check extends z.ZodType, Placement extends z.ZodType>(check: Check, placement: Placement) {
  return z
    .strictObject({
      snapshot: snapshotIdSchema,
      checks: z.array(check).readonly(),
      placement: placement.exactOptional(),
    })
    .readonly();
}
export const verifyNormalValueSchema = verifyValue(normalVerificationCheckSchema, normalPlacementSchema);
export const verifyValueSchema = verifyValue(verificationCheckSchema, placementSchema);
export type VerificationCheck = z.output<typeof verificationCheckSchema>;
export type VerifyValue = z.output<typeof verifyValueSchema>;

type VerificationCoordinate = Readonly<{
  index: number;
  requirement: string;
  retainedPath?: string;
}>;

function compactVerificationStop(stop: z.output<typeof rawVerificationStopSchema>): VerificationStop {
  if ("refusal" in stop) return { kind: "refused", reason: compactReason(stop.refusal) };
  if ("retry" in stop) return compactRetry(stop.retry);
  switch (stop.failure) {
    case "cancelled":
    case "unknown-exit":
      return stop.diagnostic === undefined
        ? { kind: stop.failure }
        : { kind: stop.failure, diagnostic: stop.diagnostic };
    case "environment-failure":
      return "name" in stop
        ? { kind: "environment-hook-failure", name: stop.name, diagnostic: stop.diagnostic }
        : { kind: stop.failure, diagnostic: stop.diagnostic };
    case "candidate-unavailable":
    case "spawn-error":
      return { kind: stop.failure, diagnostic: stop.diagnostic };
  }
}

type VerifyAcceptedValue = Readonly<{ snapshot: SnapshotId; checks: readonly VerificationCheck[] }>;

type VerifyRefusal =
  | z.infer<typeof verifyRefusalSchema>
  | z.infer<typeof deliverRefusalSchema>
  | MechanicalPreparationRefusal
  | z.infer<typeof verificationDeclarationRefusalSchema>;
type VerifyOperationInput = MutationOperationInput &
  Readonly<{
    deriveDocument(state: ContractState): DocumentDerivation;
    includeDirty: boolean;
    index?: number;
    requireBranchesToBeUpToDate: boolean;
    signal?: AbortSignal;
  }>;
export type VerifyOperationResult =
  | Readonly<{ kind: "refused"; refusal: VerifyRefusal }>
  | Readonly<{ kind: "accepted"; checkpoint?: ContractCheckpoint; value: VerifyAcceptedValue }>;

type PreparedVerification = Readonly<{
  kind: "prepared";
  checkpoint: ContractCheckpoint;
  definition: VerificationDefinition;
  snapshot: SnapshotId;
}>;

async function prepareVerification(
  input: VerifyOperationInput,
): Promise<PreparedVerification | Extract<VerifyOperationResult, { kind: "refused" }>> {
  input.signal?.throwIfAborted();
  const observed = await observeGitForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = activeContract(observed.decision, input.contractId);
  if ("kind" in state) return { kind: "refused", refusal: state };
  const targetRefusal = targetContractRefusal(observed.decision, state.coordinates.target);
  if (targetRefusal !== undefined) return { kind: "refused", refusal: targetRefusal };
  const derivation = input.deriveDocument(state);
  if (derivation.verification.kind === "refused") return { kind: "refused", refusal: derivation.verification.refusal };
  const definition = derivation.verification.data;
  if (input.index !== undefined && input.index > definition.declarations.length)
    return {
      kind: "refused",
      refusal: {
        kind: "verification-index-out-of-range",
        total: definition.declarations.length,
      },
    };
  const journal = observed.journals.get(state.id)?.entries;
  if (journal === undefined) throw new Error("verification requires the captured Contract journal");
  const prepared = await prepareDelivery(
    input.scope,
    {
      contractId: state.id,
      coordinates: state.coordinates,
      recordedIntegrations: deliveryIntegrationSnapshots(journal),
    },
    {
      title: derivation.title,
      document: derivation.bytes,
      includeDirty: input.includeDirty,
      requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    },
  );
  if (prepared.kind === "refused") return prepared;
  return { kind: "prepared", checkpoint: { state, journal }, definition, snapshot: prepared.data.integration.snapshot };
}

function checkReport(
  coordinate: VerificationCoordinate,
  checked: ReturnType<typeof unpackVerificationOutcome>,
): VerificationCheck {
  const { index, requirement, retainedPath } = coordinate;
  const fields = { index, requirement, ...(retainedPath === undefined ? {} : { retainedPath }) };
  if (checked.counts === undefined) {
    if (checked.stop === undefined) throw new Error("nonterminal verification requires a stop");
    const stop = compactVerificationStop(checked.stop);
    if (stop.kind === "refused" || stop.kind === "retry") throw new Error("nonterminal check requires a runtime stop");
    return { ...fields, kind: "stopped", stop };
  }
  let admission: z.output<typeof checkAdmissionStopSchema> | "admitted" | "reused" | "unrecorded";
  if (checked.reuse !== undefined) admission = "reused";
  else if (checked.admission !== undefined) admission = "admitted";
  else if (checked.stop !== undefined) {
    const stop = compactVerificationStop(checked.stop);
    if (stop.kind === "refused" || stop.kind === "retry") admission = stop;
    else if (stop.kind === "cancelled") admission = { kind: "cancelled" };
    else throw new Error("terminal check admission can only refuse, retry or cancel");
  } else admission = "unrecorded";
  const terminal = { ...fields, kind: "terminal" as const, admission };
  if (checked.counts.verdict === "satisfied") return { ...terminal, verdict: "satisfied" };
  if (checked.counts.summary === undefined) throw new Error("unsatisfied terminal check requires its diagnosis");
  return { ...terminal, verdict: "unsatisfied", summary: checked.counts.summary };
}

/** Capture a prospective delivery, then independently execute each selected declaration. */
export async function verifyOperation(input: VerifyOperationInput): Promise<VerifyOperationResult> {
  const prepared = await prepareVerification(input);
  if (prepared.kind === "refused") return prepared;
  const { snapshot, definition } = prepared;
  let checkpoint = prepared.checkpoint;
  const { state, journal } = checkpoint;
  const checks: VerificationCheck[] = [];
  // This observation carries no new fact. It supplies the exact head even when every admission reuses testimony.
  input.progress?.recordAdmission({ kind: "accepted", facts: [], state, journal });
  const selected = definition.declarations
    .map((declaration, offset) => ({ declaration, index: offset + 1 }))
    .filter(({ index }) => input.index === undefined || input.index === index);
  for (const { declaration, index } of selected) {
    if (input.signal?.aborted) {
      input.progress?.recordStop(executionStop(state.id, input.signal.reason, input.signal));
      break;
    }
    const requirement = verificationRequirement(declaration);
    const result = await verifyRequirement({
      channel: input.channel,
      repository: input.scope,
      contractId: state.id,
      gates: state.terms.gates,
      at: timestamp(),
      snapshot,
      declaration,
      requirement,
      index,
      total: definition.declarations.length,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.progress === undefined ? {} : { progress: input.progress }),
    });
    const checked = unpackVerificationOutcome(result);
    if (checked.admission !== undefined)
      checkpoint = { state: checked.admission.state, journal: checked.admission.journal };
    const coordinate = {
      index,
      requirement,
      ...(result.leak?.path === undefined ? {} : { retainedPath: result.leak.path }),
    };
    const check = checkReport(coordinate, checked);
    checks.push(check);
    input.progress?.recordVerificationCheck(state.id, snapshot, check);
    if (checked.stop !== undefined) break;
  }
  return {
    kind: "accepted",
    ...(state.terms.gates.includes(VERIFIED) ? { checkpoint } : {}),
    value: { snapshot, checks },
  };
}
