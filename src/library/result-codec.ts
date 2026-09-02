import { z } from "zod";

export function ownerSchema<Value>(decode: (value: unknown) => Value, message: string): z.ZodType<Value> {
  return z.unknown().transform((value, context) => {
    try {
      return decode(value);
    } catch {
      context.addIssue({ code: "custom", message });
      return z.NEVER;
    }
  });
}
