import { contractIdSchema } from "../git/identity.js";
import { z } from "zod";

export const dispatchAssociationSchema = z.union([
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("associated"), contractId: contractIdSchema }).strict(),
  z.object({ kind: z.literal("failed"), diagnostic: z.string() }).strict(),
]);

export type DispatchAssociation = z.infer<typeof dispatchAssociationSchema>;

export const NO_DISPATCH_ASSOCIATION: DispatchAssociation = { kind: "none" };

export function parseDispatchAssociation(value: unknown): DispatchAssociation {
  return dispatchAssociationSchema.parse(value);
}
