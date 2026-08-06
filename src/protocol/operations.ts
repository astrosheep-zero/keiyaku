import { prepareDelivery } from "../carrier/delivery.js";
import { mintContractId, mintSnapshotId } from "../carrier/identity.js";
import { observeBindCoordinates, observeCarrier, observeContract } from "../carrier/observe.js";
import { deliveryWorktreePath, reconcile, reconcileBatch, type ReconcileResult } from "../carrier/reconcile.js";
import { readRef, repositoryAt, type GitRepository } from "../carrier/repository.js";
import { readDeliveryDiff } from "../carrier/verification.js";
import { foldJournal } from "../core/facts/fold.js";
import { currentSubject } from "../core/subject.js";
import type {
  AmendData, ArcData, AttestationData, BindData, ChangeId, ContractBody, ContractId, ContractState, JournalEntry, SnapshotId,
} from "../core/facts/types.js";
import { decideAbandon, type AbandonRefusal } from "../core/verbs/abandon.js";
import { decideAmend, type AmendRefusal } from "../core/verbs/amend.js";
import { decideArc, type ArcRefusal } from "../core/verbs/arc.js";
import { decideBind, type BindRefusal } from "../core/verbs/bind.js";
import { decideDeliver, type DeliverRefusal } from "../core/verbs/deliver.js";
import type { PlacementRefusal } from "../core/verbs/placement.js";
import { decideAttestation, type AttestationRefusal } from "../core/verbs/attestation.js";
import { produceVerification } from "../verification/producer.js";
import {
  admitAbandon,
  admitAmend,
  admitArc,
  admitBind,
  admitDeliver,
  admitReview,
  placeIfEligible,
  verifyPreparedDelivery,
  verifyStoredDelivery,
} from "./intent.js";
import { readAudit, type AuditReport } from "./read/audit.js";
import { readStatus, type StatusReport } from "./read/status.js";
import type { ProtocolResult, ProtocolTerminal } from "./run.js";

export type { AuditReport, FactKind, TimelineEntry } from "./read/audit.js";
export type { ContractStatus, StatusReport } from "./read/status.js";

export type DeliveryPreparationRefusal = Readonly<{
  kind: "target-missing" | "candidate-not-based-on-target";
  contractId: ContractId;
}>;

export type IntentRefusal =
  | AbandonRefusal | AmendRefusal | ArcRefusal | BindRefusal | DeliverRefusal
  | DeliveryPreparationRefusal | PlacementRefusal | AttestationRefusal;

export type IntentRetry = ProtocolTerminal;
export type IntentReceipt = Readonly<{ facts: readonly JournalEntry[]; prior: ContractState | null; snapshot: ContractState }>;
export type IntentOutcome<Value, Refusal = IntentRefusal> =
  | Readonly<{ kind: "accepted"; receipt: IntentReceipt; value: Value }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "retry"; reason: IntentRetry }>;

type OperationInput = Readonly<{ scope: RepositoryScope; contractId: ContractId; actor?: string }>;

function timestamp(): string {
  return new Date().toISOString();
}

function accepted<Value, Refusal = IntentRefusal>(
  id: ContractId,
  facts: readonly JournalEntry[],
  value: Value,
  prior: ContractState | null,
  snapshot: ContractState,
): IntentOutcome<Value, Refusal> {
  if (snapshot.id !== id) throw new TypeError(`accepted snapshot does not belong to ${id}`);
  return { kind: "accepted", receipt: { facts, prior, snapshot }, value };
}

function complete<Value, Refusal>(
  id: ContractId,
  result: ProtocolResult<null, Refusal>,
  value: Value,
): IntentOutcome<Value, Refusal> {
  if (result.kind === "refused") return { kind: "refused", refusal: result.refusal };
  if (result.kind !== "handoff") return { kind: "retry", reason: result };
  const snapshot = result.handoff.snapshot;
  return accepted<Value, Refusal>(
    id,
    result.handoff.acceptedEntries,
    value,
    result.handoff.prior,
    foldJournal(snapshot.id, snapshot.entries, snapshot.head),
  );
}

export type ScopeOperationInput = Readonly<{ coordinate: string }>;
export type RepositoryScope = GitRepository;

/** Resolve the caller worktree and its shared repository scope once. */
export function scopeOperation(input: ScopeOperationInput): RepositoryScope {
  return repositoryAt(input.coordinate);
}

export function statusOperation(input: Readonly<{ scope: RepositoryScope }>): StatusReport {
  return readStatus(input.scope);
}

