import { observeGit } from "../../git/observe.js";
import type { GitRepository } from "../../git/repository.js";
import type { ContractId } from "../../core/facts/types.js";

export type ContractDocumentProjection = Readonly<{
  contract: ContractId;
  documentBytes: string;
}>;

/** Read every live contract document from one immutable Git snapshot. */
export function readDocuments(
  repository: GitRepository,
): readonly ContractDocumentProjection[] {
  const observed = observeGit(repository);
  const documents: ContractDocumentProjection[] = [];
  for (const [contract, observation] of observed.contracts) {
    const state = observation.state;
    if (state === null || state.terminal !== null) continue;
    documents.push({
      contract,
      documentBytes: state.terms.document.bytes,
    });
  }
  return documents;
}
