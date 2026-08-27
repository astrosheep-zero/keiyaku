import { createTaskRelations, projectRows, type TaskRow } from "./board.js";
import { isTaskSegment, parseTaskId } from "./identity.js";
import { readBoard } from "./store.js";
import type { WorldRoot } from "../world.js";

export function parseTaskNamespaceSelector(value: string): readonly string[] {
  if (value === "task/") return [];
  if (!value.startsWith("task/") || !value.endsWith("/")) {
    throw new TypeError(`invalid Task namespace selector: ${value}`);
  }
  const body = value.slice("task/".length, -1);
  const segments = body.split("/");
  if (body.length === 0 || !segments.every(isTaskSegment)) {
    throw new TypeError(`invalid Task namespace selector: ${value}`);
  }
  return parseTaskId(`task/${body}/placeholder`).namespace;
}

export async function observeTaskCatalogRows(
  world: WorldRoot,
  namespace?: readonly string[],
): Promise<readonly TaskRow[]> {
  if (namespace !== undefined && !namespace.every(isTaskSegment)) {
    throw new TypeError("namespace must contain canonical segments");
  }
  const board = (await readBoard(world)).board;
  return projectRows(board, createTaskRelations(board), namespace ?? null, "all");
}
