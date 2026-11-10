import { z } from "zod";
import { contractIdSchema } from "./git/identity.js";

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
