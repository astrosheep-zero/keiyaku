import { decodeContractDocument } from "../body/decode.js";
import { regionsOverlap } from "../body/region.js";
import type { ContractId } from "../core/facts/types.js";
import { documentsOperation, type RepositoryScope } from "../protocol/operations.js";

export type RegionOverlap = Readonly<{
  contract: ContractId;
  patterns: readonly Readonly<{ mine: string; theirs: string }>[];
}>;

export type RegionObservation = Readonly<
  | { overlaps: readonly RegionOverlap[]; overlapFailure?: never }
  | { overlapFailure: string; overlaps?: never }
>;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function observeRegion(scope: RepositoryScope, self: ContractId, mine: readonly string[]): RegionObservation {
  try {
    const overlaps: RegionOverlap[] = [];
    for (const peer of documentsOperation({ scope })) {
      if (peer.contract === self) continue;
      try {
        const pairs = regionsOverlap(mine, decodeContractDocument(peer.documentBytes).region);
        if (pairs.length > 0) overlaps.push({
          contract: peer.contract,
          patterns: pairs.map(([minePattern, theirsPattern]) => ({ mine: minePattern, theirs: theirsPattern })),
        });
      } catch (error) {
        return { overlapFailure: `${peer.contract}: ${diagnostic(error)}` };
      }
    }
    return { overlaps };
  } catch (error) {
    return { overlapFailure: diagnostic(error) };
  }
}
