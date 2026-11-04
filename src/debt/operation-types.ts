import type { DebtDocument, DebtPriority, DebtState } from "./document.js";
import type { DebtId } from "./identity.js";

export type DebtView = DebtDocument & Readonly<{ namespace: readonly string[] }>;
export type DebtCleanupFailure = Readonly<{ kind: "lock-release-failed"; diagnostics: readonly string[] }>;
export type DebtRefusal =
  | Readonly<{ kind: "debt-missing"; debtId: DebtId }>
  | Readonly<{ kind: "invalid-lifecycle-transition"; debtId: DebtId; state: DebtState; verb: "done" | "drop" }>
  | Readonly<{ kind: "invalid-graph"; diagnostic: string }>
  | Readonly<{ kind: "invalid-namespace-context"; path: string }>
  | Readonly<{ kind: "relation-owned-by-other"; debtId: DebtId; related: DebtId; declaringDebt: DebtId }>;
export type DebtRetry = "busy" | "concurrent-modification";
export type DebtMutationResult = DebtOutcome<DebtView>;
export type DebtUpdateResult = DebtOutcome<
  Readonly<{
    debt: DebtView;
    documentDiff: string;
    changedFields: readonly Readonly<{
      field: string;
      action: "added" | "replaced" | "cleared" | "changed" | "appended";
    }>[];
  }>
>;
export type DebtBatchResult = Readonly<{ items: readonly Readonly<{ id: DebtId; outcome: DebtMutationResult }>[] }>;
export type DebtOutcome<A> =
  | Readonly<{ kind: "accepted"; value: A; cleanup?: DebtCleanupFailure }>
  | Readonly<{ kind: "refused"; refusal: DebtRefusal }>
  | Readonly<{ kind: "retry"; reason: DebtRetry }>;
export type DebtLifecycleVerb = Extract<DebtRefusal, { kind: "invalid-lifecycle-transition" }>["verb"];
export type SettledDebtAction = "done";
export type SettledDebtResult =
  | Readonly<{ kind: "changed"; debt: DebtView; action: SettledDebtAction; cleanup?: DebtCleanupFailure }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "refused"; refusal: DebtRefusal }>
  | Readonly<{ kind: "retry"; reason: DebtRetry }>;
export type AddDebtInput = Readonly<{
  title: string;
  namespace?: readonly string[];
  body?: string;
  note?: string;
  state?: DebtState;
  priority?: DebtPriority;
  needs?: readonly DebtId[];
  parent?: DebtId | null;
  supersedes?: readonly DebtId[];
  relates?: readonly DebtId[];
  actor?: string;
  signal?: AbortSignal;
}>;
export type AddDebtDocumentInput = Readonly<{
  markdown: string;
  namespace?: readonly string[];
  actor?: string;
  signal?: AbortSignal;
}>;
export type UpdateDebtInput = Readonly<{
  title?: string;
  body?: string;
  appendBody?: string;
  note?: string;
  priority?: DebtPriority;
  needs?: readonly DebtId[];
  addNeeds?: readonly DebtId[];
  dropNeeds?: readonly DebtId[];
  parent?: DebtId | null;
  supersedes?: readonly DebtId[];
  addSupersedes?: readonly DebtId[];
  dropSupersedes?: readonly DebtId[];
  relates?: readonly DebtId[];
  addRelates?: readonly DebtId[];
  dropRelates?: readonly DebtId[];
  signal?: AbortSignal;
}>;
