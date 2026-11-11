import { AkumaNotBornError } from "../akuma/akuma-errors.js";
import { AkumaArchetypeError } from "../akuma/archetype.js";
import type {
  AkumaAskResult,
  AkumaKillResult,
  AkumaTellResult,
  AkumaWaitResult,
} from "../akuma/selection-observation.js";
import type { RegionRead } from "../kanshi/report.js";
import type {
  DebtAbsent,
  DebtShowResult,
  DebtDoctorReport,
  DebtMutationResult,
  DebtUpdateResult,
} from "../debt/index.js";
import { AkumaAddressError, AkumaWorldScopeError } from "./address.js";
import type { ForkResult, SpawnResult } from "./akuma-creation.js";
import type { ContractWaitResult } from "./contract-wait.js";
import { KeiyakuArcDocumentError, KeiyakuUsageError } from "./keiyaku-coordinates.js";
import type { VerbInput, VerbName, VerbOutput } from "./keiyaku-verbs.js";
import {
  KeiyakuError,
  contractOutcomeDisposition,
  invocationIssueIsFailure,
  resetIssueIsRequired,
  spawnFailureReceipt,
} from "./outcome.js";

export type VerbDisposition = "accepted" | "unsatisfied" | "refused" | "retryable" | "failed" | "usage";

export type VerbCompletion<O> = Readonly<{ kind: "returned"; value: O }> | Readonly<{ kind: "threw"; error: unknown }>;

type DebtNativeResult = DebtMutationResult | DebtUpdateResult | DebtShowResult | DebtDoctorReport | DebtAbsent;

function classifyDebt(result: DebtNativeResult): VerbDisposition {
  if ("items" in result) return result.kind === "debt-complete" ? "accepted" : "refused";
  if (result.kind === "retry") return "retryable";
  if (result.kind === "refused" || result.kind === "absent") return "refused";
  return "issues" in result && (result.issues?.length ?? 0) > 0 ? "failed" : "accepted";
}

function classifyThrown(name: VerbName, error: unknown): VerbDisposition {
  if (spawnFailureReceipt(error) !== undefined || (error instanceof KeiyakuError && error.outcome !== undefined))
    return "failed";
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

const akumaCallDisposition = {
  spawned: "accepted",
  admitted: "accepted",
  forked: "accepted",
  answered: "accepted",
  unanswered: "accepted",
  deadline: "accepted",
  failed: "failed",
  "invalid-output": "failed",
  "fork-failed": "failed",
  "provider-forked-local-birth-failed": "failed",
  "provider-cannot-fork": "refused",
  "unknown-history": "refused",
} as const;

function classifyRegion(value: RegionRead): VerbDisposition {
  return value.kind === "contract-missing" || value.kind === "contract-terminal" ? "refused" : "accepted";
}

function classifyReconcile(result: VerbOutput<"reconcile">): VerbDisposition {
  switch (result.kind) {
    case "missing":
      return "refused";
    case "world-observation-failed":
      return "failed";
    case "contract":
      return result.issues?.some(invocationIssueIsFailure) === true ? "failed" : "accepted";
    case "world":
      return result.contracts?.some((item) => item.issues?.some(invocationIssueIsFailure) === true) === true
        ? "failed"
        : "accepted";
  }
}

function classifyWait(result: ContractWaitResult | AkumaWaitResult): VerbDisposition {
  if (result.kind === "contract") return result.reason === "missing" ? "refused" : "accepted";
  return result.results.some((item) => item.kind !== "observed") ? "failed" : "accepted";
}

function classifyHistory(value: VerbOutput<"history">): VerbDisposition {
  return value.kind === "contract-missing" || value.kind === "akuma-unknown-history" ? "refused" : "accepted";
}

function classifyNuke(result: VerbOutput<"nuke">): VerbDisposition {
  if (result.kind === "refused") return "refused";
  return result.issues?.some(resetIssueIsRequired) === true ? "retryable" : "accepted";
}

/** Classify the native completion without changing or reconstructing its evidence. */
export function classifyVerb<K extends VerbName>(
  name: K,
  _input: VerbInput<K>,
  completion: VerbCompletion<VerbOutput<K>>,
): VerbDisposition {
  if (completion.kind === "threw") return classifyThrown(name, completion.error);

  const value = completion.value;
  switch (name) {
    case "debt.add":
    case "debt.addDocument":
    case "debt.update":
    case "debt.doctor":
      return classifyDebt(value as DebtNativeResult);
    case "bind":
    case "amend":
    case "arc":
    case "deliver":
    case "verify":
    case "review":
    case "abandon": {
      return contractOutcomeDisposition(
        value as VerbOutput<"bind" | "amend" | "arc" | "deliver" | "verify" | "review" | "abandon">,
      );
    }
    case "spawn":
    case "fork":
    case "tell":
    case "ask":
      return akumaCallDisposition[(value as SpawnResult | ForkResult | AkumaTellResult | AkumaAskResult).kind];
    case "kill":
      return (value as AkumaKillResult).results.some(
        ({ outcome }) => outcome === "unavailable" || outcome === "hung" || outcome === "untidy",
      )
        ? "failed"
        : "accepted";
    case "wait":
      return classifyWait(value as ContractWaitResult | AkumaWaitResult);
    case "history":
      return classifyHistory(value as VerbOutput<"history">);
    case "show": {
      const result = value as VerbOutput<"show">;
      if (result.kind === "present") return "accepted";
      return result.kind === "missing" ? "refused" : classifyDebt(result);
    }
    case "ls": {
      const result = value as VerbOutput<"ls">;
      return result.kind === "debt-catalogue" && "absent" in result ? "refused" : "accepted";
    }
    case "status":
      return (value as VerbOutput<"status">).kind === "contract-missing" ? "refused" : "accepted";
    case "region":
      return classifyRegion(value as RegionRead);
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
