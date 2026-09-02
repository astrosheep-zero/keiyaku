import type { Preparation } from "../core/decide.js";
import { contractId, gate, type ContractId, type DocumentSegmentKey, type Gate } from "../core/facts/types.js";

export type VerificationExecutor = "bash" | "zsh" | "pwsh";

export type VerificationDeclaration = Readonly<{
  readonly executor: VerificationExecutor;
  readonly script: string;
  readonly timeoutMs?: number;
}>;

export type VerificationDefinition = Readonly<{
  readonly segment: DocumentSegmentKey;
  readonly declarations: readonly VerificationDeclaration[];
}>;

export type VerificationDeclarationRefusal = Readonly<{
  kind: "verification-declaration-invalid";
  contractId?: ContractId;
}>;

export function decodeVerificationDeclarationRefusal(value: unknown): VerificationDeclarationRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed verification declaration refusal");
  const object = value as Record<string, unknown>;
  if (object.kind !== "verification-declaration-invalid") throw new Error("malformed verification declaration refusal");
  if (Object.keys(object).some((key) => key !== "kind" && key !== "contractId"))
    throw new Error("malformed verification declaration refusal");
  if (object.contractId === undefined) return { kind: "verification-declaration-invalid" };
  try {
    return { kind: "verification-declaration-invalid", contractId: contractId(String(object.contractId)) };
  } catch {
    throw new Error("malformed verification declaration refusal");
  }
}

export type VerificationDeclarationPreparation = Preparation<
  VerificationDefinition | null,
  VerificationDeclarationRefusal
>;

export const VERIFIED = gate("verified");

export function prepareVerificationDeclaration(
  input: Readonly<{
    gates: readonly Gate[];
    definition: VerificationDefinition | null;
    contractId?: ContractId;
  }>,
): VerificationDeclarationPreparation {
  if (input.definition !== null || !input.gates.includes(VERIFIED)) {
    return { kind: "prepared", data: input.definition };
  }
  return {
    kind: "refused",
    refusal: {
      kind: "verification-declaration-invalid",
      ...(input.contractId === undefined ? {} : { contractId: input.contractId }),
    },
  };
}
