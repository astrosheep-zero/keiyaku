import { contractId, type ContractId } from "../core/facts/types.js";
import type { IntentRefusal, IntentRetry } from "../protocol/operations.js";
import { decodeIntentRefusal, decodeProtocolTerminal } from "../protocol/result-codec.js";
import { decodeTargetInputRefusal } from "../protocol/bind.js";
import { ownerSchema } from "./result-codec.js";
import { z } from "zod";

export type ForkSourceRefusal = Readonly<{
  kind: "fork-source-missing" | "fork-source-unavailable" | "fork-source-moved";
  contractId: ContractId;
}>;

export type NukeConfirmationRefusal = Readonly<{
  kind: "nuke-confirmation-mismatch";
  world: string;
  confirmation: string;
}>;
export type NukeConfirmationRequiredRefusal = Readonly<{
  kind: "nuke-confirmation-required";
  world: string;
}>;

export type KeiyakuRefusal =
  | IntentRefusal
  | ForkSourceRefusal
  | NukeConfirmationRefusal
  | NukeConfirmationRequiredRefusal;
export type ForwardingRetry = Readonly<{
  kind: "owner-reason-unavailable";
  diagnostic: string;
}>;
export type KeiyakuRetryReason = IntentRetry | ForwardingRetry;
export type OperationRetries = Readonly<{
  bind: IntentRetry;
  amend: IntentRetry;
  deliver: IntentRetry | ForwardingRetry;
  review: IntentRetry | ForwardingRetry;
  audit: IntentRetry | ForwardingRetry;
  arc: IntentRetry;
  abandon: IntentRetry;
}>;

export type OperationRefusals = Readonly<{
  bind:
    | import("../protocol/bind.js").BindRefusal
    | import("../protocol/bind.js").TargetInputRefusal
    | ForkSourceRefusal
    | import("../verification/declaration.js").VerificationDeclarationRefusal;
  amend:
    | import("../core/verbs/amend.js").AmendRefusal
    | import("../verification/declaration.js").VerificationDeclarationRefusal;
  deliver:
    | import("../core/verbs/deliver.js").DeliverRefusal
    | import("../protocol/operations.js").DeliveryPreparationRefusal
    | import("../protocol/operations.js").DeliverConflictRefusal
    | import("../verification/declaration.js").VerificationDeclarationRefusal;
  review: import("../protocol/review.js").ReviewRefusal;
  audit: import("../protocol/audit.js").AuditRefusal;
  arc: import("../core/verbs/arc.js").ArcRefusal;
  abandon: import("../core/verbs/abandon.js").AbandonRefusal;
}>;

const REFUSAL_KINDS = {
  bind: [
    "contract-exists",
    "invalid-after",
    "unknown-prerequisite",
    "invalid-target",
    "target-missing",
    "unborn-head",
    "fork-source-missing",
    "fork-source-unavailable",
    "fork-source-moved",
    "verification-declaration-invalid",
  ],
  amend: [
    "contract-missing",
    "terminal",
    "terms-moved",
    "unknown-prerequisite",
    "cyclic-prerequisite",
    "verification-declaration-invalid",
  ],
  deliver: [
    "contract-missing",
    "terminal",
    "document-moved",
    "target-missing",
    "worktree-missing",
    "dirty-workspace",
    "unmerged-paths",
    "integration-failed",
    "integration-unsupported",
    "merge-state-present",
    "checkout-not-followable",
    "verification-declaration-invalid",
  ],
  review: ["contract-missing", "terminal", "worktree-missing", "dirty-workspace"],
  audit: ["contract-missing", "terminal", "document-moved", "verification-declaration-invalid"],
  arc: ["contract-missing", "terminal"],
  abandon: ["contract-missing", "terminal"],
} as const;

/** Operation narrowing is enforced at the real live boundary, not just in caller declarations. */
export function decodeOperationRefusal<Operation extends keyof OperationRefusals>(
  operation: Operation,
  value: unknown,
): OperationRefusals[Operation] {
  const refusal =
    operation === "bind" &&
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    ["invalid-target", "target-missing", "unborn-head"].includes(String(value.kind))
      ? decodeTargetInputRefusal(value)
      : decodeKeiyakuRefusal(value);
  if (operation !== "bind" && refusal.kind === "target-missing" && !("contractId" in refusal))
    throw new Error("refusal does not belong to operation");
  if (!(REFUSAL_KINDS[operation] as readonly string[]).includes(refusal.kind))
    throw new Error("refusal does not belong to operation");
  // All decoding belongs to the existing reason owners; this selection cannot admit another operation's reason.
  return refusal as OperationRefusals[Operation];
}

export function decodeOperationRetry<Operation extends keyof OperationRetries>(
  operation: Operation,
  value: unknown,
): OperationRetries[Operation] {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "owner-reason-unavailable"
  ) {
    if (
      !["deliver", "review", "audit"].includes(operation) ||
      Object.keys(value).length !== 2 ||
      !("diagnostic" in value) ||
      typeof value.diagnostic !== "string"
    )
      throw new Error("malformed forwarding retry");
    return { kind: "owner-reason-unavailable", diagnostic: value.diagnostic } as OperationRetries[Operation];
  }
  return decodeProtocolTerminal(value);
}

function decodeForkSourceRefusal(value: unknown): ForkSourceRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed fork-source refusal");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== "kind" && key !== "contractId"))
    throw new Error("malformed fork-source refusal");
  if (
    object.kind !== "fork-source-missing" &&
    object.kind !== "fork-source-unavailable" &&
    object.kind !== "fork-source-moved"
  )
    throw new Error("malformed fork-source refusal");
  if (typeof object.contractId !== "string") throw new Error("malformed fork-source refusal");
  return { kind: object.kind, contractId: contractId(object.contractId) };
}

function decodeNukeRefusal(value: unknown): NukeConfirmationRefusal | NukeConfirmationRequiredRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed nuke refusal");
  const object = value as Record<string, unknown>;
  if (object.kind === "nuke-confirmation-required") {
    if (Object.keys(object).some((key) => key !== "kind" && key !== "world")) throw new Error("malformed nuke refusal");
    if (typeof object.world !== "string" || object.world.trim() === "") throw new Error("malformed nuke refusal");
    return { kind: "nuke-confirmation-required", world: object.world };
  }
  if (object.kind !== "nuke-confirmation-mismatch") throw new Error("malformed nuke refusal");
  if (Object.keys(object).some((key) => key !== "kind" && key !== "world" && key !== "confirmation"))
    throw new Error("malformed nuke refusal");
  if (typeof object.world !== "string" || object.world.trim() === "" || typeof object.confirmation !== "string")
    throw new Error("malformed nuke refusal");
  return { kind: "nuke-confirmation-mismatch", world: object.world, confirmation: object.confirmation };
}

/** One owner decoder for every expected non-admission reason, Contract or World. */
export function decodeKeiyakuRefusal(value: unknown): KeiyakuRefusal {
  try {
    return decodeIntentRefusal(value);
  } catch {
    try {
      return decodeForkSourceRefusal(value);
    } catch {
      return decodeNukeRefusal(value);
    }
  }
}

export const keiyakuRefusalSchema = ownerSchema(
  decodeKeiyakuRefusal,
  "expected keiyaku refusal",
) satisfies z.ZodType<KeiyakuRefusal>;
export const keiyakuRetryReasonSchema = ownerSchema(
  decodeProtocolTerminal,
  "expected keiyaku retry",
) satisfies z.ZodType<KeiyakuRetryReason>;
