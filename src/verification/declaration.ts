import type { Preparation } from "../core/decide.js";
import { gate, type ContractId, type DocumentSegmentKey, type Gate } from "../core/facts/types.js";

export type VerificationExecutor = "bash" | "zsh" | "pwsh";

export type VerificationDeclaration = Readonly<{
  readonly executor: VerificationExecutor;
  readonly script: string;
}>;

export type VerificationDefinition = Readonly<{
  readonly segment: DocumentSegmentKey;
  readonly declarations: readonly VerificationDeclaration[];
}>;

export type VerificationDeclarationRefusal = Readonly<{
  kind: "verification-declaration-invalid";
  contractId?: ContractId;
}>;

export type VerificationDeclarationPreparation = Preparation<
  VerificationDefinition | null,
  VerificationDeclarationRefusal
>;

export const VERIFIED = gate("verified");

export function prepareVerificationDeclaration(input: Readonly<{
  gates: readonly Gate[];
  definition: VerificationDefinition | null;
  contractId?: ContractId;
}>): VerificationDeclarationPreparation {
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
