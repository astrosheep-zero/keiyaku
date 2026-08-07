import type { DocumentSegmentKey } from "../core/facts/types.js";

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
  contractId?: import("../core/facts/types.js").ContractId;
}>;
