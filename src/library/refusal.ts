import type { ContractId } from "../core/facts/types.js";
import type { IntentOutcome, IntentRefusal, IntentRetry } from "../protocol/operations.js";
import type { AcceptedIntent } from "./mutation.js";

export type ContractAppointmentRefusal = Readonly<{
  kind: "here-worktree-appointed";
  path: string;
  contract?: ContractId;
}>;

export type KeiyakuRefusal = IntentRefusal | ContractAppointmentRefusal;
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
