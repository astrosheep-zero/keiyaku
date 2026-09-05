import type { LeadingOutcome } from "../protocol/outcome.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { executionReceipt, executionReceiptSchema, withExecutionReceipt } from "./execution-result.js";
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

const contractLiveFailureSchema = z.union([
  z
    .object({
      kind: z.literal("post-admission-failure"),
      category: z.enum(["authority-corruption", "type-error", "error"]),
      diagnostic: z.string(),
      receipt: executionReceiptSchema,
    })
    .strict(),
  z.object({ kind: z.literal("refused"), refusal: keiyakuRefusalSchema }).strict(),
  z.object({ kind: z.literal("retry"), reason: keiyakuRetryReasonSchema }).strict(),
]);

export function encodeContractLiveFailure(error: unknown): unknown | null {
  const receipt = executionReceipt(error);
  if (receipt !== undefined)
    return {
      kind: "post-admission-failure",
      category:
        error instanceof AuthorityCorruptionError
          ? "authority-corruption"
          : error instanceof TypeError
            ? "type-error"
            : "error",
      diagnostic: error instanceof Error ? error.message : String(error),
      receipt,
    };
  if (error instanceof KeiyakuRefused) {
    return { kind: "refused", refusal: error.refusal };
  }
  if (error instanceof KeiyakuRetry) {
    return { kind: "retry", reason: error.reason };
  }
  return null;
}

export function decodeContractLiveFailure(value: unknown): Error | null {
  const parsed = contractLiveFailureSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.kind === "post-admission-failure") {
    const failure =
      parsed.data.category === "authority-corruption"
        ? new AuthorityCorruptionError(parsed.data.diagnostic)
        : parsed.data.category === "type-error"
          ? new TypeError(parsed.data.diagnostic)
          : new Error(parsed.data.diagnostic);
    return withExecutionReceipt(failure, parsed.data.receipt);
  }
  return parsed.data.kind === "refused"
    ? new KeiyakuRefused(decodeKeiyakuRefusal(parsed.data.refusal))
    : new KeiyakuRetry(parsed.data.reason);
}

export function requireAccepted<Value, Refusal extends KeiyakuRefusal>(
  result: IntentOutcome<Value, Refusal>,
): AcceptedIntent<Value> {
  if (result.kind === "refused") throw new KeiyakuRefused(result.refusal);
  if (result.kind === "retry") throw new KeiyakuRetry(result.reason);
  return result;
}

export function requireLeadingAdmission<Value, Refusal extends KeiyakuRefusal>(
  result: LeadingOutcome<Value, Refusal>,
): Extract<LeadingOutcome<Value, Refusal>, { kind: "accepted" }> {
  if (result.kind === "refused") throw new KeiyakuRefused(result.refusal);
  if (result.kind === "retry") throw new KeiyakuRetry(result.reason);
  return result;
}
