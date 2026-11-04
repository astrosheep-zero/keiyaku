import type { z } from "zod";
import type { AttestationData, ContractState, EntryUlid, SnapshotId } from "../core/facts/types.js";
import { activeContract, documentIsCurrent, targetContractRefusal } from "../core/facts/observation.js";
import { observeGitForAdmissionAt } from "../git/observe.js";
import { VERIFIED, verificationRequirement, type VerificationDefinition } from "../verification/declaration.js";
import { prepareDelivery, deliveryIntegrationSnapshots } from "./deliver.js";
import { verifyRequirement } from "./intent.js";
import type { DocumentDerivation, MutationOperationInput, VerificationStop } from "./operations.js";
import { timestamp, unpackVerificationOutcome } from "./operations.js";
import { executionStop, type ContractCheckpoint } from "./progress.js";
import {
  verifyRefusalSchema,
  deliverRefusalSchema,
  deliveryPreparationRefusalSchema,
  verificationDeclarationRefusalSchema,
} from "./operations.js";
import type { CompletionEvidence } from "./completion.js";

type VerificationCoordinate = Readonly<{
  index: number;
  requirement: string;
  snapshot: SnapshotId;
  retainedPath?: string;
}>;
type VerificationAdmission =
  | Readonly<{ kind: "admitted" | "reused"; entry: EntryUlid }>
  | Readonly<{ kind: "stopped"; stop: VerificationStop }>;
export type VerificationCheck = VerificationCoordinate &
  (
    | Readonly<{
        kind: "terminal";
        verdict: AttestationData["verdict"];
        summary?: string;
        admission: VerificationAdmission;
      }>
    | Readonly<{ kind: "stopped"; stop: VerificationStop }>
  );
export type VerifyValue = CompletionEvidence &
  Readonly<{
    snapshot: SnapshotId;
    checks: readonly VerificationCheck[];
  }>;

type VerifyRefusal =
  | z.infer<typeof verifyRefusalSchema>
  | z.infer<typeof deliverRefusalSchema>
  | z.infer<typeof deliveryPreparationRefusalSchema>
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
  | Readonly<{ kind: "accepted"; checkpoint: ContractCheckpoint; value: VerifyValue }>;

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
  const targetRefusal = targetContractRefusal(observed.decision, state.id, state.coordinates.target);
  if (targetRefusal !== undefined) return { kind: "refused", refusal: targetRefusal };
  const derivation = input.deriveDocument(state);
  if (!documentIsCurrent(state, derivation.document))
    return { kind: "refused", refusal: { kind: "document-moved", contractId: state.id } };
  if (derivation.verification.kind === "refused") return { kind: "refused", refusal: derivation.verification.refusal };
  const definition = derivation.verification.data;
  if (definition === null)
    return { kind: "refused", refusal: { kind: "verification-not-selected", contractId: state.id } };
  if (input.index !== undefined && input.index > definition.declarations.length)
    return {
      kind: "refused",
      refusal: {
        kind: "verification-index-out-of-range",
        contractId: state.id,
        index: input.index,
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
  if (checked.counts === undefined) {
    if (checked.stop === undefined) throw new Error("nonterminal verification requires a stop");
    return { ...coordinate, kind: "stopped", stop: checked.stop };
  }
  const attestation = checked.admission?.facts.find(
    (fact) =>
      fact.kind === "attestation" && fact.data.gate === VERIFIED && fact.data.requirement === coordinate.requirement,
  );
  const admittedEntry = attestation?.entry;
  const admission =
    checked.reuse !== undefined
      ? { kind: "reused" as const, entry: checked.reuse.entry }
      : admittedEntry !== undefined
        ? { kind: "admitted" as const, entry: admittedEntry }
        : checked.stop !== undefined
          ? { kind: "stopped" as const, stop: checked.stop }
          : undefined;
  if (admission === undefined) throw new Error("terminal verification requires its admission conclusion");
  return {
    ...coordinate,
    kind: "terminal",
    verdict: checked.counts.verdict,
    ...(checked.counts.summary === undefined ? {} : { summary: checked.counts.summary }),
    admission,
  };
}

/** Capture a prospective delivery without admitting a candidate, then independently attest each check. */
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
      input.progress?.recordStop(executionStop(state.id, "verification", input.signal.reason, input.signal));
      break;
    }
    const requirement = verificationRequirement(declaration);
    const result = await verifyRequirement({
      channel: input.channel,
      repository: input.scope,
      contractId: state.id,
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
      snapshot,
      ...(result.leak?.path === undefined ? {} : { retainedPath: result.leak.path }),
    };
    const check = checkReport(coordinate, checked);
    checks.push(check);
    input.progress?.recordVerificationCheck(state.id, check);
    if (checked.stop !== undefined) break;
  }
  return { kind: "accepted", checkpoint, value: { snapshot, checks } };
}
