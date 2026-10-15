import { z } from "zod";

export const identityKeys = [
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE", "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID", "PI_SESSION_ID", "PI_SESSION_FILE", "PASEO_AGENT_ID",
  "SQUARE_PARTICIPANT_NAME", "AKUMA_REQUESTS", "KEIYAKU_ACTOR_ID", "KEIYAKU_EXTERNAL_CALLER",
] as const;
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
    diffstat: z.object({ added: count, removed: count }).optional(),
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
      message: z.string().optional(), exitCode: z.number().int().optional() })]),
    durationMs: z.number().nonnegative().optional(), truncated: z.literal(true).optional() }),
  base.extend({ kind: z.enum(["said", "thought", "note", "call"]), ...turnFields, text: z.string(),
    truncated: z.literal(true).optional() }),
]);
export const historySchema = z.object({ rows: z.array(row), omitted: count,
  hasEarlier: z.boolean(), hasLater: z.boolean(), historyLost: z.boolean(),
  lowestRetained: count.nullable(), highest: count.nullable() });
export type Row = z.infer<typeof row>;
export type History = z.infer<typeof historySchema>;
export type Reader = (world: string, akuId: string, signal: AbortSignal, coveredThrough?: number) => Promise<History>;
/** One retained history page, newest first, bounded before the given sequence when supplied. */
export type HistoryPage = (world: string, akuId: string, signal: AbortSignal, before?: number) => Promise<History>;
// A bounded overlapping tail also catches mutable Tell rows. Page older retained
// rows on demand, never infer retention loss from holes in projected sequences.
export function pagedReader(page: HistoryPage): Reader {
  return async (world, akuId, signal, coveredThrough) => {
    let current: History | undefined;
    let newest: History | undefined;
    const rows = new Map<number, Row>();
    for (let pages = 0; pages < 5; pages++) {
      const before = current?.rows[0]?.sequence;
      current = await page(world, akuId, signal, before);
      newest ??= current;
      for (const row of current.rows) rows.set(row.sequence, row);
      const lowest = current.rows[0]?.sequence;
      if (!current.hasEarlier || lowest === undefined || (coveredThrough !== undefined && lowest <= coveredThrough)) break;
      if (before !== undefined && lowest >= before) throw new Error("Keiyaku history page did not advance");
    }
    return { ...newest!, rows: [...rows.values()].sort((a, b) => a.sequence - b.sequence),
      omitted: current!.omitted, hasEarlier: current!.hasEarlier,
      historyLost: current!.historyLost || newest!.historyLost };
  };
}
