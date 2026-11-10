import { type RegionOverlap } from "../region.js";
export { regionOverlapSchema, regionOverlapResultSchema, type RegionOverlap } from "../region.js";
import { decodeContractDocument } from "../body/decode.js";
import { regionsOverlapWithRelation } from "../body/region.js";
import type { ContractId } from "../core/facts/types.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import { documentsOperationAt, type RepositoryScope } from "../protocol/operations.js";

export type RegionObservation = Readonly<{ overlaps?: readonly RegionOverlap[]; overlapError?: string }>;
export type AmendRegionObservation = RegionObservation;

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
        const pairs = regionsOverlapWithRelation(mine, decodeContractDocument(peer.documentBytes).region);
        if (pairs.length > 0)
          overlaps.push({
            contractId: peer.contract,
            patterns: pairs.map(([minePattern, theirsPattern, relation]) => ({
              mine: minePattern,
              theirs: theirsPattern,
              ...(relation === "same" ? {} : { relation }),
            })),
          });
      } catch (error) {
        return { overlapError: `${peer.contract}: ${diagnostic(error)}` };
      }
    }
    return overlaps.length === 0 ? {} : { overlaps };
  } catch (error) {
    return { overlapError: diagnostic(error) };
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
