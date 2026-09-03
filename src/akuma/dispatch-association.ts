import { contractId } from "../core/facts/types.js";
import { z } from "zod";

const contractIdSchema = z.string().transform((value, context) => {
  try {
    return contractId(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected ContractId" });
    return z.NEVER;
  }
});

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