export type BindOperationInput = Readonly<{
  scope: RepositoryScope; body: ContractBody; target?: string; workspace: "worktree" | "here"; actor?: string;
}>;

export function bindOperation(input: BindOperationInput): IntentOutcome<Readonly<{ contractId: ContractId }>, BindRefusal> {
  const id = mintContractId();
  const carrier = input.scope;
  const observed = observeBindCoordinates(carrier, input.target);
  const data: BindData = {
    coordinates: {
      start: observed.start,
      ...(observed.target === undefined ? {} : { target: observed.target }),
      workspace: input.workspace,
    },
    body: input.body,
  };
  return complete(
    id,
    admitBind(carrier, { contractId: id, ...(input.actor === undefined ? {} : { actor: input.actor }), at: timestamp(), data }, decideBind),
    { contractId: id },
  );
}

export function stateOperation(input: OperationInput): ContractState {
  const state = observeContract(input.scope, input.contractId).state;
  if (state === null) throw new Error(`contract does not exist: ${input.contractId}`);
  return state;
}

/** Read a contract state for facade preparation without turning absence into an exception. */
export function readStateOperation(input: OperationInput): ContractState | null {
  return observeContract(input.scope, input.contractId).state;
}

/** Read the deterministic managed worktree path without exposing carrier state. */
export function worktreePathOperation(input: OperationInput): string | null {
  const carrier = input.scope;
  const state = observeContract(carrier, input.contractId).state;
  if (state?.coordinates?.workspace !== "worktree") return null;
  return deliveryWorktreePath(carrier, input.contractId);
}

export function deliveryOperation(
  input: OperationInput,
): DeliveryOperationValue | null {
  const state = observeContract(input.scope, input.contractId).state;
  if (state === null || state.delivery === null) return null;
  const reviewSubject = currentSubject(state, "reviewed");
  if (reviewSubject === null) throw new Error(`delivery subject is absent: ${input.contractId}`);
  return {
    snapshotId: state.delivery.data.candidate,
    changeId: state.delivery.data.deliveryPatchId,
    expectedPredecessor: state.delivery.data.expectedPredecessor,
    reviewSubject,
  };
}

export type DeliveryDiffOperationInput = Readonly<{
  scope: RepositoryScope;
  expectedPredecessor: SnapshotId;
  snapshotId: SnapshotId;
}>;

export async function deliveryDiffOperation(input: DeliveryDiffOperationInput): Promise<string | null> {
  return readDeliveryDiff(input.scope, input.expectedPredecessor, input.snapshotId);
}

export function amendOperation(
  input: OperationInput & Readonly<{ body: AmendData }>,
): IntentOutcome<void, AmendRefusal> {
  return complete(
    input.contractId,
    admitAmend(input.scope, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      data: input.body,
    }, decideAmend),
    undefined,
  );
}

export type DeliveryOperationValue = Readonly<{
  snapshotId: SnapshotId;
  changeId: ChangeId;
  expectedPredecessor: SnapshotId;
  reviewSubject: AttestationData["subject"];
}>;

type PreparedDeliveryValue = Omit<DeliveryOperationValue, "reviewSubject">;

export async function deliverOperation(input: OperationInput): Promise<IntentOutcome<DeliveryOperationValue>> {
  const carrier = input.scope;
  const prepared = prepareDelivery(carrier, input.contractId);
  if (prepared.kind === "refused") return { kind: "refused", refusal: prepared.refusal as DeliveryPreparationRefusal };

  const preparedValue: PreparedDeliveryValue = {
    snapshotId: prepared.delivery.candidate,
    changeId: prepared.delivery.deliveryPatchId,
    expectedPredecessor: prepared.delivery.expectedPredecessor,
  };
  const first = complete(
    input.contractId,
    admitDeliver(carrier, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      data: prepared.delivery,
    }, decideDeliver),
    preparedValue,
  );
  if (first.kind !== "accepted") return first;
  const reviewSubject = currentSubject(first.receipt.snapshot, "reviewed");
  if (reviewSubject === null) throw new Error(`delivery subject is absent: ${input.contractId}`);
  const value: DeliveryOperationValue = { ...preparedValue, reviewSubject };

  const facts = [...first.receipt.facts];
  let snapshot = first.receipt.snapshot;
  const verification = await verifyPreparedDelivery({
    repository: carrier,
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    prepared,
    environment: process.env,
    produce: produceVerification,
  });
  if (verification?.kind === "handoff") {
    const acceptedVerification = complete(input.contractId, verification, undefined);
    if (acceptedVerification.kind === "accepted") {
      facts.push(...acceptedVerification.receipt.facts);
      snapshot = acceptedVerification.receipt.snapshot;
    }
  }

  const placement = placeIfEligible(carrier, {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
  });
  if (placement?.kind === "handoff") {
    const acceptedPlacement = complete(input.contractId, placement, undefined);
    if (acceptedPlacement.kind === "accepted") {
      facts.push(...acceptedPlacement.receipt.facts);
      snapshot = acceptedPlacement.receipt.snapshot;
    }
  }
  return accepted(input.contractId, facts, value, first.receipt.prior, snapshot);
}

