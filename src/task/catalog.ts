import type { BoundedList } from "../bounded-list.js";
import type { TaskRef, TaskRow } from "./board.js";
import type { TaskDocument } from "./document.js";
import { isTaskSegment, parseTaskId, type TaskId } from "./identity.js";
import { readRecentTaskDocuments, readTaskDocument } from "./store.js";
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

function terminal(task: TaskDocument | undefined): boolean {
  return task?.state === "done" || task?.state === "drop";
}

export type RecentTaskStatusRow = TaskRow & Readonly<{ blockers?: readonly TaskRef[] }>;

async function catalogRow(
  world: WorldRoot,
  task: TaskDocument,
  documents: ReadonlyMap<TaskId, TaskDocument>,
): Promise<RecentTaskStatusRow> {
  const needs = await Promise.all(
    task.needs.map(async (id) => documents.get(id) ?? (await readTaskDocument(world, id))),
  );
  const blockers: TaskRef[] = [];
  if (task.state === "open" || task.state === "in_progress") {
    for (const [index, need] of needs.entries()) {
      if (terminal(need)) continue;
      blockers.push({ id: task.needs[index]!, title: need?.title ?? null, state: need?.state ?? "missing" });
    }
  }
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    priority: task.priority,
    disposition:
      task.state === "open" && needs.some((need) => !terminal(need))
        ? "blocked"
        : task.state === "open"
          ? "ready"
          : task.state,
    updatedAt: task.updatedAt,
    bodyPresent: task.body.length > 0,
    ...(blockers.length === 0 ? {} : { blockers }),
  };
}

async function recentTaskStatus(
  world: WorldRoot,
  input: Readonly<{ namespace?: readonly string[]; limit?: number }>,
): Promise<BoundedList<RecentTaskStatusRow>> {
  const { namespace } = input;
  if (namespace !== undefined && !namespace.every(isTaskSegment)) {
    throw new TypeError("namespace must contain canonical segments");
  }
  const documents = await readRecentTaskDocuments(world, {
    ...(namespace === undefined ? {} : { namespace }),
    selection: "active",
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const known = new Map(documents.rows.map((document) => [document.id, document]));
  return {
    rows: await Promise.all(documents.rows.map((document) => catalogRow(world, document, known))),
    hasMore: documents.hasMore,
  };
}

export async function observeRecentTaskStatus(
  world: WorldRoot,
  input: Readonly<{ namespace?: readonly string[]; limit?: number }> = {},
): Promise<BoundedList<RecentTaskStatusRow>> {
  return recentTaskStatus(world, input);
}

export async function observeTaskCatalog(
  world: WorldRoot,
  input: Readonly<{ namespace?: readonly string[]; limit?: number }> = {},
): Promise<BoundedList<TaskRow>> {
  const { namespace } = input;
  if (namespace !== undefined && !namespace.every(isTaskSegment)) {
    throw new TypeError("namespace must contain canonical segments");
  }
  const documents = await readRecentTaskDocuments(world, {
    ...(namespace === undefined ? {} : { namespace }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const known = new Map(documents.rows.map((document) => [document.id, document]));
  return {
    rows: (await Promise.all(documents.rows.map((document) => catalogRow(world, document, known)))).map(
      ({ blockers: _blockers, ...row }) => row,
    ),
    hasMore: documents.hasMore,
  };
}
