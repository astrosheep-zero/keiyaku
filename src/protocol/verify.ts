import { z } from "zod";
import { snapshotIdSchema } from "../git/identity.js";
import type { AttestationData, ChangeId, ContractState, SnapshotId } from "../core/facts/types.js";
import { activeContract, targetContractRefusal, type ActiveContractRefusal } from "../core/facts/observation.js";
import { dependencyKeySet } from "../core/subject.js";
import { decideAttestation, type AttestationInput } from "../core/verbs/attestation.js";
import { holdVerificationSnapshot, materializeScratchCandidate, ScratchMaterializationError } from "../git/scratch.js";
import { associateVerificationSnapshot } from "../git/repository.js";
import { projectSettings } from "../settings.js";
import { executeVerification } from "../verification/execution.js";
import { contractJournal, observeContractsAt } from "../git/observe.js";
import { VERIFIED, verificationRequirement, type VerificationDefinition } from "../verification/declaration.js";
import { prepareDelivery, deliveryIntegrationSnapshots } from "./deliver.js";
import { admitIntent } from "./intent.js";
import type { ProtocolResult } from "./run.js";
import type { DocumentDerivation, MechanicalPreparationRefusal, MutationOperationInput } from "./operations.js";
import { timestamp } from "./operations.js";
import { executionStop, type ContractCheckpoint } from "./progress.js";
import { verifyRefusalSchema, deliverRefusalSchema, verificationDeclarationRefusalSchema } from "./operations.js";
import { placementSchema, normalPlacementSchema } from "./completion.js";
import { activeReasonSchema, retrySchema, compactRetry, compactReason, type Retry } from "./result-reasons.js";

const checkCoordinate = {
  index: z.number().int().positive(),
  requirement: z.string().min(1),
  retainedPath: z.string().exactOptional(),
};
const unavailableCandidateSchema = z
  .strictObject({ kind: z.literal("candidate-unavailable"), diagnostic: z.string().min(1) })
  .readonly();
