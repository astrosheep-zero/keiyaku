import { decodeContractDocument } from "../body/decode.js";
import { assertCanonicalRegionPath, regionPatternsMatchPath, regionsOverlap } from "../body/region.js";
import type { ContractId } from "../core/facts/types.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { documentsOperationAt, type RepositoryScope } from "../protocol/operations.js";
import type { ContractDocumentProjection } from "../protocol/operations.js";

export type RegionOverlap = Readonly<{
  contract: ContractId;
  patterns: readonly Readonly<{ mine: string; theirs: string }>[];
}>;

export type RegionObservation = Readonly<
  | { overlaps: readonly RegionOverlap[]; overlapFailure?: never }
  | { overlapFailure: string; overlaps?: never }
>;

export type RegionDeclarationRead = Readonly<{ contract: ContractId; patterns: readonly string[] }>;

export function readRegionDeclarations(documents: readonly ContractDocumentProjection[]): readonly RegionDeclarationRead[] {
  return documents.map((document) => ({ contract: document.contract, patterns: decodeContractDocument(document.documentBytes).region }));
}

export function regionIntersections(left: readonly string[], right: readonly string[]): readonly Readonly<{ left: string; right: string }>[] {
  return regionsOverlap(left, right).map(([leftPattern, rightPattern]) => ({ left: leftPattern, right: rightPattern }));
}

export function regionPathMatches(patterns: readonly string[], path: string): readonly string[] {
  return regionPatternsMatchPath(patterns, path);
}

export function validateRegionPath(path: unknown): asserts path is string {
  if (typeof path !== "string") throw new Error("Region path must be a string");
  assertCanonicalRegionPath(path);
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function observeRegion(
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  self: ContractId,
  mine: readonly string[],
): Promise<RegionObservation> {
  try {
    const overlaps: RegionOverlap[] = [];
    for (const peer of await documentsOperationAt(scope, channel)) {
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
