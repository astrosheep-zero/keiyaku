import { z } from "zod";
import { contractIdSchema } from "../protocol/operations.js";
import { decodeContractDocument } from "../body/decode.js";
import { regionsOverlapWithRelation } from "../body/region.js";
import type { ContractId } from "../core/facts/types.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import { documentsOperationAt, type RepositoryScope } from "../protocol/operations.js";

export const regionOverlapSchema = z
  .object({
    contract: contractIdSchema,
    patterns: z
      .array(
        z
          .object({
            mine: z.string(),
            theirs: z.string(),
            relation: z.enum(["same", "mine-within-theirs", "theirs-within-mine", "intersect"]).optional(),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();
export type RegionOverlap = z.infer<typeof regionOverlapSchema>;

export type RegionObservation = Readonly<
  { overlaps: readonly RegionOverlap[]; overlapFailure?: never } | { overlapFailure: string; overlaps?: never }
>;

export type AmendRegionObservation =
  | RegionObservation
  | Readonly<{
      overlaps?: never;
      overlapFailure?: never;
    }>;

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
            contract: peer.contract,
            patterns: pairs.map(([minePattern, theirsPattern, relation]) => ({
              mine: minePattern,
              theirs: theirsPattern,
              relation,
            })),
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