export function abandonOperation(
  input: OperationInput & Readonly<{ note?: string }>,
): IntentOutcome<void, AbandonRefusal> {
  const carrier = input.scope;
  const state = observeContract(carrier, input.contractId).state;
  const target = state?.coordinates?.target;
  const finalHead = target === undefined ? null : readRef(carrier, target);
  return complete(
    input.contractId,
    admitAbandon(carrier, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      finalHead: finalHead === null ? null : mintSnapshotId(finalHead),
      data: { ...(input.note === undefined ? {} : { note: input.note }) },
    }, decideAbandon),
    undefined,
  );
}

export function arcOperation(
  input: OperationInput & Readonly<{ chapter: Omit<ArcData, "seq"> }>,
): IntentOutcome<void, ArcRefusal> {
  return complete(
    input.contractId,
    admitArc(input.scope, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      data: input.chapter,
    }, decideArc),
    undefined,
  );
}

export function reviewOperation(
  input: OperationInput & Readonly<{ data: AttestationData & Readonly<{ gate: "reviewed" }> }>,
): IntentOutcome<void, AttestationRefusal | PlacementRefusal> {
  const carrier = input.scope;
  const review = complete(
    input.contractId,
    admitReview(carrier, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      data: input.data,
    }, decideAttestation),
    undefined,
  );
  if (review.kind !== "accepted" || input.data.verdict !== "satisfied") return review;

  const placement = placeIfEligible(carrier, {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
  });
  if (placement?.kind !== "handoff") return review;
  const placed = complete(input.contractId, placement, undefined);
  if (placed.kind !== "accepted") return review;
  return accepted<void, AttestationRefusal | PlacementRefusal>(
    input.contractId,
    [...review.receipt.facts, ...placed.receipt.facts],
    undefined,
    review.receipt.prior,
    placed.receipt.snapshot,
  );
}

export async function auditOperation(input: OperationInput): Promise<IntentOutcome<AuditReport>> {
  const carrier = input.scope;
  const initial = readAudit(carrier, input.contractId);
  if (initial.state === null) return { kind: "refused", refusal: { kind: "contract-missing", contractId: input.contractId } };

  const verification = await verifyStoredDelivery({
    repository: carrier,
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    state: initial.state,
    environment: process.env,
    produce: produceVerification,
  });
  const attempt = verification !== null && "failure" in verification ? verification : undefined;
  const verified = verification !== null && !("failure" in verification)
    ? complete(input.contractId, verification, undefined)
    : undefined;
  if (verified?.kind === "refused") return verified;
  if (verified?.kind === "retry") return verified;

  const current = readAudit(carrier, input.contractId, attempt);
  return accepted(
    input.contractId,
    verified?.receipt.facts ?? [],
    current.report,
    verified?.receipt.prior ?? initial.state,
    verified?.receipt.snapshot ?? current.state ?? initial.state,
  );
}

export type ReconcileReport = ReconcileResult;

export function reconcileOperation(input: OperationInput): ReconcileReport {
  const carrier = input.scope;
  return reconcile({ repository: carrier, state: observeContract(carrier, input.contractId).state });
}

export type RepoReconcileItem =
  | Readonly<{ contractId: ContractId; kind: "reconciled"; report: ReconcileReport }>
  | Readonly<{ contractId: ContractId; kind: "failed"; error: string }>;

export type RepoReconcileReport = Readonly<{
  contracts: readonly RepoReconcileItem[];
}>;

function reconcileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reconcile every contract from one immutable carrier observation. */
export function reconcileAllOperation(input: Readonly<{ scope: RepositoryScope }>): RepoReconcileReport {
  const carrier = input.scope;
  const observation = observeCarrier(carrier);
  const contracts = reconcileBatch(carrier, observation.contracts.values()).map((item): RepoReconcileItem => (
    item.kind === "reconciled"
      ? { contractId: item.contract, kind: "reconciled", report: item.result }
      : { contractId: item.contract, kind: "failed", error: reconcileError(item.error) }
  ));
  return { contracts };
}
