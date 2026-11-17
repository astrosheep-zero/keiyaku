import { z } from "zod";

/** One copyable history address: a positive safe integer written canonically as a decimal string. */
export const canonicalDecimalSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .refine((value) => Number.isSafeInteger(Number(value)), {
    message: "must be a positive safe integer written canonically as a decimal string",
  });

const historySequence = z.number().int().positive().safe();
const historyLimit = historySequence
  .max(5_000)
  .exactOptional()
  .describe("Maximum timeline entries (1..5000, default 12).");

/** The page leaves both history families accept: before/limit, then since/limit. */
export const historyPageSchemas = [
  z.strictObject({
    before: historySequence
      .exactOptional()
      .describe(
        "Read the most recent entries strictly before this sequence; omit for the latest entries. Cannot be combined with since or item.",
      ),
    limit: historyLimit,
  }),
  z.strictObject({
    since: historySequence.describe(
      "Read the earliest entries strictly after this sequence. Cannot be combined with before or item.",
    ),
    limit: historyLimit,
  }),
] as const;

/** One family's requested timeline window; cursors are strictly exclusive. */
export type HistoryCursor = Readonly<{ before?: number; since?: number; limit?: number }>;

/** Both families default to the latest twelve timeline entries. */
const DEFAULT_HISTORY_LIMIT = 12;

/**
 * Select one page of native-sequence-ordered rows. A `before` or omitted cursor
 * takes the most recent eligible rows, `since` the earliest newer ones, and
 * every answer stays in ascending native sequence order.
 */
export function selectHistoryPage<Row>(
  rows: readonly Row[],
  sequence: (row: Row) => number,
  cursor: HistoryCursor,
): Readonly<{ rows: readonly Row[]; omitted: number }> {
  const eligible = rows.filter((row) =>
    cursor.before !== undefined
      ? sequence(row) < cursor.before
      : cursor.since !== undefined
        ? sequence(row) > cursor.since
        : true,
  );
  const limit = cursor.limit ?? DEFAULT_HISTORY_LIMIT;
  const selected = cursor.since !== undefined ? eligible.slice(0, limit) : eligible.slice(-limit);
  return { rows: selected, omitted: Math.max(0, eligible.length - selected.length) };
}
