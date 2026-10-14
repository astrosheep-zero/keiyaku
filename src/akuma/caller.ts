import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { WorldRoot } from "../world.js";
import { akumaIdSchema } from "./identity.js";
import { akumaOriginSchema, type Soul } from "./heart/facts.js";

// Stored attribution is a coordinate, not a live World capability or lookup.
const callerWorldSchema = z.custom<WorldRoot>(
  (value) => typeof value === "string" && isAbsolute(value) && resolve(value) === value,
  "caller world must be an absolute normalized path",
);
export const akumaCallerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("akuma"), world: callerWorldSchema, akuId: akumaIdSchema }).strict(),
  z
    .object({
      kind: z.literal("external"),
      integration: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u),
      id: z
        .string()
        .max(512)
        .refine(
          (value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
          "external caller id must be nonblank and contain no control characters",
        ),
    })
    .strict(),
]);
export type AkumaCaller = z.infer<typeof akumaCallerSchema>;
export const akumaBirthSchema = z
  .object({
    origin: akumaOriginSchema,
    caller: z.union([akumaCallerSchema, z.object({ kind: z.literal("unknown") }).strict()]),
  })
  .strict();

export function projectAkumaBirth(soul: Soul): z.infer<typeof akumaBirthSchema> {
  return { origin: soul.origin, caller: soul.caller ?? { kind: "unknown" } };
}

export function decodeAkumaCaller(value: unknown): AkumaCaller | undefined {
  if (value === undefined) return undefined;
  const parsed = akumaCallerSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`Invalid Akuma caller: ${parsed.error.message}`);
  return parsed.data;
}
