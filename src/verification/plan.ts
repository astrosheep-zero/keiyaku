import type { VerificationDeclaration } from "../core/facts/types.js";

export type VerificationPlanStep = Readonly<{
  readonly declaration: VerificationDeclaration;
  readonly argv: readonly string[];
}>;

function validateDeclaration(declaration: VerificationDeclaration): void {
  if (declaration.executor !== "bash" && declaration.executor !== "zsh" && declaration.executor !== "pwsh") {
    throw new TypeError("verification declaration has an unsupported executor");
  }
  if (typeof declaration.script !== "string" || declaration.script.trim().length === 0) {
    throw new TypeError("verification declaration script must be nonblank");
  }
}

export function resolveVerificationPlan(declarations: readonly VerificationDeclaration[]): readonly VerificationPlanStep[] {
  if (declarations.length === 0) throw new TypeError("verification plan must contain at least one declaration");
  return declarations.map((declaration) => {
    validateDeclaration(declaration);
    const args = declaration.executor === "pwsh" ? ["-Command", declaration.script] : ["-c", declaration.script];
    return { declaration: { ...declaration }, argv: [declaration.executor, ...args] };
  });
}
