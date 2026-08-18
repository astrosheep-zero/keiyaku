import {
  KeiyakuRefused,
  KeiyakuRetry,
  type AmendResult,
  type AuditReport,
  type BindResult,
  type ContractId,
  type Delivery,
  type MutationResult,
  type Review,
} from "../index.js";
import type { RegionObservation } from "../library/region.js";
import type {
  AcceptedAbandonResult,
  AcceptedAmendResult,
  AcceptedArcResult,
  AcceptedAuditResult,
  AcceptedBindResult,
  AcceptedDeliverResult,
  AcceptedEnvelope,
  AcceptedFact,
  AcceptedResult,
  AcceptedReviewResult,
  InvocationResult,
} from "./result.js";

type MutationObservation = Pick<MutationResult<unknown>, "facts" | "head" | "effects" | "lags" | "settlement">;

type MutationCallOptions = Readonly<{
  coordinate?: ContractId;
  projectRefusal?: (refusal: unknown) => unknown;
}>;

function acceptedFacts(result: MutationObservation): readonly AcceptedFact[] {
  return result.facts.map((fact): AcceptedFact => ({
    contract: fact.contract,
    entry: fact.entry,
    kind: fact.kind,
  }));
}

function acceptedEnvelope(
  result: MutationObservation,
  coordinate: ContractId | undefined,
): AcceptedEnvelope {
  const contract = coordinate ?? result.facts[0]?.contract;
  if (contract === undefined) throw new Error("accepted mutation is missing its contract identity");
  const firstLag = result.lags[0];
  return {
    kind: "accepted",
    contract,
    head: result.head,
    facts: acceptedFacts(result),
    effects: result.effects,
    settlement: result.settlement,
    ...(result.lags.length === 0 || firstLag === undefined ? {} : { lag: [firstLag, ...result.lags.slice(1)] }),
  };
}

function acceptedRegion(result: AmendResult | BindResult): RegionObservation {
  if (result.overlapFailure !== undefined) return { overlapFailure: result.overlapFailure };
  return { overlaps: result.overlaps };
}

export function acceptedBind(
  result: BindResult,
  coordinates: Readonly<{ workspace: "worktree" | "here"; target?: string }>,
): AcceptedBindResult {
  return {
    ...acceptedEnvelope(result, undefined),
    verb: "bind",
    workspace: coordinates.workspace,
    target: coordinates.target ?? null,
    ...acceptedRegion(result),
  };
}

export function acceptedAmend(result: AmendResult, coordinate: ContractId): AcceptedAmendResult {
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "amend",
    diff: result.documentDiff,
    ...acceptedRegion(result),
  };
}

export function acceptedDeliver(
  result: MutationResult<Delivery>,
  coordinate: ContractId,
): AcceptedDeliverResult {
  const value = result.value;
  const attestation = result.facts.find((fact) => fact.kind === "attestation");
  const verificationVerdict = attestation?.data.verdict ?? value.verificationReuse?.verdict;
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "deliver",
    ...(verificationVerdict === undefined ? {} : { verificationVerdict }),
    ...(value.verification === undefined ? {} : { verification: value.verification }),
    ...(value.verificationReuse === undefined ? {} : { verificationReuse: value.verificationReuse }),
    ...(value.placement === undefined ? {} : { placement: value.placement }),
    ...(value.cleanup === undefined ? {} : { cleanup: value.cleanup }),
    ...(value.leak === undefined ? {} : { leak: value.leak }),
  };
}

export function acceptedReview(
  result: MutationResult<Review>,
  coordinate: ContractId,
): AcceptedReviewResult {
  const value = result.value;
  const attestation = result.facts.find((fact) => fact.kind === "attestation");
  if (attestation === undefined) throw new Error("accepted review is missing its attestation fact");
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "review",
    verdict: attestation.data.verdict,
    ...(value.placement === undefined ? {} : { placement: value.placement }),
    ...(value.workspace === undefined ? {} : { workspace: value.workspace }),
  };
}

export function acceptedArc(result: MutationResult<void>, coordinate: ContractId): AcceptedArcResult {
  const arc = result.facts.find((fact) => fact.kind === "arc");
  if (arc === undefined) throw new Error("accepted arc is missing its arc fact");
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "arc",
    chapter: { seq: arc.data.seq, title: arc.data.title },
  };
}

export function acceptedAbandon(result: MutationResult<void>, coordinate: ContractId): AcceptedAbandonResult {
  const abandoned = result.facts.find((fact) => fact.kind === "abandoned");
  if (abandoned === undefined) throw new Error("accepted abandon is missing its abandoned fact");
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "abandon",
    ...(abandoned.data.note === undefined ? {} : { note: abandoned.data.note }),
  };
}

export function acceptedAudit(
  result: MutationResult<AuditReport>,
  coordinate: ContractId,
): AcceptedAuditResult {
  return {
    ...acceptedEnvelope(result, coordinate),
    verb: "audit",
    report: result.value,
    ...(result.cleanup === undefined ? {} : { cleanup: result.cleanup }),
    ...(result.leak === undefined ? {} : { leak: result.leak }),
  };
}

export async function resultFromMutationCall<
  const Verb extends AcceptedResult["verb"],
  Result extends MutationObservation,
>(
  verb: Verb,
  call: () => Promise<Result>,
  project: (result: Result) => Extract<AcceptedResult, { verb: NoInfer<Verb> }>,
  options: MutationCallOptions = {},
): Promise<Extract<AcceptedResult, { verb: Verb }> | Extract<InvocationResult, { kind: "refused" | "retry" }>> {
  try {
    return project(await call());
  } catch (error) {
    if (error instanceof KeiyakuRefused) {
      return {
        kind: "refused",
        verb,
        ...(options.coordinate === undefined ? {} : { contract: options.coordinate }),
        refusal: options.projectRefusal === undefined ? error.refusal : options.projectRefusal(error.refusal),
      };
    }
    if (error instanceof KeiyakuRetry) {
      return {
        kind: "retry",
        verb,
        ...(options.coordinate === undefined ? {} : { contract: options.coordinate }),
        detail: error.reason,
      };
    }
    throw error;
  }
}
