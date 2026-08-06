import { prepareDelivery } from "../carrier/delivery.js";
import { mintContractId, mintSnapshotId } from "../carrier/identity.js";
import { observeBindCoordinates, observeCarrier, observeContract } from "../carrier/observe.js";
import { deliveryWorktreePath, reconcile, reconcileBatch, type ReconcileResult } from "../carrier/reconcile.js";
import { readRef, repositoryAt } from "../carrier/repository.js";
import { readDeliveryDiff } from "../carrier/verification.js";
import { foldJournal } from "../core/facts/fold.js";
import type {
  AbandonData, AmendData, ArcData, BindData, ChangeId, ContractBody, ContractId, ContractState, JournalEntry, ReviewData, SnapshotId,
} from "../core/facts/types.js";
import { decideAbandon, type AbandonRefusal } from "../core/verbs/abandon.js";
import { decideAmend, type AmendRefusal } from "../core/verbs/amend.js";
import { decideArc, type ArcRefusal } from "../core/verbs/arc.js";
import { decideBind, type BindRefusal } from "../core/verbs/bind.js";
import { decideDeliver, type DeliverRefusal } from "../core/verbs/deliver.js";
import type { PlacementRefusal } from "../core/verbs/placement.js";
import { decideReview, type ReviewRefusal } from "../core/verbs/review.js";
import type { VerificationRefusal } from "../core/verbs/verification.js";
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
  | DeliveryPreparationRefusal | PlacementRefusal | ReviewRefusal | VerificationRefusal;

export type IntentRetry = ProtocolTerminal;
export type IntentReceipt = Readonly<{ facts: readonly JournalEntry[]; prior: ContractState | null; snapshot: ContractState }>;
export type IntentOutcome<Value, Refusal = IntentRefusal> =
  | Readonly<{ kind: "accepted"; receipt: IntentReceipt; value: Value }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "retry"; reason: IntentRetry }>;

type OperationInput = Readonly<{ coordinate: string; contractId: ContractId; actor?: string }>;

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

function repository(input: Readonly<{ coordinate: string }>) {
  return repositoryAt(input.coordinate);
}

export type ScopeOperationInput = Readonly<{ coordinate: string }>;

export type RepositoryScope = Readonly<{
  coordinate: string;
  root: string;
}>;

/** Resolve the caller worktree and its shared repository scope once. */
export function scopeOperation(input: ScopeOperationInput): RepositoryScope {
  const carrier = repository(input);
  return { coordinate: carrier.effectiveCwd, root: carrier.primaryWorktree };
}

export function statusOperation(input: ScopeOperationInput): StatusReport {
  return readStatus(repository(input));
}

export type BindOperationInput = Readonly<{
  coordinate: string; body: ContractBody; target?: string; workspace: "worktree" | "here"; actor?: string;
}>;

export function bindOperation(input: BindOperationInput): IntentOutcome<Readonly<{ contractId: ContractId }>, BindRefusal> {
  const id = mintContractId();
  const carrier = repository(input);
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
  const state = observeContract(repository(input), input.contractId).state;
  if (state === null) throw new Error(`contract does not exist: ${input.contractId}`);
  return state;
}

/** Read a contract state for facade preparation without turning absence into an exception. */
export function readStateOperation(input: OperationInput): ContractState | null {
  return observeContract(repository(input), input.contractId).state;
}

/** Read the deterministic managed worktree path without exposing carrier state. */
export function worktreePathOperation(input: OperationInput): string | null {
  const carrier = repository(input);
  const state = observeContract(carrier, input.contractId).state;
  if (state?.coordinates?.workspace !== "worktree") return null;
  return deliveryWorktreePath(carrier, input.contractId);
}

export function deliveryOperation(
  input: OperationInput,
): DeliveryOperationValue | null {
  const state = observeContract(repository(input), input.contractId).state;
  if (state === null || state.delivery === null) return null;
  return {
    snapshotId: state.delivery.data.candidate,
    changeId: state.delivery.data.deliveryPatchId,
    expectedPredecessor: state.delivery.data.expectedPredecessor,
  };
}

export type DeliveryDiffOperationInput = Readonly<{
  coordinate: string;
  expectedPredecessor: SnapshotId;
  snapshotId: SnapshotId;
}>;

export async function deliveryDiffOperation(input: DeliveryDiffOperationInput): Promise<string | null> {
  return readDeliveryDiff(repository(input), input.expectedPredecessor, input.snapshotId);
}

export function amendOperation(
  input: OperationInput & Readonly<{ body: AmendData }>,
): IntentOutcome<void, AmendRefusal> {
  return complete(
    input.contractId,
    admitAmend(repository(input), {
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
}>;

export async function deliverOperation(input: OperationInput): Promise<IntentOutcome<DeliveryOperationValue>> {
  const carrier = repository(input);
  const prepared = prepareDelivery(carrier, input.contractId);
  if (prepared.kind === "refused") return { kind: "refused", refusal: prepared.refusal as DeliveryPreparationRefusal };

  const value = {
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
    value,
  );
  if (first.kind !== "accepted") return first;

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
  input: OperationInput & Readonly<{ reason: AbandonData["reason"]; note?: string }>,
): IntentOutcome<void, AbandonRefusal> {
  const carrier = repository(input);
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
      data: { reason: input.reason, ...(input.note === undefined ? {} : { note: input.note }) },
    }, decideAbandon),
    undefined,
  );
}

export function arcOperation(
  input: OperationInput & Readonly<{ chapter: Omit<ArcData, "seq"> }>,
): IntentOutcome<void, ArcRefusal> {
  return complete(
    input.contractId,
    admitArc(repository(input), {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      data: input.chapter,
    }, decideArc),
    undefined,
  );
}

export function reviewOperation(
  input: OperationInput & Readonly<{ snapshotId: SnapshotId; changeId: ChangeId; verdict: ReviewData["verdict"]; summary?: string }>,
): IntentOutcome<void, ReviewRefusal | PlacementRefusal> {
  const carrier = repository(input);
  const review = complete(
    input.contractId,
    admitReview(carrier, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      data: {
        verdict: input.verdict,
        reviewedPatchId: input.changeId,
        reviewedHead: input.snapshotId,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      },
    }, decideReview),
    undefined,
  );
  if (review.kind !== "accepted" || input.verdict !== "approved") return review;

  const placement = placeIfEligible(carrier, {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
  });
  if (placement?.kind !== "handoff") return review;
  const placed = complete(input.contractId, placement, undefined);
  if (placed.kind !== "accepted") return review;
  return accepted<void, ReviewRefusal | PlacementRefusal>(
    input.contractId,
    [...review.receipt.facts, ...placed.receipt.facts],
    undefined,
    review.receipt.prior,
    placed.receipt.snapshot,
  );
}

export async function auditOperation(input: OperationInput): Promise<IntentOutcome<AuditReport>> {
  const carrier = repository(input);
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
  const carrier = repository(input);
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
export function reconcileAllOperation(input: ScopeOperationInput): RepoReconcileReport {
  const carrier = repository(input);
  const observation = observeCarrier(carrier);
  const contracts = reconcileBatch(carrier, observation.contracts.values()).map((item): RepoReconcileItem => (
    item.kind === "reconciled"
      ? { contractId: item.contract, kind: "reconciled", report: item.result }
      : { contractId: item.contract, kind: "failed", error: reconcileError(item.error) }
  ));
  return { contracts };
}
