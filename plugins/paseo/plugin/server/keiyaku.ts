import { z } from "zod";
import type { activityHistorySchema } from "@astrosheep/keiyaku";

// Identity is the trust boundary. Never copy a rejected payload into the mirror.
const identity = z.object({ kind: z.string().min(1), sequence: z.number().int().positive().safe(),
  at: z.string().refine((value) => Number.isFinite(Date.parse(value))) }).passthrough();

export function createHistorySchema(producer: typeof activityHistorySchema) {
  const row = identity.transform((value) => {
    const decoded = producer.unwrap().shape.rows.unwrap().element.safeParse(value);
    if (decoded.success) return decoded.data;
    return { kind: "adapter-diagnostic" as const, sequence: value.sequence, at: value.at,
      recordKind: value.kind.slice(0, 80).replace(/[^a-zA-Z0-9_.-]/gu, "?") };
  });
  return producer.unwrap().omit({ rows: true }).extend({ rows: z.array(row) });
}
export type History = z.output<ReturnType<typeof createHistorySchema>>;
export type Row = History["rows"][number];
