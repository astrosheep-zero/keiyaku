import type { DocumentKey, DocumentSegmentKey } from "../core/facts/types.js";
import type { VerificationDeclaration } from "../verification/declaration.js";

export type ContractCriterion = Readonly<{
  readonly title: string;
  readonly body: string;
}>;

export type ContractExtension = Readonly<{
  readonly title: string;
  readonly content: string;
}>;

export type ContractBody = Readonly<{
  readonly title: string;
  readonly context: string;
  readonly objective: string;
  readonly design: string;
  readonly region: readonly string[];
  readonly criteria: readonly ContractCriterion[];
  readonly verification: readonly VerificationDeclaration[];
  readonly extensions: readonly ContractExtension[];
}>;

export type DecodedContractDocument = ContractBody &
  Readonly<{
    readonly document: Readonly<{ readonly bytes: string; readonly key: DocumentKey }>;
    readonly segments: readonly DocumentSegmentKey[];
    readonly verificationSegment: DocumentSegmentKey | null;
  }>;
