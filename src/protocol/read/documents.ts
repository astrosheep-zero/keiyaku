import { observeActiveContractWorld } from "../../git/observe.js";
import type { GitReadObservation } from "../../git/read-observation.js";
import type { ContractId } from "../../core/facts/types.js";

export type ContractDocumentProjection = Readonly<{
  contract: ContractId;
  documentBytes: string;
}>;

/** Read every live contract document from one immutable Git snapshot. */
export async function readDocuments(
  observation: GitReadObservation,
): Promise<readonly ContractDocumentProjection[]> {
  const observed = await observeActiveContractWorld(observation);
  const documents: ContractDocumentProjection[] = [];
  for (const [contract, observation] of observed.contracts) {
    const state = observation.state;
    if (state === null) continue;
    documents.push({
      contract,
      documentBytes: state.terms.document.bytes,
    });
  }
  return documents;
}
