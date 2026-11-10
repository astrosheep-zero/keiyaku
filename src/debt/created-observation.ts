import type { WorldRoot } from "../world.js";
import { z } from "zod";
import { projectCreatedByRows, debtSummarySchema, type DebtBoard } from "./board.js";
import { readBoard } from "./store.js";

export const createdDebtObservationSchema = z.union([
  z
    .object({ kind: z.literal("present"), rows: z.array(debtSummarySchema).min(1).readonly().exactOptional() })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("failed"), diagnostic: z.string() })
    .strict()
    .readonly(),
]);

export type CreatedDebtObservation = z.infer<typeof createdDebtObservationSchema>;

function observationDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Project Debt board rows created by each identity, preserving input order. One complete
 * board and one relationship projection answer every requested identity, and only the
 * documents those identities created reach row projection.
 */
export async function observeCreatedDebtObservations(
  world: WorldRoot,
  createdByIds: readonly string[],
): Promise<readonly CreatedDebtObservation[]> {
  if (createdByIds.length === 0) return [];
  let board: DebtBoard;
  try {
    board = (await readBoard(world)).board;
  } catch (error) {
    const failed = { kind: "failed" as const, diagnostic: observationDiagnostic(error) };
    return createdByIds.map(() => failed);
  }
  const rows = projectCreatedByRows(board, createdByIds);
  return createdByIds.map((createdBy) => {
    const selected = rows.get(createdBy) ?? [];
    return { kind: "present", ...(selected.length === 0 ? {} : { rows: selected }) };
  });
}
