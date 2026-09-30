import {
  type AmendValue,
  type AuditReport,
  type BindValue,
  type ContractHead,
  type ContractId,
  type Delivery,
  type ExecutionCleanup,
  type ExecutionStop,
  type Fact,
  type IntegrationConflictMaterialized,
  type InvocationEffect,
  type PendingSurface,
  type ReconciliationLag,
  type Review,
  type SettlementLag,
  type SnapshotId,
} from "../index.js";
import type { AmendRegionObservation, RegionObservation } from "../library/region.js";
import type {
  AcceptedAbandonResult,
  AcceptedAmendResult,
  AcceptedArcResult,
  AcceptedAuditResult,
  AcceptedBindResult,
  AcceptedDeliverResult,
  AcceptedEnvelope,
  AcceptedResult,
  AcceptedReviewResult,
  InvocationResult,
} from "./result.js";

/** The accepted arm every operation projects through: one envelope, one effect carrier. */
type AcceptedObservation<Value> = Readonly<{
  contract?: ContractId;
  head: ContractHead;
  facts: readonly Fact[];
  effects: readonly InvocationEffect[];
  pending: readonly PendingSurface[];
  value: Value;
}>;

type CallOutcome<Value> =
  | (AcceptedObservation<Value> & Readonly<{ kind: "accepted" }>)
  | Readonly<{ kind: "refused"; contract?: ContractId; refusal: unknown }>
  | Readonly<{ kind: "retry"; contract?: ContractId; reason: unknown }>
  | Readonly<{ kind: "handoff"; value: IntegrationConflictMaterialized }>;

type MutationCallOptions = Readonly<{
  coordinate?: ContractId;
  projectRefusal?: (refusal: unknown) => unknown;
}>;

/**
 * The interim CLI presentation of one projection. The eight retired sidecar names are derived here
 * from the single effect carrier; nothing is accumulated twice.
 */
function acceptedEnvelope(
  result: Omit<AcceptedObservation<unknown>, "value">,
  coordinate: ContractId | undefined,
): AcceptedEnvelope {
  const contract = coordinate ?? result.contract ?? result.facts[0]?.contract;
  if (contract === undefined) throw new Error("accepted mutation is missing its contract identity");
  const lags: ReconciliationLag[] = [];
  const settlementLags: SettlementLag[] = [];
  const cleanup: ExecutionCleanup[] = [];
  const executionStops: ExecutionStop[] = [];
  const retainedCheckouts: { path: string; target: string; diagnostic: string }[] = [];
  let recoverySnapshot: SnapshotId | undefined;
  let retiredWorktree: string | undefined;
  let retainedWorktree: string | undefined;
  for (const effect of result.effects) {
    switch (effect.kind) {
      case "reconciliation-lag":
        lags.push(effect.lag);
        break;
      case "settlement-lag":
        settlementLags.push(effect.lag);
        break;
      case "cleanup":
        cleanup.push(effect.issue);
        break;
      case "execution-stopped":
        executionStops.push({
          kind: "execution-stopped",
          contractId: contract,
          stage: effect.stage,
          reason: effect.reason,
          diagnostic: effect.diagnostic,
        });
        break;
      case "checkout-retained":
        retainedCheckouts.push({ path: effect.path, target: effect.target, diagnostic: effect.diagnostic });
        break;
      case "worktree-retired":
        retiredWorktree = effect.name;
        break;
      case "worktree-retained":
        retainedWorktree = effect.path;
        break;
      case "reconciliation-effect":
        if (effect.effect.kind === "recovery-snapshot") recoverySnapshot = effect.effect.snapshot;
        break;
      default:
        break;
    }
  }
  const firstLag = lags[0];
  return {
    kind: "accepted",
    contract,
    head: result.head,
    facts: result.facts,
    effects: result.effects,
    pending: result.pending,
    settlementLags,
    ...(recoverySnapshot === undefined ? {} : { recoverySnapshot }),
    ...(retiredWorktree === undefined ? {} : { retiredWorktree }),
    ...(retainedWorktree === undefined ? {} : { retainedWorktree }),
    ...(retainedCheckouts.length === 0 ? {} : { retainedCheckouts }),
    ...(firstLag === undefined ? {} : { lag: [firstLag, ...lags.slice(1)] }),
    ...(cleanup.length === 0 ? {} : { cleanup }),
    ...(executionStops.length === 0 ? {} : { executionStops }),
  };
}

function acceptedRegion(value: RegionObservation): RegionObservation {
  return value.overlapFailure !== undefined ? { overlapFailure: value.overlapFailure } : { overlaps: value.overlaps };
}

function acceptedAmendRegion(value: AmendRegionObservation): AmendRegionObservation {
  if (value.overlapFailure !== undefined) return { overlapFailure: value.overlapFailure };
  if (value.overlaps !== undefined) return { overlaps: value.overlaps };
  return {};
}

function attestationFor(
  facts: readonly Fact[],
  gate: "reviewed" | "verified",
  coordinate: ContractId,
): Extract<Fact, { kind: "attestation" }> | undefined {
  return facts.findLast(
    (fact): fact is Extract<Fact, { kind: "attestation" }> =>
      fact.contract === coordinate && fact.kind === "attestation" && fact.data.gate === gate,
  );
}

