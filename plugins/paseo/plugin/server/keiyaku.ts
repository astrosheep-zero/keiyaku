import { z } from "zod";

const count = z.number().int().nonnegative();
const base = z.object({ sequence: count, at: z.string() });
const turnFields = { turnSequence: count };
const input = z.object({ json: z.string(), truncated: z.boolean() });
const call = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), command: z.string() }),
  z.object({ kind: z.literal("read"), path: z.string(), offset: count.optional(), limit: count.optional() }),
  z.object({ kind: z.literal("search"), query: z.string(), scope: z.enum(["content", "files", "web"]).optional(),
    path: z.string().optional(), glob: z.string().optional() }),
  z.object({ kind: z.literal("fileChange"), changes: z.array(z.object({
    op: z.enum(["add", "update", "delete", "unspecified"]), path: z.string(),
    diffstat: z.object({ added: count, removed: count }).optional(), patch: z.string().optional(),
  })) }),
  z.object({ kind: z.literal("other"), display: z.string(), input: input.optional() }),
]);
const row = z.union([
  base.extend({ kind: z.literal("turn"), ...turnFields, bodySequence: count.optional() }),
  base.extend({ kind: z.literal("tell"), tellId: z.string(), text: z.string(), state: z.enum(["pending", "told"]),
    deliveries: z.array(z.object({ deliveredAt: z.string(), route: z.enum(["launch", "live"]),
      turnSequence: count, receipt: z.enum(["unavailable", "required"]).optional() })).optional() }),
  base.extend({ kind: z.literal("outcome"), ...turnFields, outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("answered"), historyId: z.string().optional(), answer: z.string(),
      foldedSaidSequence: count.optional() }),
    z.object({ kind: z.literal("failed"), historyId: z.string().optional(), diagnostic: z.string() }),
  ]) }),
  base.extend({ kind: z.literal("tool"), ...turnFields, name: z.string(), toolId: z.string().optional(), call,
    state: z.union([z.enum(["active", "unsettled"]), z.object({ status: z.enum(["ok", "error"]),
      message: z.string().optional(), exitCode: z.number().int().optional(), output: z.string().optional() })]),
    durationMs: z.number().nonnegative().optional(), truncated: z.literal(true).optional() }),
  base.extend({ kind: z.enum(["said", "thought", "note", "call"]), ...turnFields, text: z.string(),
    truncated: z.literal(true).optional() }),
]);
export const historySchema = z.object({ rows: z.array(row), omitted: count,
  hasEarlier: z.boolean(), hasLater: z.boolean(), historyLost: z.boolean(),
  lowestRetained: count.nullable(), highest: count.nullable() });
export type Row = z.infer<typeof row>;
export type History = z.infer<typeof historySchema>;
