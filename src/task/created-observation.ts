import type { WorldRoot } from "../world.js";
import { z } from "zod";
import { taskRowsSchema } from "./board.js";
import { observeTaskBoard } from "./operations.js";

export const createdTaskObservationSchema = z.union([
  z.object({ kind: z.literal("present"), rows: taskRowsSchema }).strict(),
  z.object({ kind: z.literal("failed"), diagnostic: z.string() }).strict(),
]);

export type CreatedTaskObservation = z.infer<typeof createdTaskObservationSchema>;

export const EMPTY_CREATED_TASK_OBSERVATION: CreatedTaskObservation = { kind: "present", rows: [] };

export function parseCreatedTaskObservation(value: unknown): CreatedTaskObservation {
  return createdTaskObservationSchema.parse(value);
}

function observationDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Project Task board rows created by each identity, preserving input order. */
export async function observeCreatedTaskObservations(
  world: WorldRoot,
  createdByIds: readonly string[],
): Promise<readonly CreatedTaskObservation[]> {
  let board;
  try {
    board = await observeTaskBoard(world);
  } catch (error) {
    const failed = { kind: "failed" as const, diagnostic: observationDiagnostic(error) };
    return createdByIds.map(() => failed);
  }
  return createdByIds.map((createdBy) =>
    parseCreatedTaskObservation({ kind: "present", rows: board.selectCreatedBy(createdBy) }),
  );
}