export function acceptedBind(
  result: AcceptedObservation<BindValue>,
  coordinates: Readonly<{ target?: string }>,
): AcceptedBindResult {
  return {
    ...acceptedEnvelope(result, undefined),
    verb: "bind",
    ...(result.value.workspace === undefined ? {} : { workspace: result.value.workspace }),
    target: coordinates.target ?? null,
    ...(result.value.warnings === undefined ? {} : { warnings: result.value.warnings }),
    ...acceptedRegion(result.value),
  };
}

export function acceptedAmend(result: AcceptedObservation<AmendValue>, coordinate: ContractId): AcceptedAmendResult {
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "amend",
    diff: result.value.documentDiff,
    changes: result.value.changes,
    ...acceptedAmendRegion(result.value),
  };
}

export function acceptedDeliver(result: AcceptedObservation<Delivery>, coordinate: ContractId): AcceptedDeliverResult {
  const value = result.value;
  const attestation = attestationFor(result.facts, "verified", coordinate);
  const verificationVerdict =
    value.completion?.verification?.verdict ?? attestation?.data.verdict ?? value.verificationReuse?.verdict;
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "deliver",
    tenderSnapshot: value.tenderSnapshot,
    integration: { changeId: value.integration.changeId },
    ...(value.leading === undefined ? {} : { leading: value.leading }),
    ...(value.completion === undefined ? {} : { completion: value.completion }),
    ...(verificationVerdict === undefined ? {} : { verificationVerdict }),
    ...(value.verification === undefined ? {} : { verification: value.verification }),
    ...(value.verificationReuse === undefined ? {} : { verificationReuse: value.verificationReuse }),
    ...(value.verificationSubject === undefined ? {} : { verificationSubject: value.verificationSubject }),
    ...(value.verificationSummary === undefined ? {} : { verificationSummary: value.verificationSummary }),
    ...(value.placement === undefined ? {} : { placement: value.placement }),
    ...(value.continuation === undefined ? {} : { continuation: value.continuation }),
  };
}

export function acceptedReview(result: AcceptedObservation<Review>, coordinate: ContractId): AcceptedReviewResult {
  const value = result.value;
  const reviewAttestation = attestationFor(result.facts, "reviewed", coordinate);
  if (reviewAttestation === undefined) throw new Error("accepted review is missing its attestation fact");
  const verificationAttestation = attestationFor(result.facts, "verified", coordinate);
  const verificationVerdict =
    value.completion?.verification?.verdict ??
    verificationAttestation?.data.verdict ??
    value.verificationReuse?.verdict;
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "review",
    verdict: reviewAttestation.data.verdict,
    ...(value.completion === undefined ? {} : { completion: value.completion }),
    ...(verificationVerdict === undefined ? {} : { verificationVerdict }),
    ...(value.verification === undefined ? {} : { verification: value.verification }),
    ...(value.verificationReuse === undefined ? {} : { verificationReuse: value.verificationReuse }),
    ...(value.verificationSummary === undefined ? {} : { verificationSummary: value.verificationSummary }),
    ...(value.placement === undefined ? {} : { placement: value.placement }),
    ...(value.continuation === undefined ? {} : { continuation: value.continuation }),
    ...(value.workspace === undefined ? {} : { workspace: value.workspace }),
  };
}

export function acceptedArc(result: AcceptedObservation<void>, coordinate: ContractId): AcceptedArcResult {
  const arc = result.facts.find((fact) => fact.kind === "arc");
  if (arc === undefined) throw new Error("accepted arc is missing its arc fact");
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "arc",
    chapter: { seq: arc.data.seq, title: arc.data.title },
  };
}

export function acceptedAbandon(result: AcceptedObservation<void>, coordinate: ContractId): AcceptedAbandonResult {
  const abandoned = result.facts.find((fact) => fact.kind === "abandoned");
  if (abandoned === undefined) throw new Error("accepted abandon is missing its abandoned fact");
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "abandon",
    ...(abandoned.data.note === undefined ? {} : { note: abandoned.data.note }),
  };
}

export function acceptedAudit(result: AcceptedObservation<AuditReport>, coordinate: ContractId): AcceptedAuditResult {
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "audit",
    report: result.value,
  };
}

/** One promised operation is already the answer: expected refusals and retries are returned data. */
export async function resultFromMutationCall<const Verb extends AcceptedResult["verb"], Value>(
  verb: Verb,
  call: () => Promise<CallOutcome<Value>>,
  project: (accepted: Extract<CallOutcome<Value>, { kind: "accepted" }>) => Extract<AcceptedResult, { verb: Verb }>,
  options: MutationCallOptions = {},
): Promise<
  | Extract<AcceptedResult, { verb: Verb }>
  | Extract<InvocationResult, { kind: "refused" | "retry" }>
  | IntegrationConflictMaterialized
> {
  const outcome = await call();
  if (outcome.kind === "accepted") return project(outcome);
  if (outcome.kind === "handoff") return outcome.value;
  const contract = options.coordinate ?? outcome.contract;
  if (outcome.kind === "refused") {
    return {
      kind: "refused",
      verb,
      ...(contract === undefined ? {} : { contract }),
      refusal: options.projectRefusal === undefined ? outcome.refusal : options.projectRefusal(outcome.refusal),
    };
  }
  return { kind: "retry", verb, ...(contract === undefined ? {} : { contract }), detail: outcome.reason };
}
