import type { DebtPriority, DebtState } from "./document.js";
import type { DebtId } from "./identity.js";

import type { DebtCleanupFailure, DebtRefusal, DebtRetry, DebtView } from "./mutation-result.js";
export type {
  DebtView,
  DebtCleanupFailure,
  DebtRefusal,
  DebtRetry,
  DebtMutationResult,
  DebtUpdateResult,
  DebtBatchResult,
} from "./mutation-result.js";
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
