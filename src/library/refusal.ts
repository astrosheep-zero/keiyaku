import type { ContractId } from "../core/facts/types.js";
import type { IntentOutcome, IntentRefusal, IntentRetry } from "../protocol/operations.js";
import type { AcceptedIntent } from "./mutation.js";

export type ForkSourceRefusal = Readonly<{
  kind: "fork-source-missing" | "fork-source-unavailable" | "fork-source-invalid" | "fork-source-moved";
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
export type KeiyakuRetryReason = IntentRetry;

export class KeiyakuRefused extends Error {
  constructor(readonly refusal: KeiyakuRefusal) {
    super(`Keiyaku refused: ${refusal.kind}`);
    this.name = "KeiyakuRefused";
  }

  get code(): KeiyakuRefusal["kind"] {
    return this.refusal.kind;
  }
}

export class KeiyakuRetry extends Error {
  constructor(readonly reason: KeiyakuRetryReason) {
    super(reason.kind === "publication-failed" ? reason.diagnostic : `Keiyaku retry required: ${reason.kind}`);
    this.name = "KeiyakuRetry";
  }

  get code(): KeiyakuRetryReason["kind"] {
    return this.reason.kind;
  }
}

export function requireAccepted<Value, Refusal extends KeiyakuRefusal>(
  result: IntentOutcome<Value, Refusal>,
): AcceptedIntent<Value> {
  if (result.kind === "refused") throw new KeiyakuRefused(result.refusal);
  if (result.kind === "retry") throw new KeiyakuRetry(result.reason);
  return result;
}

export function forwardedMutationFailure(error: unknown): Readonly<{
  result: Readonly<{ kind: "refused"; refusal: KeiyakuRefusal } | { kind: "retry"; reason: KeiyakuRetryReason }>;
}> {
  if (error instanceof KeiyakuRefused) return { result: { kind: "refused", refusal: error.refusal } };
  if (error instanceof KeiyakuRetry) return { result: { kind: "retry", reason: error.reason } };
  throw error;
}
