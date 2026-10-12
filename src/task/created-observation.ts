import type { WorldRoot } from "../world.js";
import { z } from "zod";
import { createTaskRelations, projectCreatedByRows, taskRowsSchema, type TaskBoard } from "./board.js";
import { readBoard } from "./store.js";

export const createdTaskObservationSchema = z.union([
  z.object({ kind: z.literal("present"), rows: taskRowsSchema }).strict(),
  z.object({ kind: z.literal("failed"), diagnostic: z.string() }).strict(),
]);

export type CreatedTaskObservation = z.infer<typeof createdTaskObservationSchema>;

export const EMPTY_CREATED_TASK_OBSERVATION: CreatedTaskObservation = { kind: "present", rows: [] };

function observationDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Project Task board rows created by each identity, preserving input order. One complete
 * board and one relationship projection answer every requested identity, and only the
 * documents those identities created reach row projection.
 */
export async function observeCreatedTaskObservations(
  world: WorldRoot,
  createdByIds: readonly string[],
): Promise<readonly CreatedTaskObservation[]> {
  if (createdByIds.length === 0) return [];
  let board: TaskBoard;
  try {
    board = (await readBoard(world)).board;
  } catch (error) {
    const failed = { kind: "failed" as const, diagnostic: observationDiagnostic(error) };
    return createdByIds.map(() => failed);
  }
  const rows = projectCreatedByRows(board, createTaskRelations(board), createdByIds);
  return createdByIds.map((createdBy) => ({ kind: "present", rows: rows.get(createdBy) ?? [] }));
}
