import { z } from "zod";
import { contractIdSchema } from "../git/identity.js";
import { decodeContractDocument } from "../document/decode.js";
import { regionsOverlapWithRelation } from "../document/region.js";
import type { ContractId } from "../core/facts/types.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import { documentsOperationAt, type RepositoryScope } from "../protocol/operations.js";

export const regionOverlapSchema = z
  .object({
    contractId: contractIdSchema,
    patterns: z
      .array(
        z
          .object({
            mine: z.string(),
            theirs: z.string(),
            relation: z.enum(["mine-within-theirs", "theirs-within-mine", "intersect"]).exactOptional(),
          })
          .strict(),
      )
      .min(1)
      .readonly(),
  })
  .strict();
export type RegionOverlap = z.infer<typeof regionOverlapSchema>;

const regionPatternSchema = regionOverlapSchema.shape.patterns.unwrap().element;
export const regionOverlapResultSchema = regionOverlapSchema
  .extend({
    patterns: z
      .array(
        regionPatternSchema
          .extend({ relation: regionPatternSchema.shape.relation.unwrap().exactOptional() })
          .readonly(),
      )
      .min(1)
      .readonly(),
  })
  .readonly();

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
