import { createHash } from "node:crypto";
import type { Preparation } from "../core/decide.js";
import {
  gate,
  requirementId,
  type ContractId,
  type DocumentSegmentKey,
  type Gate,
  type RequirementId,
} from "../core/facts/types.js";

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

export type VerificationDeclarationPreparation = Preparation<
  VerificationDefinition | null,
  VerificationDeclarationRefusal
>;

export const VERIFIED = gate("verified");

/** The display index and surrounding document never participate in execution identity. */
export function verificationRequirement(declaration: VerificationDeclaration): RequirementId {
  const content = JSON.stringify([declaration.executor, declaration.script, declaration.timeoutMs ?? null]);
  return requirementId(`verification:sha256:${createHash("sha256").update(content).digest("hex")}`);
}

export function singletonRequirement(declaredGate: Gate): RequirementId {
  return requirementId(`gate:${declaredGate}`);
}

export function gateRequirements(
  gates: readonly Gate[],
  definition: VerificationDefinition | null,
): Readonly<Record<string, readonly RequirementId[]>> {
  return Object.fromEntries(
    gates.map((declaredGate) => [
      declaredGate,
      declaredGate === VERIFIED
        ? [...new Set(definition?.declarations.map(verificationRequirement) ?? [])]
        : [singletonRequirement(declaredGate)],
    ]),
  );
}

export function prepareVerificationDeclaration(
  input: Readonly<{
    gates: readonly Gate[];
    definition: VerificationDefinition | null;
    contractId?: ContractId;
  }>,
): VerificationDeclarationPreparation {
  if (!input.gates.includes(VERIFIED)) return { kind: "prepared", data: null };
  if (input.definition !== null && input.definition.declarations.length > 0)
    return { kind: "prepared", data: input.definition };
  return {
    kind: "refused",
    refusal: {
      kind: "verification-declaration-invalid",
      ...(input.contractId === undefined ? {} : { contractId: input.contractId }),
    },
  };
}
