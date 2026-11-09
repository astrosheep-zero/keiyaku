import { AkumaNotBornError } from "../akuma/akuma-errors.js";
import { AkumaArchetypeError } from "../akuma/archetype.js";
import type {
  AkumaAskResult,
  AkumaKillResult,
  AkumaTellResult,
  AkumaWaitResult,
} from "../akuma/selection-observation.js";
import type { KanshiReport } from "../kanshi/index.js";
import type {
  BlockedDebtList,
  DebtAbsent,
  DebtBatchResult,
  DebtContextResult,
  DebtDecompositionTree,
  DebtDetail,
  DebtDoctorReport,
  DebtList,
  DebtMutationResult,
  DebtQueryResult,
  DebtUpdateResult,
} from "../debt/index.js";
import { AkumaAddressError, AkumaWorldScopeError } from "./address.js";
import type { ForkResult, SpawnResult } from "./akuma-creation.js";
import type { ContractWaitResult } from "./contract-wait.js";
import { KeiyakuArcDocumentError, KeiyakuUsageError } from "./keiyaku-coordinates.js";
import type { VerbInput, VerbName, VerbOutput } from "./keiyaku-verbs.js";
import { reconcileLagIsFailure, type ReconcileReport, type RepoReconcileReport } from "./reconcile.js";
import type { AkumaHistoryResult } from "./selection.js";

export type VerbDisposition = "accepted" | "refused" | "retryable" | "failed" | "usage";

export type VerbCompletion<O> = Readonly<{ kind: "returned"; value: O }> | Readonly<{ kind: "threw"; error: unknown }>;

function reconcileHasFailure(report: ReconcileReport | RepoReconcileReport): boolean {
  if ("kind" in report) {
    return (
      report.kind === "world-observation-failed" ||
      report.contracts.some(({ report: item }) => reconcileHasFailure(item))
    );
  }
  return (
    report.lag.some(reconcileLagIsFailure) ||
    report.settlement.lags.length > 0 ||
    (report.settlement.seatClose?.length ?? 0) > 0
  );
}

type DebtNativeResult =
  | DebtMutationResult
  | DebtUpdateResult
  | DebtBatchResult
  | DebtDetail
  | null
  | readonly (DebtDetail | null)[]
  | DebtList
  | BlockedDebtList
  | DebtQueryResult
  | DebtDecompositionTree
  | DebtDoctorReport
  | DebtContextResult
  | DebtAbsent;

function classifyDebt(result: DebtNativeResult): VerbDisposition {
  if (result === null) return "refused";
  if (Array.isArray(result)) return result.some((item) => item === null) ? "refused" : "accepted";
  if ("issues" in result) return result.issues.length === 0 ? "accepted" : "failed";
  if ("items" in result) {
    if (result.items.some((item) => item.outcome.kind === "retry")) return "retryable";
    return result.items.some((item) => item.outcome.kind === "refused") ? "refused" : "accepted";
  }
  if ("kind" in result) {
    if (result.kind === "retry") return "retryable";
    if (result.kind === "refused" || result.kind === "absent") return "refused";
  }
  return "accepted";
}

function classifyThrown(name: VerbName, error: unknown): VerbDisposition {
  if (error instanceof Error && "executionReceipt" in error) return "failed";
  if (error instanceof KeiyakuUsageError) return "usage";
  if (
    error instanceof AkumaAddressError ||
    error instanceof AkumaNotBornError ||
    error instanceof AkumaWorldScopeError ||
    error instanceof KeiyakuArcDocumentError ||
    (name === "spawn" && error instanceof AkumaArchetypeError)
  )
    return "refused";
  return "failed";
}

function classifySpawn(result: SpawnResult): VerbDisposition {
  if (result.dispatch.kind === "failed" || result.alias.kind === "failed" || result.observation.kind === "failed")
    return "failed";
  if (result.observation.kind !== "observed") return "accepted";
  const reason = result.observation.observation.reason;
  return reason === "failed" || reason === "invalid-output" ? "failed" : "accepted";
}

