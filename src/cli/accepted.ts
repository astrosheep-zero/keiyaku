import {
  KeiyakuRefused,
  KeiyakuRetry,
  type ContractId,
  type MutationResult,
  type RegionOverlap,
} from "../index.js";
import type { AcceptedFact, AcceptedResult, InvocationResult } from "./result.js";

function hasOverlaps(value: object): value is Readonly<{ overlaps: readonly RegionOverlap[] }> {
  return "overlaps" in value;
}

function hasOverlapFailure(value: object): value is Readonly<{ overlapFailure: string }> {
  return "overlapFailure" in value;
}

function hasDocumentDiff(value: object): value is Readonly<{ documentDiff: string }> {
  return "documentDiff" in value && typeof value.documentDiff === "string";
}

type MutationObservation = Pick<MutationResult<unknown>, "facts" | "head" | "effects" | "lags" | "settlement">;

type ResultOptions = Readonly<{
  coordinate?: ContractId;
  target?: string | null;
  report?: import("../index.js").AuditReport;
  obligations?: Pick<AcceptedResult, "verification" | "placement" | "leak">;
  diff?: AcceptedResult["diff"];
}>;

type MutationCallOptions<Result extends MutationObservation> = Readonly<{
  coordinate?: ContractId;
  project?: (result: Result) => ResultOptions | Promise<ResultOptions>;
}>;

function resultFromMutation(
  verb: string,
  result: MutationObservation & object,
  options: ResultOptions,
): InvocationResult {
  const acceptedContract = options.coordinate ?? result.facts[0]?.contract;
  if (acceptedContract === undefined) throw new Error("accepted mutation is missing its contract identity");
  return {
    kind: "accepted",
    verb,
    contract: acceptedContract,
    head: result.head,
    facts: result.facts.map((fact): AcceptedFact => ({
      contract: fact.contract,
      entry: fact.entry,
      kind: fact.kind,
    })),
    effects: result.effects,
    settlement: result.settlement,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...options.obligations,
    ...(hasOverlaps(result) ? { overlaps: result.overlaps } : {}),
    ...(hasOverlapFailure(result) ? { overlapFailure: result.overlapFailure } : {}),
    ...(hasDocumentDiff(result) ? { diff: result.documentDiff } : {}),
    ...(options.report === undefined ? {} : { report: options.report }),
    ...(options.diff === undefined ? {} : { diff: options.diff }),
    ...(result.lags.length === 0 ? {} : { lag: result.lags }),
  };
}

export async function resultFromMutationCall<Result extends MutationObservation & object>(
  verb: string,
  call: () => Promise<Result>,
  options: MutationCallOptions<Result> = {},
): Promise<InvocationResult> {
  try {
    const result = await call();
    const projected = options.project === undefined ? {} : await options.project(result);
    return resultFromMutation(verb, result, {
      ...projected,
      ...(options.coordinate === undefined ? {} : { coordinate: options.coordinate }),
    });
  } catch (error) {
    if (error instanceof KeiyakuRefused) {
      return {
        kind: "refused",
        verb,
        ...(options.coordinate === undefined ? {} : { contract: options.coordinate }),
        refusal: error.refusal,
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
