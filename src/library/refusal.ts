import { contractId, type ContractId } from "../core/facts/types.js";
import type { IntentOutcome, IntentRefusal, IntentRetry } from "../protocol/operations.js";
import { decodeIntentRefusal, decodeProtocolTerminal } from "../protocol/result-codec.js";
import type { AcceptedIntent } from "./mutation.js";
import { ownerSchema } from "./result-codec.js";
import { z } from "zod";

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

function decodeForkSourceRefusal(value: unknown): ForkSourceRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed fork-source refusal");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== "kind" && key !== "contractId"))
    throw new Error("malformed fork-source refusal");
  if (
    object.kind !== "fork-source-missing" &&
    object.kind !== "fork-source-unavailable" &&
    object.kind !== "fork-source-invalid" &&
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

export class KeiyakuRefused extends Error {
  readonly kind = "refused" as const;

  constructor(readonly refusal: KeiyakuRefusal) {
    super(`Keiyaku refused: ${refusal.kind}`);
    this.name = "KeiyakuRefused";
  }

  get code(): KeiyakuRefusal["kind"] {
    return this.refusal.kind;
  }
}

export class KeiyakuRetry extends Error {
  readonly kind = "retry" as const;

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