function classifyFork(result: ForkResult): VerbDisposition {
  if (result.kind === "forked") return result.dispatch.kind === "failed" ? "failed" : "accepted";
  return result.kind === "fork-failed" || result.kind === "upstream-forked" ? "failed" : "refused";
}

function classifyStatus(input: VerbInput<"status">, value: VerbOutput<"status">): VerbDisposition {
  const selector = (input as { selector?: string }).selector;
  if (selector?.startsWith("kei/") !== true || Array.isArray(value) || !("contracts" in value)) return "accepted";
  const contracts = (value as KanshiReport).contracts;
  return contracts.kind === "present" && contracts.value.rows.length === 0 ? "refused" : "accepted";
}

function classifyReconcile(result: VerbOutput<"reconcile">): VerbDisposition {
  if ("kind" in result && result.kind === "missing") return "refused";
  return reconcileHasFailure(result) ? "failed" : "accepted";
}

function classifyWait(result: ContractWaitResult | AkumaWaitResult): VerbDisposition {
  return "kind" in result
    ? result.kind === "missing"
      ? "refused"
      : "accepted"
    : result.unobserved.length > 0
      ? "failed"
      : "accepted";
}

function classifyHistory(value: VerbOutput<"history">): VerbDisposition {
  return value === null ||
    (typeof value === "object" && "kind" in value && (value as AkumaHistoryResult).kind === "unknown-history")
    ? "refused"
    : "accepted";
}

function classifyNuke(result: VerbOutput<"nuke">): VerbDisposition {
  if (result.kind === "refused") return "refused";
  return result.pending.some((surface) => surface.required) ? "retryable" : "accepted";
}

/** Classify the native completion without changing or reconstructing its evidence. */
export function classifyVerb<K extends VerbName>(
  name: K,
  input: VerbInput<K>,
  completion: VerbCompletion<VerbOutput<K>>,
): VerbDisposition {
  if (completion.kind === "threw") return classifyThrown(name, completion.error);

  const value = completion.value;
  switch (name) {
    case "ls":
      return (input as { of: string }).of === "debt" ? classifyDebt(value as DebtNativeResult) : "accepted";
    case "debt.add":
    case "debt.addDocument":
    case "debt.update":
    case "debt.show":
    case "debt.done":
    case "debt.drop":
    case "debt.ready":
    case "debt.blocked":
    case "debt.query":
    case "debt.tree":
    case "debt.doctor":
    case "debt.context":
      return classifyDebt(value as DebtNativeResult);
    case "bind":
    case "amend":
    case "arc":
    case "deliver":
    case "deliver.preview":
    case "verify":
    case "review":
    case "abandon": {
      const result = value as { kind: string };
      return result.kind === "refused" ? "refused" : result.kind === "retry" ? "retryable" : "accepted";
    }
    case "spawn":
      return classifySpawn(value as SpawnResult);
    case "fork":
      return classifyFork(value as ForkResult);
    case "tell":
      return (value as AkumaTellResult).tell.wake.kind === "failed" ? "failed" : "accepted";
    case "ask": {
      const reason = (value as AkumaAskResult).observation.reason;
      return reason === "failed" || reason === "invalid-output" ? "failed" : "accepted";
    }
    case "kill":
      return (value as AkumaKillResult).results.some(
        ({ evidence }) => evidence === "unavailable" || evidence === "hung" || evidence === "untidy",
      )
        ? "failed"
        : "accepted";
    case "wait":
      return classifyWait(value as ContractWaitResult | AkumaWaitResult);
    case "history":
      return classifyHistory(value as VerbOutput<"history">);
    case "show":
      return value === null ? "refused" : "accepted";
    case "status":
      return classifyStatus(input as VerbInput<"status">, value as VerbOutput<"status">);
    case "region": {
      const result = value as { kind: string };
      return result.kind === "missing" || "row" in result ? "refused" : "accepted";
    }
    case "reconcile":
      return classifyReconcile(value as VerbOutput<"reconcile">);
    case "nuke":
      return classifyNuke(value as VerbOutput<"nuke">);
    case "report":
      return (value as VerbOutput<"report">).kind === "refused" ? "refused" : "accepted";
    default:
      return "accepted";
  }
}
