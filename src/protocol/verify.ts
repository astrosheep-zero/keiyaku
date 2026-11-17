import { z } from "zod";
import { snapshotIdSchema } from "../git/identity.js";
import type { AttestationData, ContractState, SnapshotId } from "../core/facts/types.js";
import { activeContract, targetContractRefusal, type ActiveContractRefusal } from "../core/facts/observation.js";
import { dependencyKeySet } from "../core/subject.js";
import { decideAttestation, type AttestationInput } from "../core/verbs/attestation.js";
import { materializeScratchCandidate } from "../git/scratch.js";
import { projectSettings } from "../settings.js";
import { executeVerification } from "../verification/execution.js";
import { observeGitForAdmissionAt } from "../git/observe.js";
import { VERIFIED, verificationRequirement, type VerificationDefinition } from "../verification/declaration.js";
import { prepareDelivery, deliveryIntegrationSnapshots } from "./deliver.js";
import { admitIntent } from "./intent.js";
import type { ProtocolResult } from "./run.js";
import type { DocumentDerivation, MechanicalPreparationRefusal, MutationOperationInput } from "./operations.js";
import { timestamp } from "./operations.js";
import { executionStop, type ContractCheckpoint } from "./progress.js";
import { verifyRefusalSchema, deliverRefusalSchema, verificationDeclarationRefusalSchema } from "./operations.js";
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
export function verificationAdmissionOutcome(
  admission: z.output<typeof normalAdmissionSchema | typeof checkAdmissionStopSchema>,
): "benign" | "retry" | "failed" {
  switch (admission) {
    case "admitted":
    case "reused":
    case "unrecorded":
      return "benign";
    default:
      switch (admission.kind) {
        case "retry":
          return "retry";
        case "refused":
        case "cancelled":
          return "failed";
        default: {
          const exhaustive: never = admission;
          return exhaustive;
        }
      }
  }
}

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
    },
  );
  if (prepared.kind === "refused") return prepared;
  return { kind: "prepared", checkpoint: { state, journal }, definition, snapshot: prepared.data.integration.snapshot };
}

function admitVerificationTestimony(
  input: VerifyOperationInput,
  at: string,
  data: AttestationData,
): Promise<ProtocolResult<ActiveContractRefusal | { kind: "verification-reuse" }>> {
  return admitIntent<AttestationInput, ActiveContractRefusal | { kind: "verification-reuse" }>(
    input.channel,
    input.scope,
    { contractId: input.contractId, at, preparation: { kind: "prepared", data } },
    decideAttestation,
    {
      ...(input.progress === undefined ? {} : { progress: input.progress }),
      validateAdmission: (observation) => {
        const state = activeContract(observation.decision, input.contractId);
        if ("kind" in state) return undefined;
        const current = [...state.attestations]
          .reverse()
          .find(
            (attestation) =>
              attestation.data.gate === data.gate &&
              attestation.data.requirement === data.requirement &&
              attestation.data.subject === data.subject,
          );
        if (current?.data.verdict === data.verdict && current.data.summary === data.summary)
          return { kind: "verification-reuse" };
        return undefined;
      },
    },
  );
}

/** Capture a prospective delivery, then independently execute each selected declaration. */
// eslint-disable-next-line max-lines-per-function, complexity -- Keep execution, admission, and final checks in one ordered loop.
export async function verifyOperation(input: VerifyOperationInput): Promise<VerifyOperationResult> {
  const prepared = await prepareVerification(input);
  if (prepared.kind === "refused") return prepared;
  const { snapshot, definition } = prepared;
  let checkpoint = prepared.checkpoint;
  const { state, journal } = checkpoint;
  const checks: VerificationCheck[] = [];
  const subject = dependencyKeySet([
    { kind: "snapshot", value: snapshot },
    ...(state.targetRevision === undefined ? [] : [{ kind: "target" as const, value: state.targetRevision }]),
  ]);
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
    const at = timestamp();
    const execution = await executeVerification({
      repository: input.scope,
      candidate: snapshot,
      contractId: state.id,
      declaration,
      requirement,
      index,
      total: definition.declarations.length,
      materializeScratchCandidate,
      projectSettings,
      observe: (observation) =>
        input.progress?.observe({ kind: "verification", contractId: state.id, snapshot, observation }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    input.progress?.recordVerification(state.id, snapshot, execution, { requirement, index });
    const coordinate = {
      index,
      requirement,
      ...(execution.leak?.path === undefined ? {} : { retainedPath: execution.leak.path }),
    };
    const { outcome } = execution;
    let check: VerificationCheck;
    if (outcome.kind !== "terminal") {
      const stop =
        outcome.kind === "environment-failure" && "name" in outcome
          ? { ...outcome, kind: "environment-hook-failure" as const }
          : outcome;
      check = { ...coordinate, kind: "stopped", stop };
      checks.push(check);
      input.progress?.recordVerificationCheck(state.id, snapshot, check);
      break;
    }
    let admission: Extract<VerificationCheck, { kind: "terminal" }>["admission"] = "unrecorded";
    if (state.terms.gates.includes(VERIFIED)) {
      try {
        const result = await admitVerificationTestimony(input, at, {
          gate: VERIFIED,
          requirement,
          subject,
          verdict: outcome.verdict,
          ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
        });
        if (result.kind === "accepted") {
          checkpoint = { state: result.state, journal: result.journal };
          input.progress?.recordResidue(state.id, result);
          admission = "admitted";
        } else if (result.kind === "refused") {
          admission =
            result.refusal.kind === "verification-reuse"
              ? "reused"
              : { kind: "refused", reason: compactReason(result.refusal) };
        } else {
          admission = compactRetry(result);
        }
      } catch (error) {
        const stop = executionStop(state.id, error, input.signal);
        if (stop.reason !== "cancelled") throw error;
        input.progress?.recordStop(stop);
        admission = { kind: "cancelled" };
      }
    }
    const terminal = { ...coordinate, kind: "terminal" as const, admission };
    if (outcome.verdict === "satisfied") {
      check = { ...terminal, verdict: "satisfied" };
    } else {
      if (outcome.summary === undefined) throw new Error("unsatisfied terminal check requires its diagnosis");
      check = { ...terminal, verdict: "unsatisfied", summary: outcome.summary };
    }
    checks.push(check);
    input.progress?.recordVerificationCheck(state.id, snapshot, check);
    if (typeof check.admission !== "string") break;
  }
  return {
    kind: "accepted",
    ...(state.terms.gates.includes(VERIFIED) ? { checkpoint } : {}),
    value: { snapshot, checks },
  };
}
