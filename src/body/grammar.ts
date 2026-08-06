export const CONTRACT_SECTION = {
  context: "context",
  objective: "objective",
  design: "design",
  region: "region",
  criteria: "criteria",
  verification: "verification",
} as const;

export type ContractSectionName = keyof typeof CONTRACT_SECTION;

export class ContractDocumentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContractDocumentError";
    this.code = code;
  }
}