const runtimeStopSchema = z.union([
  unavailableCandidateSchema,
  z
    .strictObject({ kind: z.enum(["unknown-exit", "cancelled"]), diagnostic: z.string().min(1).exactOptional() })
    .readonly(),
  z
    .strictObject({
      kind: z.enum(["spawn-error", "environment-failure"]),
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
    unavailableCandidateSchema,
    ...retrySchema.options,
    z.strictObject({ kind: z.literal("cancelled") }).readonly(),
  ])
  .meta({ id: "verificationAdmissionStop" });
export type VerificationStop = z.output<typeof runtimeStopSchema | typeof checkAdmissionStopSchema>;
const normalAdmissionSchema = z.enum(["admitted", "reused", "unrecorded"]);
export function verificationAdmissionOutcome(
  admission: z.output<typeof normalAdmissionSchema | typeof checkAdmissionStopSchema>,
): "benign" | "retry" | "failed" {
  if (typeof admission === "string") return "benign";
  switch (admission.kind) {
    case "retry":
      return "retry";
    case "refused":
    case "candidate-unavailable":
    case "cancelled":
      return "failed";
    default: {
      const exhaustive: never = admission;
      return exhaustive;
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
export type VerificationMode = "optimistic" | "strict";

type VerifyOperationInput = MutationOperationInput &
  Readonly<{
    deriveDocument(state: ContractState): DocumentDerivation;
    includeDirty: boolean;
    index?: number;
    verificationMode?: VerificationMode;
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
  changeId: ChangeId;
}>;

async function prepareVerification(
  input: VerifyOperationInput,
  holdIntegration: (snapshot: SnapshotId) => Promise<void>,
): Promise<PreparedVerification | Extract<VerifyOperationResult, { kind: "refused" }>> {
  input.signal?.throwIfAborted();
  const observed = await observeContractsAt(input.scope, input.channel, [input.contractId], { after: true });
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
  const journal = contractJournal(observed.journals, state.id).entries;
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
      holdIntegration,
    },
  );
  if (prepared.kind === "refused") return prepared;
  return {
    kind: "prepared",
    checkpoint: { state, journal },
    definition,
    snapshot: prepared.data.integration.snapshot,
    changeId: prepared.data.integration.changeId,
  };
}

type HeldVerificationSnapshot = Awaited<ReturnType<typeof holdVerificationSnapshot>>;
type VerificationAdmissionRefusal =
  | ActiveContractRefusal
  | { kind: "verification-reuse" }
  | Extract<Retry, { reason: "publication-failed" }>
  | z.output<typeof unavailableCandidateSchema>;

function admitVerificationTestimony(
  input: VerifyOperationInput,
  at: string,
  data: AttestationData,
  { snapshot, cwd: anchor }: HeldVerificationSnapshot,
): Promise<ProtocolResult<VerificationAdmissionRefusal>> {
  return admitIntent<AttestationInput, VerificationAdmissionRefusal>(
    input.channel,
    input.scope,
    { contractId: input.contractId, at, preparation: { kind: "prepared", data } },
    decideAttestation,
    {
      ...(input.progress === undefined ? {} : { progress: input.progress }),
      prepareRefCompanion: async ({ journals }) => {
        const state = contractJournal(journals, input.contractId).state;
        const current = state?.attestations.findLast(
          ({ data: prior }) =>
            prior.gate === data.gate && prior.requirement === data.requirement && prior.subject === data.subject,
        );
        const reuse = current?.data.verdict === data.verdict && current.data.summary === data.summary;
        const result = await associateVerificationSnapshot(input.scope, input.contractId, snapshot, { anchor, reuse });
        if (result.kind === "companion") return result;
        const refusal: VerificationAdmissionRefusal =
          result.kind === "associated"
            ? { kind: "verification-reuse" }
            : result.kind === "publication-failed"
              ? { kind: "retry", reason: result.kind, diagnostic: result.diagnostic }
              : result;
        return { kind: "refused", refusal };
      },
    },
  );
}

// eslint-disable-next-line max-lines-per-function, complexity -- Keep preparation, execution, admission, and retirement in order.
export async function verifyOperation(input: VerifyOperationInput): Promise<VerifyOperationResult> {
  let custody: HeldVerificationSnapshot | undefined;
  let materialize = materializeScratchCandidate;
  try {
    const prepared = await prepareVerification(input, async (snapshot) => {
      try {
        custody = await holdVerificationSnapshot(input.scope, snapshot);
      } catch (error) {
        // The existing materialization stop describes failure to acquire the snapshot as well.
        if (input.signal?.aborted && error instanceof ScratchMaterializationError) {
          input.progress?.recordVerification(input.contractId, snapshot, { leak: error.leak });
        }
        materialize = () => Promise.reject(error);
      }
    });
    if (prepared.kind === "refused") return prepared;
    const { snapshot, changeId, definition } = prepared;
    let checkpoint = prepared.checkpoint;
    const { state, journal } = checkpoint;
    const checks: VerificationCheck[] = [];
    const subject = dependencyKeySet([
      { kind: "snapshot", value: snapshot },
      ...(input.verificationMode === "strict" ? [] : [{ kind: "change" as const, value: changeId }]),
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
        materializeScratchCandidate: materialize,
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
        if (custody === undefined) throw new Error("terminal Verification requires a held snapshot");
        const result = await admitVerificationTestimony(
          input,
          at,
          {
            gate: VERIFIED,
            requirement,
            subject,
            verdict: outcome.verdict,
            ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
          },
          custody,
        ).catch((error: unknown) => {
          const stop = executionStop(state.id, error, input.signal);
          if (stop.reason !== "cancelled") throw error;
          input.progress?.recordStop(stop);
          return null;
        });
        if (result?.kind === "accepted") {
          checkpoint = { state: result.state, journal: result.journal };
          input.progress?.recordResidue(state.id, result);
          admission = "admitted";
        } else if (result?.kind === "refused") {
          const { refusal } = result;
          admission =
            refusal.kind === "verification-reuse"
              ? "reused"
              : refusal.kind === "candidate-unavailable" || refusal.kind === "retry"
                ? refusal
                : { kind: "refused", reason: compactReason(refusal) };
        } else {
          admission = result === null ? { kind: "cancelled" } : compactRetry(result);
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
  } finally {
    if (custody !== undefined) {
      const leak = await custody.dispose();
      if (leak !== null) input.progress?.recordVerification(input.contractId, custody.snapshot, { leak });
    }
  }
}
