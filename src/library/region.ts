import { decodeContractDocument } from "../body/decode.js";
import { assertRegionPattern, regionsOverlap } from "../body/region.js";
import type { ContractId } from "../core/facts/types.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import { documentsOperationAt, type RepositoryScope } from "../protocol/operations.js";
import type { ContractDocumentProjection } from "../protocol/read/documents.js";

export type RegionOverlap = Readonly<{
  contract: ContractId;
  patterns: readonly Readonly<{ mine: string; theirs: string }>[];
}>;

export type RegionObservation = Readonly<
  { overlaps: readonly RegionOverlap[]; overlapFailure?: never } | { overlapFailure: string; overlaps?: never }
>;

export type AmendRegionObservation =
  | RegionObservation
  | Readonly<{
      overlaps?: never;
      overlapFailure?: never;
    }>;

export type RegionDeclarationRead = Readonly<{ contract: ContractId; patterns: readonly string[] }>;

export function readRegionDeclarations(
  documents: readonly ContractDocumentProjection[],
): readonly RegionDeclarationRead[] {
  return documents.map((document) => ({
    contract: document.contract,
    patterns: decodeContractDocument(document.documentBytes).region,
  }));
}

export function regionOverlaps(
  mine: readonly string[],
  declarations: readonly RegionDeclarationRead[],
): readonly RegionOverlap[] {
  const overlaps: RegionOverlap[] = [];
  for (const declaration of declarations) {
    const pairs = regionsOverlap(mine, declaration.patterns);
    if (pairs.length === 0) continue;
    overlaps.push({
      contract: declaration.contract,
      patterns: pairs.map(([minePattern, theirsPattern]) => ({ mine: minePattern, theirs: theirsPattern })),
    });
  }
  return overlaps;
}

export function validateRegionPatterns(patterns: unknown): readonly [string, ...string[]] {
  if (!Array.isArray(patterns) || patterns.length === 0) throw new Error("Region query requires one or more path patterns");
  return patterns.map((pattern) => {
    if (typeof pattern !== "string") throw new Error("Region path patterns must be strings");
    return assertRegionPattern(pattern);
  }) as [string, ...string[]];
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
        if (pairs.length > 0)
          overlaps.push({
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

export async function observeChangedRegion(
  scope: RepositoryScope,
  self: ContractId,
  changed: ReadonlySet<string> | undefined,
  mine: readonly string[],
): Promise<AmendRegionObservation> {
  if (!changed?.has("region")) return {};
  return await withGitDecodeChannel(scope, async (channel) => await observeRegion(scope, channel, self, mine));
}
